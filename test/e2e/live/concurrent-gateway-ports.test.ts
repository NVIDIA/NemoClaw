// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real-system boundaries: two NemoClaw onboards on one
 * host, per-port OpenShell Docker-driver gateways, dashboard forward
 * allocation, `nemoclaw list`, OpenShell sandbox discovery, host socket probes,
 * and destroy/health cleanup.
 */

import fs from "node:fs";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { PollingError, pollUntil } from "../fixtures/polling.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_A = process.env.NEMOCLAW_CGP_SANDBOX_A ?? "e2e-cgp-a";
const SANDBOX_B = process.env.NEMOCLAW_CGP_SANDBOX_B ?? "e2e-cgp-b";
const GATEWAY_PORT_A = process.env.NEMOCLAW_E2E_GATEWAY_PORT_A ?? "8080";
const GATEWAY_PORT_B = process.env.NEMOCLAW_E2E_GATEWAY_PORT_B ?? "18080";
const DASHBOARD_PORT_A = process.env.NEMOCLAW_E2E_DASHBOARD_PORT_A ?? "18789";
const PHASE_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_PHASE_TIMEOUT_MS ?? 1_200) * 1_000;
const PROBE_ATTEMPTS = Number(process.env.NEMOCLAW_E2E_PROBE_ATTEMPTS ?? 12);
const PROBE_DELAY_MS = Number(process.env.NEMOCLAW_E2E_PROBE_DELAY_SECONDS ?? 5) * 1_000;
const TEST_TIMEOUT_MS = 90 * 60_000;

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;
validateSandboxName(SANDBOX_A);
validateSandboxName(SANDBOX_B);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

function gatewayNameForPort(port: string): string {
  return port === "8080" ? "nemoclaw" : `nemoclaw-${port}`;
}

function openshellEnvForGateway(gatewayName: string): NodeJS.ProcessEnv {
  return commandEnv({ OPENSHELL_GATEWAY: gatewayName });
}

function onboardEnv(
  sandboxName: string,
  gatewayPort: string,
  fakeBaseUrl: string,
): NodeJS.ProcessEnv {
  return commandEnv({
    CHAT_UI_URL: "",
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_DASHBOARD_PORT: "",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_GATEWAY_PORT: gatewayPort,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
  });
}

async function command(
  host: HostCliClient,
  args: string[],
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    artifactName: options.artifactName,
    env: options.env ?? commandEnv(),
    timeoutMs: options.timeoutMs,
  });
}

async function runOnboard(
  host: HostCliClient,
  sandboxName: string,
  gatewayPort: string,
  fakeBaseUrl: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await command(host, ["onboard", "--non-interactive"], {
    artifactName,
    env: onboardEnv(sandboxName, gatewayPort, fakeBaseUrl),
    timeoutMs: PHASE_TIMEOUT_MS,
  });
}

function dashboardPortFromList(output: string, sandboxName: string): string | undefined {
  let current: string | undefined;
  for (const line of output.split("\n")) {
    if (/^\s{4}\S/.test(line) && !/^\s{6}/.test(line)) {
      const stripped = line.trim();
      current = stripped ? stripped.split(/\s+/)[0] : undefined;
      continue;
    }
    if (current === sandboxName) {
      const match = line.match(/dashboard:\s+http:\/\/[0-9.]+:(\d+)\/?/);
      if (match) return match[1];
    }
  }
  return undefined;
}

function outputIncludesSandbox(output: string, sandboxName: string): boolean {
  return new RegExp(`^\\s+${sandboxName}(?: \\*)?\\s*$`, "m").test(output);
}

function sandboxPhaseFromList(output: string, sandboxName: string): string | undefined {
  for (const line of output.replace(/\x1B\[[0-9;]*m/g, "").split("\n")) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === sandboxName) return parts.at(-1);
  }
  return undefined;
}

async function waitForSandboxReady(
  sandbox: SandboxClient,
  sandboxName: string,
  gatewayName: string,
  artifactPrefix: string,
): Promise<string> {
  try {
    const result = await pollUntil({
      artifactPrefix,
      attempts: PROBE_ATTEMPTS,
      delayMs: PROBE_DELAY_MS,
      probe: async (_attempt, artifactName) => {
        const probe = await sandbox.openshell(["sandbox", "list", "-g", gatewayName], {
          artifactName,
          env: openshellEnvForGateway(gatewayName),
          timeoutMs: 30_000,
        });
        const output = resultText(probe);
        return { output, phase: sandboxPhaseFromList(output, sandboxName) ?? "missing" };
      },
      accept: ({ phase }) => phase === "Ready" || phase === "Running",
      terminal: ({ phase }) =>
        phase === "Error" || phase === "Failed" || phase === "CrashLoopBackOff"
          ? `${sandboxName} reached terminal phase '${phase}' on ${gatewayName}`
          : undefined,
    });
    return result.value.phase;
  } catch (error) {
    if (!(error instanceof PollingError)) throw error;
    if (error.reason === "terminal") throw error;
    const last = error.lastAttempt?.value;
    throw new Error(
      `${sandboxName} did not reach Ready/Running on ${gatewayName}; last phase '${last?.phase ?? "missing"}'\n${last?.output ?? ""}`,
    );
  }
}

async function expectPortListening(
  host: HostCliClient,
  port: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  const result = await host.command("bash", ["-lc", `ss -ltn | grep -Eq '[:.]${port}\\b'`], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  return result;
}

async function prerequisiteOrSkip(
  host: HostCliClient,
  skip: (message: string) => never,
  commandName: string,
  args: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  const result = await host.command(commandName, args, {
    artifactName,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  if (result.exitCode === 0) return result;
  const message = `${commandName} ${args.join(" ")} is required for concurrent gateway ports E2E: ${resultText(
    result,
  )}`;
  if (process.env.GITHUB_ACTIONS === "true") throw new Error(message);
  skip(message);
}

async function bestEffortCleanup(
  host: HostCliClient,
  sandbox: SandboxClient,
  gatewayA: string,
  gatewayB: string,
): Promise<void> {
  for (const [name, gateway, port] of [
    [SANDBOX_B, gatewayB, GATEWAY_PORT_B],
    [SANDBOX_A, gatewayA, GATEWAY_PORT_A],
  ] as const) {
    try {
      await command(host, [name, "destroy", "--yes"], {
        artifactName: `cleanup-destroy-${name}`,
        env: commandEnv({ NEMOCLAW_GATEWAY_PORT: port }),
        timeoutMs: 5 * 60_000,
      });
    } catch {
      // best effort
    }
    try {
      await sandbox.openshell(["sandbox", "delete", name, "-g", gateway], {
        artifactName: `cleanup-openshell-delete-${name}`,
        env: openshellEnvForGateway(gateway),
        timeoutMs: 60_000,
      });
    } catch {
      // best effort
    }
  }
  for (const port of [
    "18789",
    "18790",
    "18791",
    "18792",
    "18793",
    "18794",
    "18795",
    "18796",
    "18797",
    "18798",
    "18799",
  ]) {
    try {
      await sandbox.openshell(["forward", "stop", port], {
        artifactName: `cleanup-forward-stop-${port}`,
        env: commandEnv(),
        timeoutMs: 15_000,
      });
    } catch {
      // best effort
    }
  }
  for (const gateway of [gatewayB, gatewayA]) {
    try {
      await sandbox.openshell(["gateway", "destroy", "-g", gateway], {
        artifactName: `cleanup-gateway-destroy-${gateway}`,
        env: openshellEnvForGateway(gateway),
        timeoutMs: 60_000,
      });
    } catch {
      // best effort
    }
  }
}

test("concurrent gateway ports: onboards two sandboxes on isolated gateways and dashboards", {
  timeout: TEST_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, skip }) => {
  expect(
    fs.existsSync(CLI_DIST_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI targets",
  ).toBe(true);

  await prerequisiteOrSkip(host, skip, "docker", ["info"], "prereq-docker-info");
  await prerequisiteOrSkip(host, skip, "bash", ["-lc", "command -v openshell"], "prereq-openshell");
  await prerequisiteOrSkip(
    host,
    skip,
    process.execPath,
    [CLI_ENTRYPOINT, "--version"],
    "prereq-nemoclaw-version",
  );

  const gatewayA = gatewayNameForPort(GATEWAY_PORT_A);
  const gatewayB = gatewayNameForPort(GATEWAY_PORT_B);
  const fake = await startFakeOpenAiCompatibleServer({
    port: Number(process.env.NEMOCLAW_E2E_FAKE_PORT ?? 0),
  });
  await artifacts.target.declare({
    id: "concurrent-gateway-ports",
    boundary: "direct-cli-docker-openshell-multiple-gateways-dashboard-forwards",
    contract: [
      "sandbox A onboards on the default NemoClaw gateway and dashboard port",
      "sandbox B onboards with NEMOCLAW_GATEWAY_PORT on a non-default gateway",
      "both sandboxes, gateways, and dashboard forwards coexist without port collision",
      "destroying sandbox B leaves sandbox A healthy on the default gateway",
    ],
    gatewayA,
    gatewayB,
    fakeBaseUrl: fake.baseUrl,
  });
  cleanup.add("close fake OpenAI-compatible endpoint", async () => {
    await artifacts.writeJson("fake-openai-requests.json", fake.requests());
    await fake.close();
  });
  cleanup.add("remove concurrent gateway sandboxes and gateways", async () => {
    await bestEffortCleanup(host, sandbox, gatewayA, gatewayB);
  });

  await bestEffortCleanup(host, sandbox, gatewayA, gatewayB);

  const onboardA = await runOnboard(
    host,
    SANDBOX_A,
    GATEWAY_PORT_A,
    fake.baseUrl,
    "phase-1-onboard-sandbox-a",
  );
  expect(onboardA.exitCode, resultText(onboardA)).toBe(0);
  const phaseA = await waitForSandboxReady(sandbox, SANDBOX_A, gatewayA, "phase-1-sandbox-a-ready");
  expect(["Ready", "Running"]).toContain(phaseA);

  const listAfterA = await command(host, ["list"], {
    artifactName: "phase-1-nemoclaw-list-after-a",
    timeoutMs: 60_000,
  });
  expect(listAfterA.exitCode, resultText(listAfterA)).toBe(0);
  const dashboardA = dashboardPortFromList(listAfterA.stdout, SANDBOX_A);
  expect(dashboardA, listAfterA.stdout).toBe(DASHBOARD_PORT_A);
  await expectPortListening(host, GATEWAY_PORT_A, "phase-1-gateway-port-a-listening");

  const onboardB = await runOnboard(
    host,
    SANDBOX_B,
    GATEWAY_PORT_B,
    fake.baseUrl,
    "phase-2-onboard-sandbox-b",
  );
  expect(onboardB.exitCode, resultText(onboardB)).toBe(0);

  const phaseAAfterB = await waitForSandboxReady(
    sandbox,
    SANDBOX_A,
    gatewayA,
    "phase-3-sandbox-a-still-ready",
  );
  const phaseBAfterB = await waitForSandboxReady(
    sandbox,
    SANDBOX_B,
    gatewayB,
    "phase-3-sandbox-b-ready",
  );
  expect(["Ready", "Running"]).toContain(phaseAAfterB);
  expect(["Ready", "Running"]).toContain(phaseBAfterB);
  await expectPortListening(host, GATEWAY_PORT_A, "phase-3-gateway-port-a-still-listening");
  await expectPortListening(host, GATEWAY_PORT_B, "phase-3-gateway-port-b-listening");

  const listBoth = await command(host, ["list"], {
    artifactName: "phase-3-nemoclaw-list-both-sandboxes",
    timeoutMs: 60_000,
  });
  expect(listBoth.exitCode, resultText(listBoth)).toBe(0);
  expect(outputIncludesSandbox(listBoth.stdout, SANDBOX_A), listBoth.stdout).toBe(true);
  expect(outputIncludesSandbox(listBoth.stdout, SANDBOX_B), listBoth.stdout).toBe(true);
  const dashboardAAfterB = dashboardPortFromList(listBoth.stdout, SANDBOX_A);
  const dashboardB = dashboardPortFromList(listBoth.stdout, SANDBOX_B);
  expect(dashboardAAfterB, listBoth.stdout).toBe(dashboardA);
  expect(dashboardB, listBoth.stdout).toBeTruthy();
  expect(dashboardB).not.toBe(dashboardA);

  const destroyB = await command(host, [SANDBOX_B, "destroy", "--yes"], {
    artifactName: "phase-4-destroy-sandbox-b",
    env: commandEnv({ NEMOCLAW_GATEWAY_PORT: GATEWAY_PORT_B }),
    timeoutMs: 5 * 60_000,
  });
  expect(destroyB.exitCode, resultText(destroyB)).toBe(0);

  const phaseAAfterDestroyB = await waitForSandboxReady(
    sandbox,
    SANDBOX_A,
    gatewayA,
    "phase-4-sandbox-a-still-ready-after-b-destroy",
  );
  expect(["Ready", "Running"]).toContain(phaseAAfterDestroyB);
  await expectPortListening(host, GATEWAY_PORT_A, "phase-4-gateway-port-a-still-listening");

  await artifacts.target.complete({
    id: "concurrent-gateway-ports",
    assertions: {
      sandboxAOnboarded: onboardA.exitCode === 0,
      sandboxBOnboarded: onboardB.exitCode === 0,
      sandboxAPreserved: ["Ready", "Running"].includes(phaseAAfterB),
      sandboxBReady: ["Ready", "Running"].includes(phaseBAfterB),
      dashboardPortsDistinct: Boolean(dashboardA && dashboardB && dashboardA !== dashboardB),
      sandboxAPreservedAfterDestroyB: ["Ready", "Running"].includes(phaseAAfterDestroyB),
    },
  });
});
