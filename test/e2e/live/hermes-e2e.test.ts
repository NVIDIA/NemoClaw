// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import { trustedProviderEndpoint } from "../fixtures/clients/provider.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { exportHermesSession, hermesLastActive } from "../fixtures/hermes-session.ts";
import {
  DEFAULT_HOSTED_INFERENCE_MODEL,
  requireHostedInferenceConfig,
} from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  assertSecurityPosture,
  securityPostureEnabled,
  securityPostureModeEnv,
} from "../fixtures/security-posture.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes";
validateSandboxName(SANDBOX_NAME);
const HERMES_HEALTH_URL = "http://localhost:8642/health";
const HERMES_HOST_HEALTH_URL = "http://127.0.0.1:8642/health";
const HERMES_DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789";
const HERMES_DASHBOARD_INTERNAL_PORT =
  process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ?? "19119";
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const LIVE_TIMEOUT_MS = 70 * 60_000;
const CHAT_MODEL = process.env.NEMOCLAW_MODEL ?? DEFAULT_HOSTED_INFERENCE_MODEL;
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

function commandEnv(hostedEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    ...hostedEnv,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_MODEL: hostedEnv.NEMOCLAW_MODEL ?? CHAT_MODEL,
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

function shouldRetryForReasoningBudget(response: unknown): boolean {
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

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g, "");
}

function hermesSessionIds(output: string): Set<string> {
  return new Set(output.match(/\b[0-9]{8}_[0-9]{6}_[a-zA-Z0-9]+\b/g) ?? []);
}

function onlyNewHermesSessionId(before: Set<string>, after: Set<string>): string {
  const created = [...after].filter((id) => !before.has(id));
  expect(created).toHaveLength(1);
  return created[0];
}

function forwardListHasRunningPort(output: string, sandboxName: string, port: string): boolean {
  return output
    .split("\n")
    .map(stripAnsi)
    .some((line) => {
      const parts = line.trim().split(/\s+/);
      return (
        parts.length >= 5 &&
        parts[0] === sandboxName &&
        parts[2] === port &&
        ["running", "active"].includes(parts.at(-1)?.toLowerCase() ?? "")
      );
    });
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

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup is best-effort because the pre-install path may not have
    // nemoclaw/openshell available yet.
  }
}

async function retryHostedInference<T>(
  label: string,
  run: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(5_000 * attempt);
    }
  }
  throw new Error(
    `${label} failed after retries: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

test("hermes-e2e: install.sh onboards Hermes and proves health plus live inference", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, provider, sandbox, secrets }) => {
  const hosted = requireHostedInferenceConfig(secrets);
  const apiKey = hosted.apiKey;

  await artifacts.target.declare({
    id: "hermes-e2e",
    boundary: "install.sh --non-interactive --fresh + Hermes sandbox runtime",
    sandboxName: SANDBOX_NAME,
    dashboardEnabled: hermesDashboardE2eEnabled(),
    securityPostureEnabled: securityPostureEnabled(),
  });

  const env = commandEnv(hosted.env);
  const redactionValues = [apiKey];

  const cleanupHermes = async (label: string) => {
    await bestEffort(() =>
      host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: `${label}-nemoclaw-destroy`,
        env: commandEnv(),
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: `${label}-openshell-sandbox-delete`,
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: `${label}-openshell-gateway-destroy`,
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
  };

  cleanup.add(`destroy Hermes sandbox ${SANDBOX_NAME}`, async () => {
    await cleanupHermes("cleanup");
  });

  // Phase 0: pre-cleanup, after the secret gate so local skipped runs do not
  // mutate host state.
  await cleanupHermes("pre-cleanup");

  // Phase 1: prerequisites.
  const dockerInfo = await host.command("docker", ["info"], {
    artifactName: "phase-1-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(dockerInfo.exitCode, resultText(dockerInfo)).toBe(0);

  expect(fs.existsSync(path.join(REPO_ROOT, "agents", "hermes", "manifest.yaml"))).toBe(true);

  const providerReachability = await provider.probeReachability(
    trustedProviderEndpoint(hosted.endpointUrl, { allowedHosts: ["inference-api.nvidia.com"] }),
    {
      artifactName: "phase-1-inference-reachability",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: 30_000,
    },
  );
  const reachabilityStatus = providerReachability.stdout.trim();
  expect(providerReachability.exitCode, resultText(providerReachability)).toBe(0);
  expect(["000", "401", "403"], resultText(providerReachability)).not.toContain(reachabilityStatus);
  expect(Number(reachabilityStatus), resultText(providerReachability)).toBeLessThan(500);

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
    : bestEffort(() =>
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

  if (hermesDashboardE2eEnabled()) {
    expect(resultText(install)).toContain(
      "Deployment verified — gateway and dashboard are healthy.",
    );
    expect(resultText(install)).toContain("Hermes Agent Dashboard");
    expect(resultText(install)).toContain(`http://127.0.0.1:${HERMES_DASHBOARD_PORT}/`);
  }

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

  const inference = await sandbox.openshell(["inference", "get"], {
    artifactName: "phase-3-openshell-inference-get",
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(inference.exitCode, resultText(inference)).toBe(0);
  expect(resultText(inference)).toContain(hosted.providerName);

  const policy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
    artifactName: "phase-3-openshell-policy-get",
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(policy.exitCode, resultText(policy)).toBe(0);
  expect(resultText(policy)).toMatch(/network_policies/i);

  // Phase 4: Hermes health and sandbox state.
  let health: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    health = await sandbox.exec(SANDBOX_NAME, ["curl", "-sf", HERMES_HEALTH_URL], {
      artifactName: `phase-4-hermes-health-attempt-${attempt}`,
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
    artifactName: "phase-4-hermes-version",
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
      artifactName: "phase-4-hermes-config-state",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(configProbe.exitCode, resultText(configProbe)).toBe(0);
  expect(configProbe.stdout).toContain("OK");

  const runHermesCli = async (args: string[], artifactName: string, timeoutMs = 6 * 60_000) => {
    const result = await sandbox.exec(SANDBOX_NAME, ["hermes", ...args], {
      artifactName,
      env: commandEnv(),
      redactionValues,
      timeoutMs,
    });
    expect(result.exitCode, resultText(result)).toBe(0);
    return resultText(result);
  };
  const listHermesSessionsText = (artifactName: string) =>
    runHermesCli(["sessions", "list"], artifactName, 60_000);
  const listHermesSessions = async (artifactName: string) =>
    hermesSessionIds(await listHermesSessionsText(artifactName));
  const sessionLastActive = (id: string, artifactName: string) =>
    hermesLastActive(sandbox, SANDBOX_NAME, id, artifactName);
  const expectNoNewHermesSessions = async (
    before: Set<string>,
    beforeActivityArtifact: string,
    expectedSessionId: string,
    expectedRowToken: string,
    args: string[],
    runArtifact: string,
    afterArtifact: string,
  ) => {
    const beforeActivity = await sessionLastActive(expectedSessionId, beforeActivityArtifact);
    await runHermesCli(args, runArtifact);
    const afterText = await listHermesSessionsText(afterArtifact);
    const after = hermesSessionIds(afterText);
    expect([...after].filter((id) => !before.has(id))).toEqual([]);
    expect(after.has(expectedSessionId), stripAnsi(afterText)).toBe(true);
    const row = stripAnsi(afterText)
      .split("\n")
      .find((line) => line.includes(expectedSessionId));
    expect(row, stripAnsi(afterText)).toContain(expectedRowToken);
    expect(await sessionLastActive(expectedSessionId, `${afterArtifact}-metadata`)).toBeGreaterThan(
      beforeActivity,
    );
  };

  const issue5254Marker = `NEMOCLAW_5254_${Date.now()}`;
  const beforeSeedSessions = await listHermesSessions("phase-4-issue-5254-sessions-before-seed");
  const seedPrompt = `Remember this exact token: ${issue5254Marker}. Reply with acknowledged.`;
  await runHermesCli(["-z", seedPrompt], "phase-4-issue-5254-seed-oneshot");
  const seedSessionId = onlyNewHermesSessionId(
    beforeSeedSessions,
    await listHermesSessions("phase-4-issue-5254-sessions-after-seed"),
  );
  const resumePrompt = `N5254_${Date.now().toString(36)}_RESUME`;
  await expectNoNewHermesSessions(
    await listHermesSessions("phase-4-issue-5254-sessions-before-resume"),
    "phase-4-issue-5254-session-before-resume-metadata",
    seedSessionId,
    resumePrompt,
    ["--resume", seedSessionId, "-z", resumePrompt, "--pass-session-id", "--ignore-rules"],
    "phase-4-issue-5254-resume-oneshot",
    "phase-4-issue-5254-sessions-after-resume",
  );
  const continuePrompt = `N5254_${Date.now().toString(36)}_CONTINUE`;
  await expectNoNewHermesSessions(
    await listHermesSessions("phase-4-issue-5254-sessions-before-continue"),
    "phase-4-issue-5254-session-before-continue-metadata",
    seedSessionId,
    continuePrompt,
    ["-c", seedSessionId, "-z", continuePrompt],
    "phase-4-issue-5254-continue-oneshot",
    "phase-4-issue-5254-sessions-after-continue",
  );
  const exportPath = `/tmp/nemoclaw-issue-5254-${issue5254Marker}.jsonl`;
  await exportHermesSession(
    sandbox,
    SANDBOX_NAME,
    seedSessionId,
    exportPath,
    [seedPrompt, resumePrompt, continuePrompt],
    {
      artifactName: "phase-4-issue-5254-export-session",
      env: commandEnv(),
      redactionValues,
      timeoutMs: 60_000,
    },
  );

  if (hermesDashboardE2eEnabled()) {
    const entry = registryEntry(SANDBOX_NAME);
    expect(entry, `registry missing ${SANDBOX_NAME}`).toBeTruthy();
    expect(entry).toMatchObject({
      agent: "hermes",
      dashboardPort: Number(HERMES_DASHBOARD_PORT),
    });

    const forwardList = await sandbox.openshell(["forward", "list"], {
      artifactName: "phase-4-dashboard-forward-list",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(forwardList.exitCode, resultText(forwardList)).toBe(0);
    expect(forwardListHasRunningPort(forwardList.stdout, SANDBOX_NAME, "8642")).toBe(true);
    expect(forwardListHasRunningPort(forwardList.stdout, SANDBOX_NAME, HERMES_DASHBOARD_PORT)).toBe(
      true,
    );

    const hostDashboard = await host.command(
      "curl",
      [
        "-sS",
        "-L",
        "--max-time",
        "10",
        "-o",
        "/tmp/hermes-dashboard-vitest-body",
        "-w",
        "%{http_code}",
        `http://127.0.0.1:${HERMES_DASHBOARD_PORT}/`,
      ],
      {
        artifactName: "phase-4-dashboard-host-probe",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(hostDashboard.exitCode, resultText(hostDashboard)).toBe(0);
    expect(httpStatusOk(hostDashboard.stdout)).toBe(true);

    const hostHealth = await host.command(
      "curl",
      ["-sf", "--max-time", "10", HERMES_HOST_HEALTH_URL],
      {
        artifactName: "phase-4-hermes-host-health",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(hostHealth.exitCode, resultText(hostHealth)).toBe(0);
    expect(resultText(hostHealth)).toMatch(/"ok"/i);

    const dashboardInternal = await sandbox.exec(
      SANDBOX_NAME,
      [
        "curl",
        "-sS",
        "-L",
        "--max-time",
        "10",
        "-o",
        "/tmp/hermes-dashboard-vitest-body",
        "-w",
        "%{http_code}",
        `http://127.0.0.1:${HERMES_DASHBOARD_INTERNAL_PORT}/`,
      ],
      {
        artifactName: "phase-4-dashboard-sandbox-probe",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(dashboardInternal.exitCode, resultText(dashboardInternal)).toBe(0);
    expect(httpStatusOk(dashboardInternal.stdout)).toBe(true);
  }

  // Phase 5: host-mediated Hermes gateway restart. This validates the
  // runtime contract behind #2426 against a real OpenShell/Hermes sandbox:
  // The installed supervision tree controls the gateway process, direct
  // sandbox config drift is refused rather than adopted, the public bridges
  // and dashboard process recover together, and both PID 1 and the startup
  // supervisor remain stable throughout.
  const gatewayProcessScript = trustedSandboxShellScript(
    [
      "ps -eo user=,pid=,ppid=,args= |",
      String.raw`awk '($4 ~ /(^|\/)(hermes|hermes[.]real|python|python3)$/) && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { print $1 " " $2 " " $3; found = 1; exit } END { exit found ? 0 : 1 }'`,
    ].join(" "),
  );
  const beforeRestartProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
    artifactName: "phase-5-hermes-gateway-process-before-restart",
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(beforeRestartProcess.exitCode, resultText(beforeRestartProcess)).toBe(0);
  const beforeGateway = parseGatewayProcess(beforeRestartProcess.stdout);
  const rootSupervisorTopology = beforeGateway.owner === "gateway";
  let recoveredGateway: ReturnType<typeof parseGatewayProcess>;

  const pid1IdentityScript = trustedSandboxShellScript(
    String.raw`python3 -c 'from pathlib import Path; text=Path("/proc/1/stat").read_text(); tail=text.rsplit(")", 1)[1].split(); cmd=Path("/proc/1/cmdline").read_bytes().replace(b"\0", b" ").decode(); print("1 " + tail[19] + " " + cmd)'`,
  );
  const beforePid1 = await sandbox.execShell(SANDBOX_NAME, pid1IdentityScript, {
    artifactName: "phase-5-pid1-before-restart",
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(beforePid1.exitCode, resultText(beforePid1)).toBe(0);

  if (rootSupervisorTopology) {
    expect(beforeGateway.owner).toBe("gateway");

    const envMarker = `issue_2426_${Date.now()}`;
    const envBackup = `/tmp/hermes-e2e-env-before-${Date.now()}`;
    const mutateEnv = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `marker=${shellQuote(envMarker)}`,
          `backup=${shellQuote(envBackup)}`,
          "command -v gosu >/dev/null 2>&1",
          'gosu sandbox cp /sandbox/.hermes/.env "$backup"',
          'gosu sandbox sh -lc \'printf "\\nNEMOCLAW_E2E_RESTART_MARKER=%s\\n" "$1" >> /sandbox/.hermes/.env\' sh "$marker"',
        ].join("; "),
      ),
      {
        artifactName: "phase-5-mutate-hermes-env-as-sandbox-user",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(mutateEnv.exitCode, resultText(mutateEnv)).toBe(0);

    const refuseMutableDrift = await host.command(
      "nemohermes",
      [SANDBOX_NAME, "gateway", "restart", "--quiet"],
      {
        artifactName: "phase-5-refuse-untrusted-hermes-env-drift",
        env: commandEnv(),
        timeoutMs: 180_000,
      },
    );
    expect(refuseMutableDrift.exitCode, resultText(refuseMutableDrift)).not.toBe(0);
    expect(resultText(refuseMutableDrift)).toMatch(
      /config hash mismatch|GATEWAY_CONFIG_HASH_MISMATCH/,
    );

    const afterMutableRefusalProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
      artifactName: "phase-5-hermes-gateway-after-mutable-drift-refusal",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterMutableRefusalProcess.exitCode, resultText(afterMutableRefusalProcess)).toBe(0);
    expect(parseGatewayProcess(afterMutableRefusalProcess.stdout).pid).toBe(beforeGateway.pid);

    const restoreMutableEnv = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `backup=${shellQuote(envBackup)}`,
          'gosu sandbox sh -c \'cat "$1" > /sandbox/.hermes/.env && rm -f "$1"\' sh "$backup"',
          "sha256sum -c /etc/nemoclaw/hermes.config-hash --status",
          "echo ENV_RESTORED",
        ].join("; "),
      ),
      {
        artifactName: "phase-5-restore-hermes-env-after-refusal",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(restoreMutableEnv.exitCode, resultText(restoreMutableEnv)).toBe(0);
    expect(restoreMutableEnv.stdout).toContain("ENV_RESTORED");

    const stopApiForward = await sandbox.openshell(["forward", "stop", "8642", SANDBOX_NAME], {
      artifactName: "phase-5-stop-hermes-api-forward-before-restart",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(stopApiForward.exitCode, resultText(stopApiForward)).toBe(0);

    const restart = await host.command("nemohermes", [SANDBOX_NAME, "gateway", "restart"], {
      artifactName: "phase-5-nemohermes-gateway-restart",
      env: commandEnv(),
      timeoutMs: 180_000,
    });
    expect(restart.exitCode, resultText(restart)).toBe(0);
    expect(resultText(restart)).toContain("Gateway restarted");
    expect(resultText(restart)).toContain("health passed");
    expect(resultText(restart)).toContain("forwards checked/recovered");

    const afterRestartProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
      artifactName: "phase-5-hermes-gateway-process-after-restart",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterRestartProcess.exitCode, resultText(afterRestartProcess)).toBe(0);
    const afterGateway = parseGatewayProcess(afterRestartProcess.stdout);
    expect(afterGateway.owner).toBe("gateway");
    expect(afterGateway.pid).not.toBe(beforeGateway.pid);

    const afterRestartPid1 = await sandbox.execShell(SANDBOX_NAME, pid1IdentityScript, {
      artifactName: "phase-5-pid1-after-restart",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterRestartPid1.exitCode, resultText(afterRestartPid1)).toBe(0);
    expect(afterRestartPid1.stdout.trim()).toBe(beforePid1.stdout.trim());

    const restartHashCheck = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "sha256sum -c /etc/nemoclaw/hermes.config-hash --status && sha256sum -c /sandbox/.hermes/.config-hash --status && echo OK",
      ),
      {
        artifactName: "phase-5-hermes-config-hashes-after-restart",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(restartHashCheck.exitCode, resultText(restartHashCheck)).toBe(0);
    expect(restartHashCheck.stdout).toContain("OK");

    const restartHostHealth = await host.command(
      "curl",
      ["-sf", "--max-time", "10", HERMES_HOST_HEALTH_URL],
      {
        artifactName: "phase-5-hermes-host-health-after-restart",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(restartHostHealth.exitCode, resultText(restartHostHealth)).toBe(0);
    expect(resultText(restartHostHealth)).toMatch(/"ok"/i);

    const restartForwardList = await sandbox.openshell(["forward", "list"], {
      artifactName: "phase-5-forward-list-after-restart",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(restartForwardList.exitCode, resultText(restartForwardList)).toBe(0);
    expect(forwardListHasRunningPort(restartForwardList.stdout, SANDBOX_NAME, "8642")).toBe(true);
    for (const dashboardPort of hermesDashboardE2eEnabled() ? [HERMES_DASHBOARD_PORT] : []) {
      expect(
        forwardListHasRunningPort(restartForwardList.stdout, SANDBOX_NAME, dashboardPort),
      ).toBe(true);
    }

    // Regression precondition for #5253: Hermes deliberately uses a Python
    // gateway, so its proxy-env and gateway process do not carry OpenClaw's
    // Node safety-net/ciao preloads. The old generic recovery path treated
    // this valid state as unsafe and refused to relaunch Hermes.
    const issue5253Precondition = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `pid=${shellQuote(afterGateway.pid)}`,
          "test -f /tmp/nemoclaw-proxy-env.sh",
          "! grep -Eq 'NODE_OPTIONS|nemoclaw-sandbox-safety-net|nemoclaw-ciao-network-guard' /tmp/nemoclaw-proxy-env.sh",
          `python3 -c 'from pathlib import Path; import sys; env=Path("/proc/" + sys.argv[1] + "/environ").read_bytes(); sys.exit(1 if b"nemoclaw-sandbox-safety-net" in env or b"nemoclaw-ciao-network-guard" in env else 0)' "$pid"`,
          "echo ISSUE_5253_PRECONDITION_OK",
        ].join("; "),
      ),
      {
        artifactName: "phase-5-issue-5253-missing-node-guards-precondition",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(issue5253Precondition.exitCode, resultText(issue5253Precondition)).toBe(0);
    expect(issue5253Precondition.stdout).toContain("ISSUE_5253_PRECONDITION_OK");

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
        artifactName: "phase-5-stop-hermes-gateway-before-recover",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(stopGatewayForRecover.exitCode, resultText(stopGatewayForRecover)).toBe(0);
    expect(stopGatewayForRecover.stdout).toContain("GATEWAY_STOPPED");

    const stopHermesAuxiliaries = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `dashboard_public=${shellQuote(HERMES_DASHBOARD_PORT)}`,
          `dashboard_internal=${shellQuote(HERMES_DASHBOARD_INTERNAL_PORT)}`,
          'pids=$(ps -eo pid=,comm=,args= | awk -v dp="$dashboard_public" -v di="$dashboard_internal" \'($2 == "socat" && (index($0, "TCP-LISTEN:8642") || index($0, "TCP-LISTEN:" dp))) || ($2 ~ /^(hermes|hermes[.]real|python|python3)$/ && index($0, "hermes dashboard") && index($0, "--port " di)) { print $1 }\')',
          "set -- $pids",
          '[ "$#" -ge 3 ] || { echo "EXPECTED_AT_LEAST_3_AUXILIARIES, found $#" >&2; ps -eo pid,comm,args; exit 1; }',
          'for pid in "$@"; do kill -TERM "$pid" 2>/dev/null || true; done',
          "sleep 2",
          'for pid in "$@"; do kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true; done',
          'echo "AUXILIARIES_STOPPED=$#"',
        ].join("; "),
      ),
      {
        artifactName: "phase-5-stop-hermes-auxiliaries-before-recover",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(stopHermesAuxiliaries.exitCode, resultText(stopHermesAuxiliaries)).toBe(0);
    expect(stopHermesAuxiliaries.stdout).toMatch(/AUXILIARIES_STOPPED=[3-9]/);

    const recoverStoppedGateway = await host.command("nemohermes", [SANDBOX_NAME, "recover"], {
      artifactName: "phase-5-nemohermes-recover-stopped-gateway",
      env: commandEnv(),
      timeoutMs: 180_000,
    });
    expect(recoverStoppedGateway.exitCode, resultText(recoverStoppedGateway)).toBe(0);

    const afterRecoverProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
      artifactName: "phase-5-hermes-gateway-process-after-recover",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterRecoverProcess.exitCode, resultText(afterRecoverProcess)).toBe(0);
    recoveredGateway = parseGatewayProcess(afterRecoverProcess.stdout);
    expect(recoveredGateway.owner).toBe("gateway");
    expect(recoveredGateway.pid).not.toBe(afterGateway.pid);

    const recoveredIssue5253Env = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `pid=${shellQuote(recoveredGateway.pid)}`,
          `python3 -c 'from pathlib import Path; import sys; entries=Path("/proc/" + sys.argv[1] + "/environ").read_bytes().split(b"\\0"); env=dict(item.split(b"=", 1) for item in entries if b"=" in item); node_options=env.get(b"NODE_OPTIONS", b""); ok=env.get(b"HERMES_HOME") == b"/sandbox/.hermes" and env.get(b"HTTP_PROXY", b"").startswith(b"http://") and b"nemoclaw-sandbox-safety-net" not in node_options and b"nemoclaw-ciao-network-guard" not in node_options; sys.exit(0 if ok else 1)' "$pid"`,
          "echo ISSUE_5253_RECOVERED_ENV_OK",
        ].join("; "),
      ),
      {
        artifactName: "phase-5-issue-5253-recovered-gateway-environment",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(recoveredIssue5253Env.exitCode, resultText(recoveredIssue5253Env)).toBe(0);
    expect(recoveredIssue5253Env.stdout).toContain("ISSUE_5253_RECOVERED_ENV_OK");

    const afterRecoverPid1 = await sandbox.execShell(SANDBOX_NAME, pid1IdentityScript, {
      artifactName: "phase-5-pid1-after-both-down-recover",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterRecoverPid1.exitCode, resultText(afterRecoverPid1)).toBe(0);
    expect(afterRecoverPid1.stdout.trim()).toBe(beforePid1.stdout.trim());

    const recoverHostHealth = await host.command(
      "curl",
      ["-sf", "--max-time", "10", HERMES_HOST_HEALTH_URL],
      {
        artifactName: "phase-5-hermes-host-health-after-recover",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(recoverHostHealth.exitCode, resultText(recoverHostHealth)).toBe(0);
    expect(resultText(recoverHostHealth)).toMatch(/"ok"/i);

    const afterBothDownForwardList = await sandbox.openshell(["forward", "list"], {
      artifactName: "phase-5-forward-list-after-both-down-recover",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterBothDownForwardList.exitCode, resultText(afterBothDownForwardList)).toBe(0);
    expect(forwardListHasRunningPort(afterBothDownForwardList.stdout, SANDBOX_NAME, "8642")).toBe(
      true,
    );
    expect(
      forwardListHasRunningPort(
        afterBothDownForwardList.stdout,
        SANDBOX_NAME,
        HERMES_DASHBOARD_PORT,
      ),
    ).toBe(true);

    for (const dashboardPort of hermesDashboardE2eEnabled() ? [HERMES_DASHBOARD_PORT] : []) {
      const stopDashboardForward = await sandbox.openshell(
        ["forward", "stop", dashboardPort, SANDBOX_NAME],
        {
          artifactName: "phase-5-stop-hermes-dashboard-forward-before-recover",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(stopDashboardForward.exitCode, resultText(stopDashboardForward)).toBe(0);

      const dashboardDown = await host.command(
        "curl",
        ["-sf", "--max-time", "3", `http://127.0.0.1:${dashboardPort}/`],
        {
          artifactName: "phase-5-hermes-dashboard-host-down-after-forward-stop",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(dashboardDown.exitCode, resultText(dashboardDown)).not.toBe(0);

      const recoverDashboardForward = await host.command("nemohermes", [SANDBOX_NAME, "recover"], {
        artifactName: "phase-5-nemohermes-recover-dashboard-forward",
        env: commandEnv(),
        timeoutMs: 180_000,
      });
      expect(recoverDashboardForward.exitCode, resultText(recoverDashboardForward)).toBe(0);

      const recoveredDashboard = await host.command(
        "curl",
        [
          "-sS",
          "-L",
          "--max-time",
          "10",
          "-o",
          "/tmp/hermes-dashboard-recovered-vitest-body",
          "-w",
          "%{http_code}",
          `http://127.0.0.1:${dashboardPort}/`,
        ],
        {
          artifactName: "phase-5-hermes-dashboard-host-after-forward-recover",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(recoveredDashboard.exitCode, resultText(recoveredDashboard)).toBe(0);
      expect(httpStatusOk(recoveredDashboard.stdout)).toBe(true);

      const recoveredDashboardBody = await host.command(
        "sh",
        ["-lc", "cat /tmp/hermes-dashboard-recovered-vitest-body"],
        {
          artifactName: "phase-5-hermes-dashboard-host-after-forward-recover-body",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(recoveredDashboardBody.exitCode, resultText(recoveredDashboardBody)).toBe(0);
      expect(resultText(recoveredDashboardBody)).toMatch(
        /(<title>[^<]*Hermes|id=["']root["']|Hermes Dashboard|<html)/i,
      );

      const statusAfterDashboardRecover = await host.command(
        "nemohermes",
        [SANDBOX_NAME, "status"],
        {
          artifactName: "phase-5-nemohermes-status-after-dashboard-forward-recover",
          env: commandEnv(),
          timeoutMs: 60_000,
        },
      );
      expect(statusAfterDashboardRecover.exitCode, resultText(statusAfterDashboardRecover)).toBe(0);
      expect(resultText(statusAfterDashboardRecover)).toMatch(/Ready/i);
      expect(resultText(statusAfterDashboardRecover)).toMatch(/Inference(?: \([^)]+\))?: healthy/i);
    }
  } else {
    expect(beforePid1.stdout).toContain("/opt/openshell/bin/openshell-sandbox");
    expect(beforeGateway.owner).toBe("sandbox");

    const startupSupervisor = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        String.raw`ps -eo user=,pid=,ppid=,args= | awk '$1 == "sandbox" && $3 == 1 && ($4 ~ /(^|\/)(bash|nemoclaw-start)$/) && index($0, "nemoclaw-start") { print $1 " " $2 " " $3; found = 1; exit } END { exit found ? 0 : 1 }'`,
      ),
      {
        artifactName: "phase-5-openshell-managed-hermes-supervisor",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(startupSupervisor.exitCode, resultText(startupSupervisor)).toBe(0);
    const supervisor = parseGatewayProcess(startupSupervisor.stdout);
    expect(supervisor.owner).toBe("sandbox");
    expect(supervisor.ppid).toBe("1");
    expect(beforeGateway.ppid).toBe(supervisor.pid);
    const supervisorIdentityScript = trustedSandboxShellScript(
      `python3 -c 'from pathlib import Path; import sys; pid=sys.argv[1]; text=Path("/proc/" + pid + "/stat").read_text(); tail=text.rsplit(")", 1)[1].split(); cmd=Path("/proc/" + pid + "/cmdline").read_bytes().replace(b"\\0", b" ").decode(); print(pid + " " + tail[19] + " " + cmd)' ${shellQuote(supervisor.pid)}`,
    );
    const beforeSupervisorIdentity = await sandbox.execShell(
      SANDBOX_NAME,
      supervisorIdentityScript,
      {
        artifactName: "phase-5-managed-supervisor-identity-before-restart",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(beforeSupervisorIdentity.exitCode, resultText(beforeSupervisorIdentity)).toBe(0);

    const managedEnvBackup = `/tmp/hermes-managed-env-before-${Date.now()}`;
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
        artifactName: "phase-5-managed-hermes-introduce-raw-secret",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(introduceManagedRawSecret.exitCode, resultText(introduceManagedRawSecret)).toBe(0);

    const refuseManagedRawSecret = await host.command(
      "nemohermes",
      [SANDBOX_NAME, "gateway", "restart", "--quiet"],
      {
        artifactName: "phase-5-managed-hermes-refuse-raw-secret-restart",
        env: commandEnv(),
        timeoutMs: 180_000,
      },
    );
    expect(refuseManagedRawSecret.exitCode, resultText(refuseManagedRawSecret)).not.toBe(0);
    expect(resultText(refuseManagedRawSecret)).toMatch(
      /secret.boundary refusal|SECRET_BOUNDARY_REFUSED/i,
    );

    const afterManagedRefusal = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
      artifactName: "phase-5-managed-hermes-gateway-after-boundary-refusal",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterManagedRefusal.exitCode, resultText(afterManagedRefusal)).toBe(0);
    expect(parseGatewayProcess(afterManagedRefusal.stdout).pid).toBe(beforeGateway.pid);

    const restoreManagedEnv = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `backup=${shellQuote(managedEnvBackup)}`,
          'cat "$backup" > /sandbox/.hermes/.env',
          'rm -f "$backup"',
        ].join("; "),
      ),
      {
        artifactName: "phase-5-managed-hermes-restore-env",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(restoreManagedEnv.exitCode, resultText(restoreManagedEnv)).toBe(0);

    const stopApiForward = await sandbox.openshell(["forward", "stop", "8642", SANDBOX_NAME], {
      artifactName: "phase-5-stop-managed-hermes-api-forward",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(stopApiForward.exitCode, resultText(stopApiForward)).toBe(0);

    const restartManagedGateway = await host.command(
      "nemohermes",
      [SANDBOX_NAME, "gateway", "restart"],
      {
        artifactName: "phase-5-restart-openshell-managed-hermes-gateway",
        env: commandEnv(),
        timeoutMs: 180_000,
      },
    );
    expect(restartManagedGateway.exitCode, resultText(restartManagedGateway)).toBe(0);
    expect(resultText(restartManagedGateway)).toContain("Gateway restarted");
    expect(resultText(restartManagedGateway)).toContain("health passed");
    expect(resultText(restartManagedGateway)).toContain("forwards checked/recovered");

    const afterManagedRestart = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
      artifactName: "phase-5-managed-hermes-gateway-after-restart",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterManagedRestart.exitCode, resultText(afterManagedRestart)).toBe(0);
    const restartedManagedGateway = parseGatewayProcess(afterManagedRestart.stdout);
    expect(restartedManagedGateway.owner).toBe("sandbox");
    expect(restartedManagedGateway.ppid).toBe(supervisor.pid);
    expect(restartedManagedGateway.pid).not.toBe(beforeGateway.pid);

    const afterManagedRestartPid1 = await sandbox.execShell(SANDBOX_NAME, pid1IdentityScript, {
      artifactName: "phase-5-managed-pid1-after-restart",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterManagedRestartPid1.exitCode, resultText(afterManagedRestartPid1)).toBe(0);
    expect(afterManagedRestartPid1.stdout.trim()).toBe(beforePid1.stdout.trim());
    const afterManagedRestartSupervisor = await sandbox.execShell(
      SANDBOX_NAME,
      supervisorIdentityScript,
      {
        artifactName: "phase-5-managed-supervisor-identity-after-restart",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(afterManagedRestartSupervisor.exitCode, resultText(afterManagedRestartSupervisor)).toBe(
      0,
    );
    expect(afterManagedRestartSupervisor.stdout.trim()).toBe(
      beforeSupervisorIdentity.stdout.trim(),
    );

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
        artifactName: "phase-5-stop-managed-hermes-gateway",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(stopGateway.exitCode, resultText(stopGateway)).toBe(0);
    expect(stopGateway.stdout).toContain("GATEWAY_STOPPED");

    const recoverManagedGateway = await host.command("nemohermes", [SANDBOX_NAME, "recover"], {
      artifactName: "phase-5-recover-openshell-managed-hermes-gateway",
      env: commandEnv(),
      timeoutMs: 180_000,
    });
    expect(recoverManagedGateway.exitCode, resultText(recoverManagedGateway)).toBe(0);

    const afterRecoverProcess = await sandbox.execShell(SANDBOX_NAME, gatewayProcessScript, {
      artifactName: "phase-5-managed-hermes-gateway-after-recover",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterRecoverProcess.exitCode, resultText(afterRecoverProcess)).toBe(0);
    recoveredGateway = parseGatewayProcess(afterRecoverProcess.stdout);
    expect(recoveredGateway.owner).toBe("sandbox");
    expect(recoveredGateway.ppid).toBe(supervisor.pid);
    expect(recoveredGateway.pid).not.toBe(restartedManagedGateway.pid);

    const afterRecoverPid1 = await sandbox.execShell(SANDBOX_NAME, pid1IdentityScript, {
      artifactName: "phase-5-managed-pid1-after-recover",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterRecoverPid1.exitCode, resultText(afterRecoverPid1)).toBe(0);
    expect(afterRecoverPid1.stdout.trim()).toBe(beforePid1.stdout.trim());
    const afterRecoverSupervisor = await sandbox.execShell(SANDBOX_NAME, supervisorIdentityScript, {
      artifactName: "phase-5-managed-supervisor-identity-after-recover",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(afterRecoverSupervisor.exitCode, resultText(afterRecoverSupervisor)).toBe(0);
    expect(afterRecoverSupervisor.stdout.trim()).toBe(beforeSupervisorIdentity.stdout.trim());

    const managedHealth = await host.command(
      "curl",
      ["-sf", "--max-time", "10", HERMES_HOST_HEALTH_URL],
      {
        artifactName: "phase-5-managed-hermes-host-health-after-recover",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(managedHealth.exitCode, resultText(managedHealth)).toBe(0);
    expect(resultText(managedHealth)).toMatch(/"ok"/i);

    const managedForwardList = await sandbox.openshell(["forward", "list"], {
      artifactName: "phase-5-managed-forward-list-after-recover",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(managedForwardList.exitCode, resultText(managedForwardList)).toBe(0);
    expect(forwardListHasRunningPort(managedForwardList.stdout, SANDBOX_NAME, "8642")).toBe(true);
    for (const dashboardPort of hermesDashboardE2eEnabled() ? [HERMES_DASHBOARD_PORT] : []) {
      expect(
        forwardListHasRunningPort(managedForwardList.stdout, SANDBOX_NAME, dashboardPort),
      ).toBe(true);
    }
  }

  // Phase 6: live inference through both the external provider and the
  // sandbox's inference.local route.
  const directChat = await retryHostedInference("direct NVIDIA Endpoints chat", async (attempt) => {
    const response = await provider.requestJson(
      trustedProviderEndpoint("https://inference-api.nvidia.com/v1/chat/completions", {
        allowedHosts: ["inference-api.nvidia.com"],
      }),
      {
        artifactName: `phase-6-direct-nvidia-chat-attempt-${attempt}`,
        body: chatPayload(
          hosted.model,
          "Reply with exactly one word: PONG",
          attempt === 1 ? 256 : 1024,
        ),
        curlMaxTimeSeconds: 90,
        headers: ["Content-Type: application/json", `Authorization: Bearer ${apiKey}`],
        env: buildAvailabilityProbeEnv(),
        redactionValues,
        timeoutMs: 120_000,
      },
    );
    if (shouldRetryForReasoningBudget(response.json)) {
      throw new Error("direct chat exhausted response budget while reasoning before PONG");
    }
    return response;
  });
  expectPong("direct NVIDIA Endpoints chat", directChat.json);

  const sandboxChatJson = await retryHostedInference(
    "Hermes sandbox inference.local chat",
    async (attempt) => {
      const result = await sandbox.exec(
        SANDBOX_NAME,
        [
          "curl",
          "-fsS",
          "--max-time",
          "90",
          "-H",
          "Content-Type: application/json",
          "--data-raw",
          chatPayload(
            hosted.model,
            "Reply with exactly one word: PONG",
            attempt === 1 ? 256 : 1024,
          ),
          "https://inference.local/v1/chat/completions",
        ],
        {
          artifactName: `phase-6-inference-local-chat-attempt-${attempt}`,
          env: commandEnv(),
          timeoutMs: 120_000,
        },
      );
      if (result.exitCode !== 0) throw new Error(resultText(result));
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout) as unknown;
      } catch (error) {
        throw new Error(
          `Hermes sandbox inference.local chat response was not JSON: ${
            error instanceof Error ? error.message : String(error)
          }; body=${result.stdout.slice(0, 500)}`,
        );
      }
      if (shouldRetryForReasoningBudget(parsed)) {
        throw new Error("sandbox chat exhausted response budget while reasoning before PONG");
      }
      return parsed;
    },
  );
  expectPong("Hermes sandbox inference.local chat", sandboxChatJson);

  // Phase 7: CLI operations and agent manifest regression.
  const logs = await host.command("nemoclaw", [SANDBOX_NAME, "logs"], {
    artifactName: "phase-7-nemoclaw-logs",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(logs.exitCode, resultText(logs)).toBe(0);
  expect(resultText(logs).trim().length).toBeGreaterThan(0);

  const manifestCheck = await host.command(
    "node",
    [
      "-e",
      `const { loadAgent, listAgents } = require(${JSON.stringify(path.join(REPO_ROOT, "bin", "lib", "agent-defs"))});\n` +
        `const agents = listAgents();\n` +
        `console.log('agents:', agents.join(', '));\n` +
        `console.log('openclaw_display:', loadAgent('openclaw').displayName);\n` +
        `console.log('hermes_display:', loadAgent('hermes').displayName);`,
    ],
    {
      artifactName: "phase-7-agent-manifest-check",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(manifestCheck.exitCode, resultText(manifestCheck)).toBe(0);
  expect(manifestCheck.stdout).toMatch(/openclaw_display:.*OpenClaw/);
  expect(manifestCheck.stdout).toMatch(/hermes_display:.*Hermes/);
  expect(manifestCheck.stdout).toMatch(/agents:.*(openclaw.*hermes|hermes.*openclaw)/);

  // Phase 8: locked Hermes config drift is refused instead of adopted by the
  // documented root-entrypoint lifecycle-control topology. The managed
  // topology proves explicit restart plus boundary refusal above; this phase
  // retains the stronger root-owned restart-seal drift contract.
  if (rootSupervisorTopology) {
    const shieldsUp = await host.command("nemohermes", [SANDBOX_NAME, "shields", "up"], {
      artifactName: "phase-8-nemohermes-shields-up",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    expect(shieldsUp.exitCode, resultText(shieldsUp)).toBe(0);

    const lockedDriftMarker = `issue_2426_locked_${Date.now()}`;
    try {
      const introduceLockedDrift = await sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(
          [
            "set -eu",
            `marker=${shellQuote(lockedDriftMarker)}`,
            'for path in /sandbox/.hermes /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash; do chattr -i "$path" 2>/dev/null || true; done',
            "chmod u+w /sandbox/.hermes/.env",
            'printf "\\nNEMOCLAW_E2E_LOCKED_DRIFT_MARKER=%s\\n" "$marker" >> /sandbox/.hermes/.env',
            "chown root:root /sandbox/.hermes /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash",
            "chmod 755 /sandbox/.hermes",
            "chmod 444 /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash",
            "echo LOCKED_DRIFT_READY",
          ].join("; "),
        ),
        {
          artifactName: "phase-8-introduce-locked-hermes-drift",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(introduceLockedDrift.exitCode, resultText(introduceLockedDrift)).toBe(0);
      expect(introduceLockedDrift.stdout).toContain("LOCKED_DRIFT_READY");

      const lockedRestart = await host.command(
        "nemohermes",
        [SANDBOX_NAME, "gateway", "restart", "--quiet"],
        {
          artifactName: "phase-8-nemohermes-gateway-restart-locked-drift",
          env: commandEnv(),
          timeoutMs: 180_000,
        },
      );
      expect(lockedRestart.exitCode, resultText(lockedRestart)).not.toBe(0);
      expect(resultText(lockedRestart)).toMatch(
        /config hash mismatch|GATEWAY_CONFIG_HASH_MISMATCH/,
      );

      const afterLockedRefusalProcess = await sandbox.execShell(
        SANDBOX_NAME,
        gatewayProcessScript,
        {
          artifactName: "phase-8-hermes-gateway-process-after-locked-refusal",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(afterLockedRefusalProcess.exitCode, resultText(afterLockedRefusalProcess)).toBe(0);
      const gatewayAfterLockedRefusal = parseGatewayProcess(afterLockedRefusalProcess.stdout);
      expect(gatewayAfterLockedRefusal.owner).toBe("gateway");
      expect(gatewayAfterLockedRefusal.pid).toBe(recoveredGateway.pid);
    } finally {
      const restoreLockedDrift = await sandbox.execShell(
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
            "echo OK",
          ].join("; "),
        ),
        {
          artifactName: "phase-8-restore-locked-hermes-drift",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(restoreLockedDrift.exitCode, resultText(restoreLockedDrift)).toBe(0);
      expect(restoreLockedDrift.stdout).toContain("OK");
    }
  }

  const securityPosture = securityPostureEnabled()
    ? await assertSecurityPosture(host, sandbox, SANDBOX_NAME, "hermes")
    : null;

  // Phase 9: explicit cleanup and post-destroy registry proof.
  if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1") {
    const destroy = await host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "phase-9-nemoclaw-destroy",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    expect(destroy.exitCode, resultText(destroy)).toBe(0);
    await bestEffort(() =>
      sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "phase-9-openshell-gateway-destroy",
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
      dashboardChecked: hermesDashboardE2eEnabled(),
      securityPostureChecked: securityPosture !== null,
    },
    securityPosture,
  });
});
