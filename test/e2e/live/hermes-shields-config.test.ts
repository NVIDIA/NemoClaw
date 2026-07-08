// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
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
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { stripAnsi } from "./json-envelope.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-shields";
const GATEWAY_NAME = process.env.OPENSHELL_GATEWAY ?? "nemoclaw";
const COMPATIBLE_API_KEY = "hermes-shields-e2e-key";
const COMPATIBLE_MODEL = "hermes-shields-e2e-model";
const CONFIG_PATH = "/sandbox/.hermes/config.yaml";
const HERMES_DIR = "/sandbox/.hermes";
const TEST_TIMEOUT_MS = 45 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;

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

async function cleanup(host: HostCliClient, label: string): Promise<void> {
  await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
    artifactName: `${label}-destroy-sandbox`,
    env: commandEnv(),
    timeoutMs: 15 * 60_000,
  });
  await host
    .cleanupGatewayRegistration(GATEWAY_NAME, {
      artifactName: `${label}-destroy-gateway`,
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
    timeoutMs: COMMAND_TIMEOUT_MS,
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

async function expectMutablePosture(sandbox: SandboxClient, cycle: number): Promise<void> {
  const result = await sandboxShell(
    sandbox,
    `stat -c '%a %U:%G %n' /sandbox ${HERMES_DIR} ${CONFIG_PATH} ${HERMES_DIR}/.env ${HERMES_DIR}/.config-hash`,
    `cycle-${cycle}-mutable-posture`,
  );
  assertExitZero(result, `inspect Hermes mutable posture after cycle ${cycle}`);
  expect(result.stdout).toContain("755 sandbox:sandbox /sandbox");
  expect(result.stdout).toContain(`3770 sandbox:sandbox ${HERMES_DIR}`);
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
  expect(result.stdout).toContain(`755 root:root ${HERMES_DIR}`);
  expect(result.stdout).toContain(`444 root:root ${CONFIG_PATH}`);
  expect(result.stdout).toContain(`444 root:root ${HERMES_DIR}/.env`);
  expect(result.stdout).toContain(`444 root:root ${HERMES_DIR}/.config-hash`);
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
  await expectShieldsStatus(host, "DOWN", `cycle-${cycle}-status-down`);
  await expectMutablePosture(sandbox, cycle);

  const up = await runShields(host, ["up"], `cycle-${cycle}-shields-up`);
  assertExitZero(up, `lock fresh Hermes config in cycle ${cycle}`);
  await expectShieldsStatus(host, "UP", `cycle-${cycle}-status-up`);
  await expectLockedPosture(sandbox, cycle);
}

test("hermes-shields-config: fresh non-root Hermes sandbox completes two shields cycles (#6381)", {
  timeout: TEST_TIMEOUT_MS,
}, async ({ artifacts, cleanup: cleanupRegistry, host, sandbox }) => {
  await artifacts.target.declare({
    id: "hermes-shields-config",
    boundary: "fresh CPU-only Hermes onboard plus two real shields down/up transitions",
    contracts: [
      "fresh OpenShell-managed non-root Hermes startup mints its API key",
      "the first shields-down reconciles the startup hash anchor",
      "shields-up establishes the root-owned locked posture",
      "a second down/up cycle completes without corrupting config state",
    ],
    issue: "#6381",
    sandboxName: SANDBOX_NAME,
  });

  const docker = await host.command("docker", ["info"], {
    artifactName: "prereq-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  assertExitZero(docker, "Docker prerequisite for Hermes shields E2E");

  const fake = await startFakeOpenAiCompatibleServer({
    apiKey: COMPATIBLE_API_KEY,
    host: "0.0.0.0",
    model: COMPATIBLE_MODEL,
    publicHost: "host.openshell.internal",
    requireAuth: true,
  });
  cleanupRegistry.add("close Hermes shields fake inference endpoint", async () => {
    await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
    await fake.close();
  });
  cleanupRegistry.add(`destroy Hermes shields sandbox ${SANDBOX_NAME}`, async () => {
    await cleanup(host, "cleanup");
  });
  await cleanup(host, "pre-cleanup");

  const env = commandEnv(fake.baseUrl);
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

  const trigger = await sandboxShell(
    sandbox,
    [
      "set -eu",
      "test ! -e /run/nemoclaw/hermes-root-lifecycle",
      `grep -Eq '^API_SERVER_KEY=[0-9a-fA-F]{64}$' ${HERMES_DIR}/.env`,
      `stat -c '%a %U:%G' ${HERMES_DIR}`,
      `sha256sum ${CONFIG_PATH} | awk '{print $1}'`,
    ].join("\n"),
    "fresh-nonroot-trigger",
  );
  assertExitZero(trigger, "prove fresh non-root Hermes startup trigger");
  const triggerLines = trigger.stdout.trim().split(/\r?\n/);
  expect(triggerLines[0]).toMatch(/^(700|3770) sandbox:sandbox$/);
  const configHashBefore = triggerLines.at(-1) ?? "";
  expect(configHashBefore).toMatch(/^[0-9a-f]{64}$/);

  await completeShieldsCycle(host, sandbox, 1);
  await completeShieldsCycle(host, sandbox, 2);

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
      firstCycle: true,
      secondCycle: true,
    },
  });
});
