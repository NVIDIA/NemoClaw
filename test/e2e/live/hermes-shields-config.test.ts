// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HERMES_SHIELDS_COMMAND_TIMEOUT_MS,
  HERMES_SHIELDS_CONFIG_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/hermes-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { stripAnsi } from "./json-envelope.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-shields";
const GATEWAY_NAME = process.env.OPENSHELL_GATEWAY ?? "nemoclaw";
const COMPATIBLE_API_KEY = "hermes-shields-e2e-key";
const COMPATIBLE_MODEL = "hermes-shields-e2e-model";
const CONFIG_PATH = "/sandbox/.hermes/config.yaml";
const HERMES_DIR = "/sandbox/.hermes";
const STATE_LOCK_PLAN_PATH = "/usr/local/share/nemoclaw/state-lock-plan.json";
const COMMAND_TIMEOUT_MS = 120_000;
const SHIELDS_COMMAND_TIMEOUT_MS = HERMES_SHIELDS_COMMAND_TIMEOUT_MS;

validateSandboxName(SANDBOX_NAME);

function commandEnv(endpointUrl?: string): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    COMPATIBLE_API_KEY,
    NVIDIA_INFERENCE_API_KEY: COMPATIBLE_API_KEY,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_COMPAT_MODEL: COMPATIBLE_MODEL,
    NEMOCLAW_ENDPOINT_URL: endpointUrl ?? "",
    NEMOCLAW_MODEL: COMPATIBLE_MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS: "60",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_GPU: "0",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: GATEWAY_NAME,
  };
}

async function preClean(host: HostCliClient): Promise<void> {
  await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
    artifactName: "pre-cleanup-destroy-sandbox",
    env: commandEnv(),
    timeoutMs: 15 * 60_000,
  });
  await host
    .cleanupGatewayRegistration(GATEWAY_NAME, {
      artifactName: "pre-cleanup-destroy-gateway",
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
}

async function sandboxShell(
  sandbox: SandboxClient,
  script: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName,
    env: commandEnv(),
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function runShields(
  host: HostCliClient,
  args: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  return await host.command("nemohermes", [SANDBOX_NAME, "shields", ...args], {
    artifactName,
    env: commandEnv(),
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: SHIELDS_COMMAND_TIMEOUT_MS,
  });
}

async function expectShieldsStatus(
  host: HostCliClient,
  expected: "DOWN" | "UP",
  artifactName: string,
): Promise<void> {
  const status = await runShields(host, ["status"], artifactName);
  assertExitZero(status, `read Hermes shields ${expected} status`);
  expect(resultText(status)).toContain(`Shields: ${expected}`);
}

async function collectStartFailureRuntimeLogs(
  runtimeProvider: RuntimeProviderPrerequisite,
  artifactPrefix: string,
): Promise<string> {
  const lookup = await runtimeProvider.command(
    [
      "container",
      "ps",
      "--all",
      "--filter",
      `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
      "-q",
    ],
    {
      artifactName: `${artifactPrefix}-failure-container`,
      env: commandEnv(),
      redactionValues: [COMPATIBLE_API_KEY],
      timeoutMs: 30_000,
    },
  );
  const containerId = lookup.stdout.trim().split(/\s+/u).filter(Boolean)[0] ?? "";
  const result =
    lookup.exitCode !== 0 || !containerId
      ? lookup
      : await runtimeProvider.command(["container", "logs", "--tail", "200", containerId], {
          artifactName: `${artifactPrefix}-failure-runtime-logs`,
          env: commandEnv(),
          redactionValues: [COMPATIBLE_API_KEY],
          timeoutMs: 30_000,
        });
  return resultText(result);
}

async function expectStopStartRecovery(
  host: HostCliClient,
  runtimeProvider: RuntimeProviderPrerequisite,
  sandbox: SandboxClient,
  posture: "DOWN" | "UP",
  artifactPrefix: string,
): Promise<void> {
  const stop = await host.nemoclaw([SANDBOX_NAME, "stop"], {
    artifactName: `${artifactPrefix}-stop`,
    env: commandEnv(),
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: 5 * 60_000,
  });
  assertExitZero(stop, `stop Hermes with shields ${posture.toLowerCase()}`);

  const start = await host.nemoclaw([SANDBOX_NAME, "start"], {
    artifactName: `${artifactPrefix}-start`,
    env: commandEnv(),
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: 5 * 60_000,
  });
  const startFailureLogs =
    start.exitCode === 0
      ? ""
      : await collectStartFailureRuntimeLogs(runtimeProvider, artifactPrefix);
  expect(
    start.exitCode,
    [
      `start Hermes with shields ${posture.toLowerCase()}: ${resultText(start)}`,
      startFailureLogs && `Runtime logs:\n${startFailureLogs}`,
    ]
      .filter(Boolean)
      .join("\n"),
  ).toBe(0);

  const status = await host.nemoclaw([SANDBOX_NAME, "status"], {
    artifactName: `${artifactPrefix}-status`,
    env: commandEnv(),
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: 5 * 60_000,
  });
  assertExitZero(status, `read Hermes status with shields ${posture.toLowerCase()}`);
  expect(stripAnsi(resultText(status))).toMatch(/Phase:\s*Ready/i);
  await expectShieldsStatus(host, posture, `${artifactPrefix}-shields-status`);

  const runtimeIdentity = await sandboxShell(
    sandbox,
    'printf \'pwd=%s\\nhome=%s\\nuser=%s\\ngroup=%s\\n\' "$PWD" "$HOME" "$(id -un)" "$(id -gn)"',
    `${artifactPrefix}-runtime-identity`,
  );
  assertExitZero(runtimeIdentity, `inspect Hermes runtime identity with shields ${posture}`);
  expect(runtimeIdentity.stdout).toContain("pwd=/sandbox\n");
  expect(runtimeIdentity.stdout).toContain("home=/sandbox\n");
  expect(runtimeIdentity.stdout).toContain("user=sandbox\n");
  expect(runtimeIdentity.stdout).toContain("group=sandbox\n");
}

async function expectMutablePosture(sandbox: SandboxClient, cycle: number): Promise<void> {
  const result = await sandboxShell(
    sandbox,
    `stat -c '%a %U:%G %n' /sandbox ${HERMES_DIR} ${CONFIG_PATH} ${HERMES_DIR}/.env ${HERMES_DIR}/.config-hash`,
    `cycle-${cycle}-mutable-posture`,
  );
  assertExitZero(result, `inspect Hermes mutable posture after cycle ${cycle}`);
  expect(result.stdout).toContain("755 sandbox:sandbox /sandbox");
  expect(result.stdout).toMatch(
    new RegExp(`^(?:700|3770) sandbox:sandbox ${HERMES_DIR.replace(".", "\\.")}$`, "m"),
  );
  expect(result.stdout).toContain(`640 sandbox:sandbox ${CONFIG_PATH}`);
  expect(result.stdout).toContain(`640 sandbox:sandbox ${HERMES_DIR}/.env`);
  expect(result.stdout).toContain(`640 sandbox:sandbox ${HERMES_DIR}/.config-hash`);
}

async function expectLockedPosture(sandbox: SandboxClient, cycle: number): Promise<void> {
  const result = await sandboxShell(
    sandbox,
    `stat -c '%a %U:%G %n' /sandbox ${HERMES_DIR} ${CONFIG_PATH} ${HERMES_DIR}/.env ${HERMES_DIR}/.config-hash`,
    `cycle-${cycle}-locked-posture`,
  );
  assertExitZero(result, `inspect Hermes locked posture after cycle ${cycle}`);
  expect(result.stdout).toContain("1775 root:sandbox /sandbox");
  expect(result.stdout).toContain(`3770 root:sandbox ${HERMES_DIR}`);
  expect(result.stdout).toContain(`444 root:root ${CONFIG_PATH}`);
  expect(result.stdout).toContain(`444 root:root ${HERMES_DIR}/.env`);
  expect(result.stdout).toContain(`444 root:root ${HERMES_DIR}/.config-hash`);
}

async function expectImmediateInferenceRoute(sandbox: SandboxClient, cycle: number): Promise<void> {
  const result = await sandboxShell(
    sandbox,
    [
      "set -eu",
      'response="$(mktemp)"',
      "trap 'rm -f \"$response\"' EXIT",
      'curl -fsS --connect-timeout 3 --max-time 10 https://inference.local/v1/models -o "$response"',
      "python3 - \"$response\" <<'PY'",
      "import json, pathlib, sys",
      "payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
      `assert ${JSON.stringify(COMPATIBLE_MODEL)} in {entry.get("id") for entry in payload["data"]}`,
      "print('HERMES_SHIELDS_INFERENCE_ROUTE_READY')",
      "PY",
    ].join("\n"),
    `cycle-${cycle}-immediate-inference-route`,
  );
  assertExitZero(
    result,
    `probe Hermes inference route immediately after Shields down cycle ${cycle}`,
  );
  expect(result.stdout).toContain("HERMES_SHIELDS_INFERENCE_ROUTE_READY");
}

async function completeShieldsCycle(
  host: HostCliClient,
  sandbox: SandboxClient,
  cycle: number,
): Promise<void> {
  const down = await runShields(
    host,
    ["down", "--timeout", "15m", "--reason", `Hermes live E2E cycle ${cycle}`],
    `cycle-${cycle}-shields-down`,
  );
  assertExitZero(down, `unlock fresh Hermes config in cycle ${cycle}`);
  await expectImmediateInferenceRoute(sandbox, cycle);
  await expectShieldsStatus(host, "DOWN", `cycle-${cycle}-status-down`);
  await expectMutablePosture(sandbox, cycle);

  const up = await runShields(host, ["up"], `cycle-${cycle}-shields-up`);
  assertExitZero(up, `lock fresh Hermes config in cycle ${cycle}`);
  await expectShieldsStatus(host, "UP", `cycle-${cycle}-status-up`);
  await expectLockedPosture(sandbox, cycle);
}

test(
  "hermes-shields-config: stopped Hermes restores under both Shields postures (#6381, #8112)",
  {
  timeout: HERMES_SHIELDS_CONFIG_TEST_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "prepare Hermes shields fixture",
      "onboard non-root Hermes sandbox",
      "verify fresh Hermes runtime state",
      "complete first shields cycle",
      "restart Hermes with shields up",
      "unlock shields and restart Hermes",
      "complete second shields cycle",
      "verify preserved config and ready state",
    ],
  },
  },
  async ({ artifacts, cleanup: cleanupRegistry, host, progress, runtimeProvider, sandbox }) => {
  await artifacts.target.declare({
    id: "hermes-shields-config",
    boundary:
      "fresh CPU-only Hermes onboard plus two real shields down/up transitions and stopped-sandbox recovery",
    contracts: [
      "fresh OpenShell-managed non-root Hermes startup mints its API key",
      "the installed state lock plan keeps skills read-only and pairing confidential",
      "the first shields-down reconciles the startup hash anchor",
      "shields-up establishes the root-owned locked posture",
      "start restores a stopped Hermes sandbox while shields are up",
      "start restores a stopped Hermes sandbox while shields are down",
      "each successful shields-down returns only after inference.local serves the configured model",
      "a second down/up cycle completes without corrupting config state",
    ],
    issue: "#6381",
    sandboxName: SANDBOX_NAME,
  });

    await runtimeProvider.requireAvailable({
    artifactName: "prereq-runtime-info",
      scenarioLabel: "Hermes shields",
  });

  const fake = await startFakeOpenAiCompatibleServer({
    apiKey: COMPATIBLE_API_KEY,
    host: "0.0.0.0",
    model: COMPATIBLE_MODEL,
    progress,
    publicHost: "host.openshell.internal",
    requireAuth: true,
  });
  cleanupRegistry.trackDisposable("close Hermes shields fake inference endpoint", async () => {
    try {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
    } finally {
      await fake.close();
    }
  });
  const gatewayCleanupOptions = {
    artifactName: "cleanup-destroy-gateway",
    env: commandEnv(),
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: 60_000,
  };
  cleanupRegistry.trackGateway(
    {
      cleanupGatewayRegistration: (name: string) =>
        cleanupWhenOpenShellAvailable(
          host,
          {
            artifactName: "cleanup-probe-openshell-gateway",
            env: gatewayCleanupOptions.env,
            redactionValues: gatewayCleanupOptions.redactionValues,
            timeoutMs: 30_000,
          },
          () => host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
        ),
    },
    GATEWAY_NAME,
    gatewayCleanupOptions,
  );
  const sandboxCleanupOptions = {
    artifactName: "cleanup-destroy-sandbox",
    env: commandEnv(),
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: 15 * 60_000,
  };
  cleanupRegistry.trackSandbox(
    {
      cleanupSandbox: (name: string) =>
        cleanupWhenCommandAvailable(
          host,
          host.commandPath,
          {
            artifactName: "cleanup-probe-nemoclaw-sandbox",
            env: sandboxCleanupOptions.env,
            redactionValues: sandboxCleanupOptions.redactionValues,
            timeoutMs: 30_000,
          },
          () => host.cleanupSandbox(name, sandboxCleanupOptions),
        ),
    },
    SANDBOX_NAME,
    sandboxCleanupOptions,
  );
  await preClean(host);

  const env = commandEnv(fake.baseUrl);
  progress.phase("onboard non-root Hermes sandbox");
  const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
    artifactName: "fresh-hermes-onboard",
    cwd: REPO_ROOT,
    env,
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: 30 * 60_000,
  });
  assertExitZero(install, "fresh CPU-only Hermes onboard");

  const status = await host.command("nemoclaw", [SANDBOX_NAME, "status"], {
    artifactName: "fresh-hermes-status",
    env,
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  assertExitZero(status, "read fresh Hermes status");
  expect(stripAnsi(resultText(status))).toMatch(/Phase:\s*Ready/i);

  progress.phase("verify fresh Hermes runtime state");
  const trigger = await sandboxShell(
    sandbox,
    [
      "set -eu",
      "test ! -e /run/nemoclaw/hermes-root-lifecycle",
      `grep -Eq '^API_SERVER_KEY=[0-9a-fA-F]{64}$' ${HERMES_DIR}/.env`,
      `stat -c '%a %U:%G' ${HERMES_DIR}`,
      `python3 -c 'import json; p=json.load(open("${STATE_LOCK_PLAN_PATH}", encoding="utf-8")); assert "skills" in p["readOnlyRoots"]; assert "pairing" in p["confidentialRoots"]; print("STATE_LOCK_PLAN_MODES=skills:read-only,pairing:confidential")'`,
      `sha256sum ${CONFIG_PATH} | awk '{print $1}'`,
    ].join("\n"),
    "fresh-nonroot-trigger",
  );
  assertExitZero(trigger, "prove fresh non-root Hermes startup trigger");
  const triggerLines = trigger.stdout.trim().split(/\r?\n/);
  expect(triggerLines[0]).toMatch(/^(700|3770) sandbox:sandbox$/);
  expect(trigger.stdout).toContain("STATE_LOCK_PLAN_MODES=skills:read-only,pairing:confidential");
  const configHashBefore = triggerLines.at(-1) ?? "";
  expect(configHashBefore).toMatch(/^[0-9a-f]{64}$/);

  progress.phase("complete first shields cycle");
  await completeShieldsCycle(host, sandbox, 1);

  progress.phase("restart Hermes with shields up");
    await expectStopStartRecovery(
      host,
      runtimeProvider,
      sandbox,
      "UP",
      "cycle-1-shields-up-start-recovery",
    );
  await expectLockedPosture(sandbox, 1);

  progress.phase("unlock shields and restart Hermes");
  const down = await runShields(
    host,
    ["down", "--timeout", "15m", "--reason", "Hermes live E2E cycle 2"],
    "cycle-2-shields-down",
  );
  assertExitZero(down, "unlock fresh Hermes config in cycle 2");
  await expectImmediateInferenceRoute(sandbox, 2);
  await expectShieldsStatus(host, "DOWN", "cycle-2-status-down");
  await expectMutablePosture(sandbox, 2);
    await expectStopStartRecovery(
      host,
      runtimeProvider,
      sandbox,
      "DOWN",
      "cycle-2-shields-down-start-recovery",
    );
  await expectMutablePosture(sandbox, 2);

  progress.phase("complete second shields cycle");
  const up = await runShields(host, ["up"], "cycle-2-shields-up");
  assertExitZero(up, "lock fresh Hermes config in cycle 2");
  await expectShieldsStatus(host, "UP", "cycle-2-status-up");
  await expectLockedPosture(sandbox, 2);

  progress.phase("verify preserved config and ready state");
  const configHashAfter = await sandboxShell(
    sandbox,
    `sha256sum ${CONFIG_PATH} | awk '{print $1}'`,
    "config-hash-after-two-cycles",
  );
  assertExitZero(configHashAfter, "read Hermes config hash after two shields cycles");
  expect(configHashAfter.stdout.trim()).toBe(configHashBefore);

  const finalStatus = await host.command("nemoclaw", [SANDBOX_NAME, "status"], {
    artifactName: "final-hermes-status",
    env,
    redactionValues: [COMPATIBLE_API_KEY],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  assertExitZero(finalStatus, "read Hermes status after two shields cycles");
  expect(stripAnsi(resultText(finalStatus))).toMatch(/Phase:\s*Ready/i);

  await artifacts.target.complete({
    id: "hermes-shields-config",
    sandboxName: SANDBOX_NAME,
    assertions: {
      configPreserved: true,
      freshNonrootTrigger: true,
      stateLockPlanModes: true,
      firstCycle: true,
      postTransitionInferenceRoute: true,
      shieldsDownStartRecovery: true,
      shieldsUpStartRecovery: true,
      secondCycle: true,
    },
  });
  },
);
