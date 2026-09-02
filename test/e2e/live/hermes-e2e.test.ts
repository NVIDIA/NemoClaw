// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HERMES_E2E_TEST_TIMEOUT_MS } from "../../../tools/e2e/hermes-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertStockManagedImageReceipt } from "../fixtures/managed-image-receipt.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  assertHermesHasNoRoutingSidecars,
  captureHermesRoutingTopology,
} from "../fixtures/hermes-routing-topology.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  assertSecurityPosture,
  securityPostureEnabled,
  securityPostureModeEnv,
} from "../fixtures/security-posture.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { assertHermesCliAdapterLiveContract } from "./hermes-cli-adapter-live.ts";
import { HERMES_E2E_PHASES } from "./hermes-e2e-phases.ts";
import { assertHermesSkillLifecycle } from "./hermes-skill-lifecycle.ts";
import { expectPackageDatabaseReadOnly } from "./package-database-read-only.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes";
validateSandboxName(SANDBOX_NAME);
const HERMES_HEALTH_URL = "http://localhost:8642/health";
const HERMES_HOST_HEALTH_URL = "http://127.0.0.1:8642/health";
const HERMES_DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789";
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const ONBOARD_VALIDATION_TIMEOUT_SECONDS =
  process.env.NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS ?? "60";

interface OpenAiChoiceLike {
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
  };
  text?: unknown;
  finish_reason?: unknown;
}

interface OpenAiChatLike {
  choices?: OpenAiChoiceLike[];
}

function truthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function hermesDashboardE2eEnabled(): boolean {
  return (
    truthyEnv(process.env.NEMOCLAW_E2E_HERMES_DASHBOARD) ||
    truthyEnv(process.env.NEMOCLAW_HERMES_DASHBOARD)
  );
}

function commandEnv(inferenceEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    ...inferenceEnv,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS: ONBOARD_VALIDATION_TIMEOUT_SECONDS,
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    ...securityPostureModeEnv(),
  };
  if (process.env.NEMOCLAW_E2E_HERMES_DASHBOARD) {
    env.NEMOCLAW_E2E_HERMES_DASHBOARD = process.env.NEMOCLAW_E2E_HERMES_DASHBOARD;
  }
  if (process.env.NEMOCLAW_HERMES_DASHBOARD) {
    env.NEMOCLAW_HERMES_DASHBOARD = process.env.NEMOCLAW_HERMES_DASHBOARD;
  }
  if (process.env.NEMOCLAW_HERMES_DASHBOARD_TUI) {
    env.NEMOCLAW_HERMES_DASHBOARD_TUI = process.env.NEMOCLAW_HERMES_DASHBOARD_TUI;
  }
  if (process.env.NEMOCLAW_DASHBOARD_PORT) {
    env.NEMOCLAW_DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT;
  }
  if (process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT) {
    env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT =
      process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT;
  }
  return env;
}

function chatPayload(model: string, prompt: string, maxTokens = 256): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
  });
}

function chatContent(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const choices = (response as OpenAiChatLike).choices;
  if (!Array.isArray(choices)) return "";
  for (const choice of choices) {
    const message = choice?.message;
    if (message) {
      if (typeof message.content === "string" && message.content.trim()) {
        return message.content.trim();
      }
      if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
        return message.reasoning_content.trim();
      }
    }
    if (typeof choice?.text === "string" && choice.text.trim()) return choice.text.trim();
  }
  return "";
}

function firstChoice(response: unknown): OpenAiChoiceLike | undefined {
  if (!response || typeof response !== "object") return undefined;
  const choices = (response as OpenAiChatLike).choices;
  if (!Array.isArray(choices)) return undefined;
  return choices.find((choice) => choice && typeof choice === "object");
}

/** Report whether a completed response spent its full budget on reasoning. */
function exhaustedReasoningBudget(response: unknown): boolean {
  const content = chatContent(response);
  if (/PONG/i.test(content)) return false;
  const choice = firstChoice(response);
  const message = choice?.message;
  return (
    choice?.finish_reason === "length" &&
    typeof message?.reasoning_content === "string" &&
    message.reasoning_content.trim().length > 0
  );
}

function expectPong(label: string, response: unknown): void {
  const content = chatContent(response);
  expect(
    content,
    `${label} expected PONG; response=${JSON.stringify(response).slice(0, 500)}`,
  ).toMatch(/PONG/i);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function registryEntry(name: string): Record<string, unknown> | undefined {
  const registry = fs.existsSync(REGISTRY_FILE) ? readJsonFile(REGISTRY_FILE) : null;
  const sandboxes =
    registry && typeof registry === "object"
      ? (registry as { sandboxes?: unknown }).sandboxes
      : null;
  const entry =
    sandboxes && typeof sandboxes === "object"
      ? (sandboxes as Record<string, unknown>)[name]
      : null;
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
}

function httpStatusOk(status: string): boolean {
  return /^[23][0-9][0-9]$/.test(status.trim());
}

function parseGatewayProcess(output: string): { owner: string; pid: string; ppid: string } {
  const [owner = "", pid = "", ppid = ""] = output.trim().split(/\s+/);
  expect(owner, `expected gateway process owner, got ${JSON.stringify(output)}`).not.toBe("");
  expect(pid, `expected gateway process pid, got ${JSON.stringify(output)}`).toMatch(/^[0-9]+$/);
  expect(ppid, `expected gateway process parent pid, got ${JSON.stringify(output)}`).toMatch(
    /^[0-9]+$/,
  );
  return { owner, pid, ppid };
}

async function preCleanBestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Pre-cleanup is best-effort because the pre-install path may not have
    // nemoclaw/openshell available yet.
  }
}

async function captureDiagnosticsBestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Failure diagnostics must not mask the install failure.
  }
}

async function postDestroyGatewayBestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // The explicit sandbox-destroy assertion remains the primary phase-7 contract.
  }
}

// source-shape-contract: security -- Live registry absence proves explicit destroy removes the sandbox record without trusting CLI output
test(
  "hermes-e2e: install.sh onboards Hermes and proves health plus live inference",
  {
    timeout: HERMES_E2E_TEST_TIMEOUT_MS,
    meta: { e2ePhases: HERMES_E2E_PHASES },
  },
  async ({ artifacts, cleanup, host, inference, progress, runtimeProvider, sandbox }) => {
    await artifacts.target.declare({
      id: "hermes-e2e",
      boundary: `install.sh --non-interactive --fresh + Hermes sandbox runtime + ${inference.mode} inference adapter`,
      sandboxName: SANDBOX_NAME,
      dashboardEnabled: hermesDashboardE2eEnabled(),
      inferenceMode: inference.mode,
      securityPostureEnabled: securityPostureEnabled(),
    });

    const env = commandEnv(inference.env());
    const redactionValues = inference.redactionValues();
    const expectDashboardReachable = async (artifactName: string): Promise<void> => {
      if (!hermesDashboardE2eEnabled()) return;
      const dashboard = await host.command(
        "curl",
        [
          "-sS",
          "-L",
          "--max-time",
          "10",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          `http://127.0.0.1:${HERMES_DASHBOARD_PORT}/`,
        ],
        {
          artifactName,
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(dashboard.exitCode, resultText(dashboard)).toBe(0);
      expect(httpStatusOk(dashboard.stdout)).toBe(true);
    };

    const cleanupHermes = async (label: string) => {
      await preCleanBestEffort(() =>
        host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: `${label}-nemoclaw-destroy`,
          env: commandEnv(),
          timeoutMs: 120_000,
        }),
      );
      await preCleanBestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: `${label}-openshell-sandbox-delete`,
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
      await preCleanBestEffort(() =>
        sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: `${label}-openshell-gateway-destroy`,
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
    };

    const cleanupEnv = commandEnv();
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: cleanupEnv,
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-sandbox-delete",
        env: cleanupEnv,
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy",
      env: cleanupEnv,
      timeoutMs: 120_000,
    });

    // Phase 1: pre-cleanup and prerequisites, after the secret gate so local
    // skipped runs do not mutate host state.
    progress.phase("prepare clean Hermes runner");
    await cleanupHermes("pre-cleanup");

    // Phase 1: prerequisites.
    await runtimeProvider.requireAvailable({
      artifactName: "phase-1-runtime-info",
      scenarioLabel: "Hermes",
    });

    await expect(inference.probeModels("phase-1-inference-models")).resolves.toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ id: inference.model })]),
    });

    progress.phase("install and onboard Hermes sandbox");
    // Phase 2: real installer + non-interactive Hermes onboard.
    const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
      artifactName: "phase-2-install-hermes",
      cwd: REPO_ROOT,
      env,
      redactionValues,
      timeoutMs: 60 * 60_000,
    });
    await (install.exitCode === 0
      ? Promise.resolve()
      : captureDiagnosticsBestEffort(() =>
          sandbox.execShell(
            SANDBOX_NAME,
            trustedSandboxShellScript(
              String.raw`
                printf '%s\n' '== pid 1 =='
                tr '\0' ' ' </proc/1/cmdline 2>/dev/null || true
                printf '\n%s\n' '== process tree =='
                ps -eo user=,pid=,ppid=,stat=,args= 2>&1 || true
                printf '%s\n' '== entrypoint log =='
                tail -n 300 /tmp/nemoclaw-start.log 2>&1 || true
                printf '%s\n' '== gateway log =='
                tail -n 300 /tmp/gateway.log 2>&1 || true
              `.trim(),
            ),
            {
              artifactName: "phase-2-hermes-startup-failure-diagnostics",
              env: commandEnv(),
              redactionValues,
              timeoutMs: 30_000,
            },
          ),
        ));
    expect(install.exitCode, resultText(install)).toBe(0);
    assertStockManagedImageReceipt({
      environment: env,
      expectedAgent: "hermes",
      sandboxName: SANDBOX_NAME,
    });

    const cliProbe = await host.command(
      "bash",
      ["-lc", "command -v nemoclaw && command -v openshell"],
      {
        artifactName: "phase-2-cli-probe",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(cliProbe.exitCode, resultText(cliProbe)).toBe(0);
    expect(cliProbe.stdout).toContain("nemoclaw");
    expect(cliProbe.stdout).toContain("openshell");

    const help = await host.command("nemoclaw", ["--help"], {
      artifactName: "phase-2-nemoclaw-help",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(help.exitCode, resultText(help)).toBe(0);

    progress.phase("validate sandbox layout, health, and skill activation");
    // Phase 3: sandbox verification.
    const list = await host.command("nemoclaw", ["list"], {
      artifactName: "phase-3-nemoclaw-list",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(list.exitCode, resultText(list)).toBe(0);
    expect(resultText(list)).toContain(SANDBOX_NAME);

    const status = await host.command("nemoclaw", [SANDBOX_NAME, "status"], {
      artifactName: "phase-3-nemoclaw-status",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(status.exitCode, resultText(status)).toBe(0);

    expect(fs.existsSync(SESSION_FILE), `${SESSION_FILE} missing`).toBe(true);
    expect(readJsonFile(SESSION_FILE)).toMatchObject({ agent: "hermes" });

    const inferenceGet = await host.command("nemoclaw", ["inference", "get", "--json"], {
      artifactName: "phase-3-nemoclaw-inference-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(inferenceGet.exitCode, resultText(inferenceGet)).toBe(0);
    const inferenceState = JSON.parse(inferenceGet.stdout) as {
      provider: string | null;
      model: string | null;
    };
    expect(
      inferenceState.provider,
      `expected route provider ${inference.expectedRouteProvider}`,
    ).toBe(inference.expectedRouteProvider);
    expect(inferenceState.model, `expected model ${inference.model}`).toBe(inference.model);

    const policy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
      artifactName: "phase-3-openshell-policy-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(policy.exitCode, resultText(policy)).toBe(0);
    expect(resultText(policy)).toMatch(/network_policies/i);

    await expectPackageDatabaseReadOnly({
      artifactPrefix: "phase-3",
      env: commandEnv(),
      runtimeProvider,
      sandbox,
      sandboxName: SANDBOX_NAME,
      timeoutMs: 30_000,
    });

    const deniedEgress = await sandbox.exec(
      SANDBOX_NAME,
      ["curl", "-fsS", "--connect-timeout", "5", "--max-time", "15", "https://example.com/"],
      {
        artifactName: "phase-3-unintended-egress-denied",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(deniedEgress.exitCode, resultText(deniedEgress)).not.toBe(0);
    expect(resultText(deniedEgress)).toMatch(
      /CONNECT tunnel failed, response 403|The requested URL returned error: 403|policy[_ ]denied|not allowed by any policy/i,
    );

    // Continue Phase 3 with Hermes health and sandbox state.
    let health: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      health = await sandbox.exec(SANDBOX_NAME, ["curl", "-sf", HERMES_HEALTH_URL], {
        artifactName: `phase-3-hermes-health-attempt-${attempt}`,
        env: commandEnv(),
        timeoutMs: 20_000,
      });
      if (health.exitCode === 0 && /"ok"/i.test(resultText(health))) break;
      await sleep(4_000);
    }
    expect(health, "Hermes health probe did not run").toBeTruthy();
    expect(health?.exitCode, health ? resultText(health) : "missing health result").toBe(0);
    expect(resultText(health!)).toMatch(/"ok"/i);

    const hermesVersion = await sandbox.exec(SANDBOX_NAME, ["hermes", "--version"], {
      artifactName: "phase-3-hermes-version",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(hermesVersion.exitCode, resultText(hermesVersion)).toBe(0);
    expect(resultText(hermesVersion)).not.toMatch(/MISSING|not found|No such file/i);

    const configProbe = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "test -f /sandbox/.hermes/config.yaml && test -d /sandbox/.hermes && touch /sandbox/.hermes/test-write && rm -f /sandbox/.hermes/test-write && echo OK",
      ),
      {
        artifactName: "phase-3-hermes-config-state",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(configProbe.exitCode, resultText(configProbe)).toBe(0);
    expect(configProbe.stdout).toContain("OK");

    await assertHermesSkillLifecycle({
      env: commandEnv(),
      host,
      inference,
      redactionValues,
      sandboxName: SANDBOX_NAME,
    });

    await assertHermesCliAdapterLiveContract({
      env: commandEnv(),
      host,
      redactionValues,
      sandbox,
      sandboxName: SANDBOX_NAME,
    });

    if (hermesDashboardE2eEnabled()) {
      const entry = registryEntry(SANDBOX_NAME);
      expect(entry, `registry missing ${SANDBOX_NAME}`).toBeTruthy();
      expect(entry).toMatchObject({
        agent: "hermes",
        dashboardPort: Number(HERMES_DASHBOARD_PORT),
      });
    }
    await expectDashboardReachable("phase-3-dashboard-host-probe");

    progress.phase("restart Hermes gateway and validate supervision");
    // Phase 4: verify restart and recovery across the real sandbox process boundary.
    const gatewayProcessScript = trustedSandboxShellScript(
      [
        "ps -eo user=,pid=,ppid=,args= |",
        String.raw`awk '($4 ~ /(^|\/)(hermes|hermes[.]real|python|python3)$/) && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { print $1 " " $2 " " $3; found = 1; exit } END { exit found ? 0 : 1 }'`,
      ].join(" "),
    );
    const assertNoStandaloneRoutingSidecars = async (
      artifactName: string,
      expectedGatewayPid: number,
    ): Promise<void> => {
      const topology = await captureHermesRoutingTopology({
        artifactName,
        artifacts,
        env: commandEnv(),
        sandbox,
        sandboxName: SANDBOX_NAME,
      });
      assertHermesHasNoRoutingSidecars(topology, expectedGatewayPid);
    };
    const beforeRestartProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
      artifactName: "phase-4-hermes-gateway-process-before-restart",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(beforeRestartProcess.exitCode, resultText(beforeRestartProcess)).toBe(0);
    const beforeGateway = parseGatewayProcess(beforeRestartProcess.stdout);
    const rootSupervisorTopology = beforeGateway.owner === "gateway";
    let recoveredRootGatewayPid: string | undefined;

    if (rootSupervisorTopology) {
      const stopApiForward = await sandbox.openshell(["forward", "stop", "8642", SANDBOX_NAME], {
        artifactName: "phase-4-stop-hermes-api-forward-before-restart",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      expect(stopApiForward.exitCode, resultText(stopApiForward)).toBe(0);

      const restart = await host.command("nemohermes", [SANDBOX_NAME, "gateway", "restart"], {
        artifactName: "phase-4-nemohermes-gateway-restart",
        env: commandEnv(),
        timeoutMs: 180_000,
      });
      expect(restart.exitCode, resultText(restart)).toBe(0);

      const afterRestartProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
        artifactName: "phase-4-hermes-gateway-process-after-restart",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      expect(afterRestartProcess.exitCode, resultText(afterRestartProcess)).toBe(0);
      const afterGateway = parseGatewayProcess(afterRestartProcess.stdout);
      expect(afterGateway.pid).not.toBe(beforeGateway.pid);
      // Deliberately terminate the exact tracked PID instead of invoking
      // `hermes gateway stop`: upstream's graceful command writes a planned-stop
      // marker and can return while a split-UID gateway is still alive. This
      // injects the stronger stopped-process state that recovery must repair.
      const stopGatewayForRecover = await sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(
          [
            "set -eu",
            `pid=${shellQuote(afterGateway.pid)}`,
            'kill -TERM "$pid" 2>/dev/null || true',
            'for _i in 1 2 3 4 5; do state=$(ps -p "$pid" -o stat= 2>/dev/null || true); case "$state" in \'\'|Z*) echo GATEWAY_STOPPED; exit 0 ;; esac; sleep 1; done',
            'kill -KILL "$pid" 2>/dev/null || true',
            'for _i in 1 2 3 4 5; do state=$(ps -p "$pid" -o stat= 2>/dev/null || true); case "$state" in \'\'|Z*) echo GATEWAY_STOPPED; exit 0 ;; esac; sleep 1; done',
            'echo GATEWAY_STOP_FAILED; ps -p "$pid" -o pid,stat,args=; exit 1',
          ].join("; "),
        ),
        {
          artifactName: "phase-4-stop-hermes-gateway-before-recover",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(stopGatewayForRecover.exitCode, resultText(stopGatewayForRecover)).toBe(0);
      expect(stopGatewayForRecover.stdout).toContain("GATEWAY_STOPPED");

      const recoverStoppedGateway = await host.command("nemohermes", [SANDBOX_NAME, "recover"], {
        artifactName: "phase-4-nemohermes-recover-stopped-gateway",
        env: commandEnv(),
        timeoutMs: 180_000,
      });
      expect(recoverStoppedGateway.exitCode, resultText(recoverStoppedGateway)).toBe(0);

      const afterRecoverProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
        artifactName: "phase-4-hermes-gateway-process-after-recover",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      expect(afterRecoverProcess.exitCode, resultText(afterRecoverProcess)).toBe(0);
      const recoveredGateway = parseGatewayProcess(afterRecoverProcess.stdout);
      expect(recoveredGateway.owner).toBe("gateway");
      expect(recoveredGateway.pid).not.toBe(afterGateway.pid);
      await assertNoStandaloneRoutingSidecars(
        "phase-4-hermes-routing-topology-after-root-supervised-recover",
        Number(recoveredGateway.pid),
      );
      recoveredRootGatewayPid = recoveredGateway.pid;
    } else {
      expect(beforeGateway.owner).toBe("sandbox");

      const startupSupervisor = await sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(
          String.raw`ps -eo user=,pid=,ppid=,args= | awk '$1 == "sandbox" && $3 == 1 && ($4 ~ /(^|\/)(bash|nemoclaw-start)$/) && index($0, "nemoclaw-start") { print $1 " " $2 " " $3; found = 1; exit } END { exit found ? 0 : 1 }'`,
        ),
        {
          artifactName: "phase-4-openshell-managed-hermes-supervisor",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(startupSupervisor.exitCode, resultText(startupSupervisor)).toBe(0);
      const supervisor = parseGatewayProcess(startupSupervisor.stdout);
      expect(beforeGateway.ppid).toBe(supervisor.pid);

      const managedEnvBackup = `/tmp/hermes-managed-env-before-${Date.now()}`;
      try {
        const introduceManagedRawSecret = await sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(
            [
              "set -eu",
              `backup=${shellQuote(managedEnvBackup)}`,
              'cp /sandbox/.hermes/.env "$backup"',
              'printf "\\nNEMOCLAW_E2E_SECRET_TOKEN=raw-managed-restart-secret\\n" >> /sandbox/.hermes/.env',
            ].join("; "),
          ),
          {
            artifactName: "phase-4-managed-hermes-introduce-raw-secret",
            env: commandEnv(),
            timeoutMs: 30_000,
          },
        );
        expect(introduceManagedRawSecret.exitCode, resultText(introduceManagedRawSecret)).toBe(0);

        const refuseManagedRawSecret = await host.command(
          "nemohermes",
          [SANDBOX_NAME, "gateway", "restart", "--quiet"],
          {
            artifactName: "phase-4-managed-hermes-refuse-raw-secret-restart",
            env: commandEnv(),
            timeoutMs: 180_000,
          },
        );
        expect(refuseManagedRawSecret.exitCode, resultText(refuseManagedRawSecret)).not.toBe(0);
        expect(resultText(refuseManagedRawSecret)).toMatch(
          /secret.boundary refusal|SECRET_BOUNDARY_REFUSED/i,
        );

        const afterManagedRefusal = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
          artifactName: "phase-4-managed-hermes-gateway-after-boundary-refusal",
          env: commandEnv(),
          timeoutMs: 30_000,
        });
        expect(afterManagedRefusal.exitCode, resultText(afterManagedRefusal)).toBe(0);
        expect(parseGatewayProcess(afterManagedRefusal.stdout).pid).toBe(beforeGateway.pid);
      } finally {
        const restoreManagedEnv = await sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(
            [
              "set -eu",
              `backup=${shellQuote(managedEnvBackup)}`,
              'test ! -f "$backup" || { cat "$backup" > /sandbox/.hermes/.env; rm -f "$backup"; }',
            ].join("; "),
          ),
          {
            artifactName: "phase-4-managed-hermes-restore-env",
            env: commandEnv(),
            timeoutMs: 30_000,
          },
        );
        expect(restoreManagedEnv.exitCode, resultText(restoreManagedEnv)).toBe(0);
      }

      const stopApiForward = await sandbox.openshell(["forward", "stop", "8642", SANDBOX_NAME], {
        artifactName: "phase-4-stop-managed-hermes-api-forward",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      expect(stopApiForward.exitCode, resultText(stopApiForward)).toBe(0);

      const restartManagedGateway = await host.command(
        "nemohermes",
        [SANDBOX_NAME, "gateway", "restart"],
        {
          artifactName: "phase-4-restart-openshell-managed-hermes-gateway",
          env: commandEnv(),
          timeoutMs: 180_000,
        },
      );
      expect(restartManagedGateway.exitCode, resultText(restartManagedGateway)).toBe(0);

      const afterManagedRestart = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
        artifactName: "phase-4-managed-hermes-gateway-after-restart",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      expect(afterManagedRestart.exitCode, resultText(afterManagedRestart)).toBe(0);
      const restartedManagedGateway = parseGatewayProcess(afterManagedRestart.stdout);
      expect(restartedManagedGateway.pid).not.toBe(beforeGateway.pid);
      const stopGateway = await sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(
          [
            "set -eu",
            `pid=${shellQuote(restartedManagedGateway.pid)}`,
            'kill -TERM "$pid"',
            'for _i in 1 2 3 4 5; do state=$(ps -p "$pid" -o stat= 2>/dev/null || true); case "$state" in \'\'|Z*) echo GATEWAY_STOPPED; exit 0 ;; esac; sleep 1; done',
            "echo GATEWAY_STOP_FAILED >&2; exit 1",
          ].join("; "),
        ),
        {
          artifactName: "phase-4-stop-managed-hermes-gateway",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(stopGateway.exitCode, resultText(stopGateway)).toBe(0);
      expect(stopGateway.stdout).toContain("GATEWAY_STOPPED");

      const recoverManagedGateway = await host.command("nemohermes", [SANDBOX_NAME, "recover"], {
        artifactName: "phase-4-recover-openshell-managed-hermes-gateway",
        env: commandEnv(),
        timeoutMs: 180_000,
      });
      expect(recoverManagedGateway.exitCode, resultText(recoverManagedGateway)).toBe(0);

      const afterRecoverProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
        artifactName: "phase-4-managed-hermes-gateway-after-recover",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      expect(afterRecoverProcess.exitCode, resultText(afterRecoverProcess)).toBe(0);
      const recoveredGateway = parseGatewayProcess(afterRecoverProcess.stdout);
      expect(recoveredGateway.owner).toBe("sandbox");
      expect(recoveredGateway.ppid).toBe(supervisor.pid);
      expect(recoveredGateway.pid).not.toBe(restartedManagedGateway.pid);
      await assertNoStandaloneRoutingSidecars(
        "phase-4-hermes-routing-topology-after-managed-recover",
        Number(recoveredGateway.pid),
      );
    }

    const recoveredHealth = await host.command(
      "curl",
      ["-sf", "--max-time", "10", HERMES_HOST_HEALTH_URL],
      {
        artifactName: "phase-4-hermes-host-health-after-recover",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(recoveredHealth.exitCode, resultText(recoveredHealth)).toBe(0);
    expect(resultText(recoveredHealth)).toMatch(/"ok"/i);
    await expectDashboardReachable("phase-4-dashboard-host-after-recover");

    // OpenClaw launch qualification now reads its structured JSONL session
    // store. Hermes owns a different SQLite contract, so this target must not
    // infer Hermes replies from terminal copy through the OpenClaw helper.
    progress.phase("exercise hosted and inference.local routes");
    // Phase 5: live inference through both the external provider and the
    // sandbox's inference.local route.
    const directChat = await inference.directChat("Reply with exactly one word: PONG", {
      artifactName: "phase-5-direct-inference-chat",
      maxTokens: 1024,
    });
    expect(exhaustedReasoningBudget(directChat)).toBe(false);
    expectPong(`${inference.mode} direct chat`, directChat);

    const sandboxChat = await sandbox.exec(
      SANDBOX_NAME,
      [
        "curl",
        "-fsS",
        "--max-time",
        "90",
        "-H",
        "Content-Type: application/json",
        "--data-raw",
        chatPayload(inference.model, "Reply with exactly one word: PONG", 1024),
        "https://inference.local/v1/chat/completions",
      ],
      {
        artifactName: "phase-5-inference-local-chat",
        env: commandEnv(),
        timeoutMs: 120_000,
      },
    );
    expect(sandboxChat.exitCode, resultText(sandboxChat)).toBe(0);
    const sandboxChatJson = JSON.parse(sandboxChat.stdout) as unknown;
    expect(exhaustedReasoningBudget(sandboxChatJson)).toBe(false);
    expectPong("Hermes sandbox inference.local chat", sandboxChatJson);

    progress.phase("read logs and, under root supervision, validate locked configuration");
    // Phase 6: host CLI diagnostics and root-supervised configuration integrity.
    const logs = await host.command("nemoclaw", [SANDBOX_NAME, "logs"], {
      artifactName: "phase-6-nemoclaw-logs",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(logs.exitCode, resultText(logs)).toBe(0);
    expect(resultText(logs).trim().length).toBeGreaterThan(0);

    if (rootSupervisorTopology) {
      expect(recoveredRootGatewayPid).toBeDefined();

      // Root-supervised Hermes has a separate locked-configuration boundary.
      // Keep one live refusal proof in the topology that owns that behavior.
      const shieldsUp = await host.command("nemohermes", [SANDBOX_NAME, "shields", "up"], {
        artifactName: "phase-6-nemohermes-shields-up",
        env: commandEnv(),
        timeoutMs: 120_000,
      });
      expect(shieldsUp.exitCode, resultText(shieldsUp)).toBe(0);

      try {
        const introduceLockedDrift = await sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(
            [
              "set -eu",
              'for path in /sandbox/.hermes /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash; do chattr -i "$path" 2>/dev/null || true; done',
              "chmod u+w /sandbox/.hermes/.env",
              'printf "\\nNEMOCLAW_E2E_LOCKED_DRIFT_MARKER=1\\n" >> /sandbox/.hermes/.env',
              "chown root:root /sandbox/.hermes /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash",
              "chmod 755 /sandbox/.hermes",
              "chmod 444 /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash",
            ].join("; "),
          ),
          {
            artifactName: "phase-6-introduce-locked-hermes-configuration-drift",
            env: commandEnv(),
            timeoutMs: 30_000,
          },
        );
        expect(introduceLockedDrift.exitCode, resultText(introduceLockedDrift)).toBe(0);

        const refuseLockedDrift = await host.command(
          "nemohermes",
          [SANDBOX_NAME, "gateway", "restart", "--quiet"],
          {
            artifactName: "phase-6-refuse-locked-hermes-configuration-drift",
            env: commandEnv(),
            timeoutMs: 180_000,
          },
        );
        expect(refuseLockedDrift.exitCode, resultText(refuseLockedDrift)).not.toBe(0);
        expect(resultText(refuseLockedDrift)).toMatch(
          /config hash mismatch|GATEWAY_CONFIG_HASH_MISMATCH/,
        );

        const afterLockedRefusal = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
          artifactName: "phase-6-hermes-gateway-after-locked-configuration-refusal",
          env: commandEnv(),
          timeoutMs: 30_000,
        });
        expect(afterLockedRefusal.exitCode, resultText(afterLockedRefusal)).toBe(0);
        expect(parseGatewayProcess(afterLockedRefusal.stdout).pid).toBe(recoveredRootGatewayPid);
      } finally {
        const restoreLockedConfiguration = await sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(
            [
              "set -eu",
              'for path in /sandbox/.hermes /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash; do chattr -i "$path" 2>/dev/null || true; done',
              "chmod u+w /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash",
              'python3 -c \'from pathlib import Path; p=Path("/sandbox/.hermes/.env"); lines=[line for line in p.read_text(encoding="utf-8").splitlines() if not line.startswith("NEMOCLAW_E2E_LOCKED_DRIFT_MARKER=")]; p.write_text("\\n".join(lines).rstrip()+"\\n", encoding="utf-8")\'',
              "sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env > /etc/nemoclaw/hermes.config-hash",
              "sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env > /sandbox/.hermes/.config-hash",
              "chown root:root /sandbox/.hermes /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash",
              "chmod 755 /sandbox/.hermes",
              "chmod 444 /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash",
              'for path in /sandbox/.hermes /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash; do chattr +i "$path" 2>/dev/null || true; done',
            ].join("; "),
          ),
          {
            artifactName: "phase-6-restore-locked-hermes-configuration",
            env: commandEnv(),
            timeoutMs: 30_000,
          },
        );
        expect(restoreLockedConfiguration.exitCode, resultText(restoreLockedConfiguration)).toBe(0);
      }
    }

    const securityPosture = securityPostureEnabled()
      ? await assertSecurityPosture(host, sandbox, SANDBOX_NAME, "hermes")
      : null;

    // Phase 7: explicit cleanup and post-destroy registry proof.
    progress.phase("finalize Hermes sandbox resources");
    if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1") {
      const destroy = await host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "phase-7-nemoclaw-destroy",
        env: commandEnv(),
        timeoutMs: 120_000,
      });
      expect(destroy.exitCode, resultText(destroy)).toBe(0);
      await postDestroyGatewayBestEffort(() =>
        sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: "phase-7-openshell-gateway-destroy",
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
      expect(
        registryEntry(SANDBOX_NAME),
        `${SANDBOX_NAME} still in ${REGISTRY_FILE}`,
      ).toBeUndefined();
    }

    await artifacts.target.complete({
      id: "hermes-e2e",
      assertions: {
        installShNonInteractiveHermes: true,
        sandboxListedAndHealthy: true,
        directProviderInferencePong: true,
        sandboxInferenceLocalPong: true,
        hermesSkillInstalled: true,
        hermesSkillDiscovered: true,
        hermesSkillUsedInFreshSession: true,
        standaloneRoutingSidecarsAbsentAfterRecovery: true,
        dashboardChecked: hermesDashboardE2eEnabled(),
        securityPostureChecked: securityPosture !== null,
      },
      securityPosture,
    });
  },
);
