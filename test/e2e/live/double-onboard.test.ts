// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseOpenShellSandboxId } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { GatewayClient } from "../fixtures/clients/gateway.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SANDBOX_A = process.env.NEMOCLAW_DOUBLE_ONBOARD_SANDBOX_A ?? "e2e-double-a";
const SANDBOX_B = process.env.NEMOCLAW_DOUBLE_ONBOARD_SANDBOX_B ?? "e2e-double-b";
const INSTALL_SANDBOX_NAME = process.env.NEMOCLAW_E2E_INSTALL_SANDBOX_NAME ?? "";
const DASHBOARD_PORT_A = "18789";
const DASHBOARD_PORT_B = "18790";
const PHASE_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_PHASE_TIMEOUT_MS ?? 1_200) * 1_000;
const ONBOARD_TIMEOUT_MS = execTimeout(PHASE_TIMEOUT_MS);
const PROBE_ATTEMPTS = Number(process.env.NEMOCLAW_E2E_PROBE_ATTEMPTS ?? 3);
const PROBE_DELAY_MS = Number(process.env.NEMOCLAW_E2E_PROBE_DELAY_SECONDS ?? 3) * 1_000;
const RECOVERY_PROBE_TIMEOUT_MS =
  Number(process.env.NEMOCLAW_E2E_RECOVERY_PROBE_TIMEOUT_SECONDS ?? 180) * 1_000;
const TEST_TIMEOUT_MS = testTimeout(90 * 60_000);

interface ForwardCleanupTarget {
  port: string;
  sandboxName: string;
}

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;
validateSandboxName(SANDBOX_A);
validateSandboxName(SANDBOX_B);
if (INSTALL_SANDBOX_NAME) validateSandboxName(INSTALL_SANDBOX_NAME);

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

function dashboardPort(sandboxName: string): string {
  return sandboxName === SANDBOX_A ? DASHBOARD_PORT_A : DASHBOARD_PORT_B;
}

function onboardEnv(sandboxName: string, fakeBaseUrl: string): NodeJS.ProcessEnv {
  return commandEnv({
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_AGENT: process.env.NEMOCLAW_AGENT ?? "openclaw",
    NEMOCLAW_HERMES_API_PORT: sandboxName === SANDBOX_A ? process.env.NEMOCLAW_HERMES_API_PORT : "",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_DASHBOARD_PORT: dashboardPort(sandboxName),
    CHAT_UI_URL: "",
  });
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Early cleanup must not replace the failure that triggered cleanup.
  }
}

async function command(
  host: HostCliClient,
  args: string[],
  options: { artifactName: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    env: options.env ?? commandEnv(),
    artifactName: options.artifactName,
    timeoutMs: options.timeoutMs,
  });
}

async function runOnboard(
  host: HostCliClient,
  sandboxName: string,
  fakeBaseUrl: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await command(host, ["onboard", "--non-interactive"], {
    artifactName,
    env: onboardEnv(sandboxName, fakeBaseUrl),
    timeoutMs: ONBOARD_TIMEOUT_MS,
  });
}

async function waitForDashboardReachability(
  host: HostCliClient,
  port: string,
  expectedReachable: boolean,
  artifactPrefix: string,
): Promise<{ reachable: boolean; output: string }> {
  let reachable = false;
  let output = "";
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    const result = await host.command(
      "curl",
      [
        "--silent",
        "--show-error",
        "--fail",
        "--output",
        "/dev/null",
        "--max-time",
        "5",
        `http://127.0.0.1:${port}/`,
      ],
      {
        artifactName: `${artifactPrefix}-attempt-${attempt}`,
        env: commandEnv(),
        timeoutMs: 15_000,
      },
    );
    output = resultText(result);
    reachable = result.exitCode === 0 && !result.timedOut;
    if (reachable === expectedReachable) break;
    if (attempt < PROBE_ATTEMPTS) await sleep(PROBE_DELAY_MS);
  }
  return { reachable, output };
}

async function inspectNoListener(
  host: HostCliClient,
  port: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await host.command("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 15_000,
  });
}

function registryHas(sandboxName: string): boolean {
  if (!fs.existsSync(REGISTRY_FILE)) return false;
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, unknown>;
  };
  return Object.hasOwn(registry.sandboxes ?? {}, sandboxName);
}

async function waitForSandboxAbsent(
  sandbox: SandboxClient,
  sandboxName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      await sandbox.expectAbsent(sandboxName, {
        artifactName: `wait-absent-${sandboxName}`,
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  throw new Error(`OpenShell still lists sandbox '${sandboxName}' after ${timeoutMs}ms.`, {
    cause: lastError,
  });
}

async function cleanupDoubleOnboardResources(
  host: HostCliClient,
  sandbox: SandboxClient,
  forwardTargets: readonly ForwardCleanupTarget[],
): Promise<void> {
  for (const { port, sandboxName } of forwardTargets) {
    await ignoreCleanupError(() =>
      host.cleanupForward(Number(port), {
        artifactName: `cleanup-openshell-forward-stop-${sandboxName}-${port}`,
        env: commandEnv(),
        gatewayName: "nemoclaw",
        sandboxName,
        timeoutMs: 30_000,
      }),
    );
  }
  const names = [INSTALL_SANDBOX_NAME, SANDBOX_A, SANDBOX_B].filter(Boolean);
  for (const name of names) {
    await ignoreCleanupError(() =>
      command(host, [name, "destroy", "--yes"], {
        artifactName: `cleanup-nemoclaw-destroy-${name}`,
        env: commandEnv(),
        timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
      }),
    );
  }
  for (const name of names) {
    await ignoreCleanupError(() =>
      sandbox.cleanupSandbox(name, {
        artifactName: `cleanup-openshell-sandbox-delete-${name}`,
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
  }
}

async function gatewayRuntimeId(gateway: GatewayClient): Promise<string> {
  const runtime = await gateway.resolveHostRuntime();
  return runtime?.kind === "container" ? `${runtime.kind}:${runtime.id}` : (runtime?.kind ?? "");
}

async function prerequisiteOrSkip(
  host: HostCliClient,
  skip: (message: string) => never,
  commandName: string,
  args: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  let result: ShellProbeResult;
  try {
    result = await host.command(commandName, args, {
      artifactName,
      env: commandEnv(),
      timeoutMs: 30_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `${commandName} ${args.join(" ")} is required for double-onboard live E2E: ${detail}`;
    if (process.env.GITHUB_ACTIONS === "true") throw new Error(message);
    skip(message);
  }
  if (result.exitCode === 0) return result;
  const message = `${commandName} ${args.join(" ")} is required for double-onboard live E2E: ${resultText(
    result,
  )}`;
  if (process.env.GITHUB_ACTIONS === "true") throw new Error(message);
  skip(message);
}

test(
  "double-onboard: reuses the gateway, isolates a sibling, and replaces stale state",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate double-onboard lifecycle prerequisites",
        "onboard first sandbox",
        "re-onboard same sandbox on existing gateway",
        "onboard sibling sandbox with isolated dashboard",
        "stop sibling sandbox without disturbing the first forward",
        "replace sandbox after stale registry refusal",
        "remove double-onboard resources",
      ],
    },
  },
  async ({
    artifacts,
    cleanup,
    gateway,
    host,
    lifecycle,
    progress,
    runtimeProvider,
    sandbox,
    skip,
  }) => {
    expect(
      fs.existsSync(CLI_DIST_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI targets",
    ).toBe(true);

    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info",
      scenarioLabel: "double-onboard",
    });
    await prerequisiteOrSkip(
      host,
      skip,
      "bash",
      ["-lc", "command -v openshell"],
      "prereq-openshell",
    );
    await prerequisiteOrSkip(
      host,
      skip,
      process.execPath,
      [CLI_ENTRYPOINT, "--version"],
      "prereq-nemoclaw",
    );

    const fake = await startFakeOpenAiCompatibleServer({
      host: "0.0.0.0",
      port: Number(process.env.NEMOCLAW_FAKE_PORT ?? 0),
      progress,
      publicHost: "host.openshell.internal",
    });
    await artifacts.writeJson("fake-openai.json", { baseUrl: fake.baseUrl });
    cleanup.trackDisposable("close fake OpenAI-compatible endpoint", async () => {
      await artifacts.writeJson("fake-openai-requests.json", fake.requests());
      await fake.close();
    });
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-openshell-gateway-destroy-nemoclaw",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable("stop double-onboard gateway runtime", async () => {
      await lifecycle.stopGatewayRuntime();
    });

    const hermesApiPort =
      process.env.NEMOCLAW_AGENT === "hermes"
        ? (process.env.NEMOCLAW_HERMES_API_PORT ?? "8643")
        : null;
    const forwardTargets: ForwardCleanupTarget[] = [
      ...(INSTALL_SANDBOX_NAME
        ? [{ port: DASHBOARD_PORT_A, sandboxName: INSTALL_SANDBOX_NAME }]
        : []),
      { port: DASHBOARD_PORT_A, sandboxName: SANDBOX_A },
      { port: DASHBOARD_PORT_B, sandboxName: SANDBOX_B },
      ...(hermesApiPort ? [{ port: hermesApiPort, sandboxName: SANDBOX_A }] : []),
    ];
    const forwardPorts = [...new Set(forwardTargets.map(({ port }) => port))];
    const cleanupSandboxNames = [INSTALL_SANDBOX_NAME, SANDBOX_A, SANDBOX_B].filter(Boolean);
    [...cleanupSandboxNames].reverse().forEach((name) => {
      cleanup.trackDisposable(`delete OpenShell sandbox ${name}`, () =>
        sandbox.cleanupSandbox(name, {
          artifactName: `cleanup-openshell-sandbox-delete-${name}`,
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
      cleanup.trackSandbox(host, name, {
        artifactName: `cleanup-nemoclaw-destroy-${name}`,
        env: commandEnv(),
        timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
      });
    });
    forwardTargets.forEach(({ port, sandboxName }) => {
      cleanup.trackForward(host, Number(port), {
        artifactName: `cleanup-openshell-forward-stop-${sandboxName}-${port}`,
        env: commandEnv(),
        gatewayName: "nemoclaw",
        sandboxName,
        timeoutMs: 30_000,
      });
    });

    await artifacts.target.declare({
      id: "double-onboard",
      boundary: "direct-cli-openshell-lifecycle",
      contract: [
        "same-name onboarding reuses the live gateway and sandbox",
        "a sibling sandbox keeps a separate owned dashboard forward",
        "stopping the sibling releases only its dashboard forward",
        "status and connect preserve a stale local registration",
        "explicit removal permits a clean replacement and complete cleanup",
      ],
    });

    await cleanupDoubleOnboardResources(host, sandbox, forwardTargets);
    await lifecycle.stopGatewayRuntime();
    await ignoreCleanupError(() =>
      host.cleanupGatewayRegistration("nemoclaw", {
        artifactName: "cleanup-openshell-gateway-destroy-nemoclaw",
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );

    progress.phase("onboard first sandbox");
    const first = await runOnboard(host, SANDBOX_A, fake.baseUrl, "phase-2-first-onboard");
    expect(first.exitCode, resultText(first)).toBe(0);

    const gatewayBeforeReuse = await gatewayRuntimeId(gateway);
    expect(gatewayBeforeReuse, "gateway runtime id after first onboard").not.toBe("");
    const sandboxAAfterFirst = await sandbox.openshell(["sandbox", "get", SANDBOX_A], {
      artifactName: "phase-2-openshell-sandbox-a-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxAAfterFirst.exitCode, resultText(sandboxAAfterFirst)).toBe(0);
    const sandboxAIdBeforeReuse = parseOpenShellSandboxId(resultText(sandboxAAfterFirst));
    expect(sandboxAIdBeforeReuse, resultText(sandboxAAfterFirst)).not.toBeNull();
    expect(registryHas(SANDBOX_A), `${REGISTRY_FILE} missing ${SANDBOX_A}`).toBe(true);

    progress.phase("re-onboard same sandbox on existing gateway");
    const second = await runOnboard(host, SANDBOX_A, fake.baseUrl, "phase-3-second-onboard");
    expect(second.exitCode, resultText(second)).toBe(0);
    const gatewayAfterReuse = await gatewayRuntimeId(gateway);
    expect(gatewayAfterReuse).toBe(gatewayBeforeReuse);

    const sandboxAAfterSecond = await sandbox.openshell(["sandbox", "get", SANDBOX_A], {
      artifactName: "phase-3-openshell-sandbox-a-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxAAfterSecond.exitCode, resultText(sandboxAAfterSecond)).toBe(0);
    const sandboxAIdAfterReuse = parseOpenShellSandboxId(resultText(sandboxAAfterSecond));
    expect(sandboxAIdAfterReuse).toBe(sandboxAIdBeforeReuse);

    const dashboardAfterReuse = await waitForDashboardReachability(
      host,
      DASHBOARD_PORT_A,
      true,
      "phase-3-dashboard-after-second-onboard",
    );
    expect(dashboardAfterReuse.reachable, dashboardAfterReuse.output).toBe(true);
    const dashboardListenerAfterReuse = await host.inspectOpenShellForwardListener(
      DASHBOARD_PORT_A,
      SANDBOX_A,
      {
        artifactName: "phase-3-dashboard-listener-after-second-onboard",
        env: commandEnv(),
      },
    );
    expect(dashboardListenerAfterReuse.valid, dashboardListenerAfterReuse.output).toBe(true);

    let hermesApiForwardOwned = true;
    if (hermesApiPort) {
      const apiListenerAfterReuse = await host.inspectOpenShellForwardListener(
        hermesApiPort,
        SANDBOX_A,
        {
          artifactName: "phase-3-api-listener-after-second-onboard",
          env: commandEnv(),
        },
      );
      hermesApiForwardOwned = apiListenerAfterReuse.valid;
      expect(hermesApiForwardOwned, apiListenerAfterReuse.output).toBe(true);
    }

    progress.phase("onboard sibling sandbox with isolated dashboard");
    const sibling = await runOnboard(host, SANDBOX_B, fake.baseUrl, "phase-4-sibling-onboard");
    expect(sibling.exitCode, resultText(sibling)).toBe(0);
    await sandbox.expectListed(SANDBOX_A, {
      artifactName: "phase-4-openshell-sandbox-a-listed",
      env: commandEnv(),
    });
    await sandbox.expectListed(SANDBOX_B, {
      artifactName: "phase-4-openshell-sandbox-b-listed",
      env: commandEnv(),
    });

    const dashboardABeforeStop = await waitForDashboardReachability(
      host,
      DASHBOARD_PORT_A,
      true,
      "phase-4-dashboard-a-before-stop",
    );
    const dashboardBBeforeStop = await waitForDashboardReachability(
      host,
      DASHBOARD_PORT_B,
      true,
      "phase-4-dashboard-b-before-stop",
    );
    expect(dashboardABeforeStop.reachable, dashboardABeforeStop.output).toBe(true);
    expect(dashboardBBeforeStop.reachable, dashboardBBeforeStop.output).toBe(true);
    const listenerBBeforeStop = await host.inspectOpenShellForwardListener(
      DASHBOARD_PORT_B,
      SANDBOX_B,
      {
        artifactName: "phase-4-dashboard-listener-b-before-stop",
        env: commandEnv(),
      },
    );
    expect(listenerBBeforeStop.valid, listenerBBeforeStop.output).toBe(true);

    progress.phase("stop sibling sandbox without disturbing the first forward");
    const stopB = await command(host, [SANDBOX_B, "stop"], {
      artifactName: "phase-5-nemoclaw-stop-sandbox-b",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(stopB.exitCode, resultText(stopB)).toBe(0);

    const releasedForwardB = await waitForDashboardReachability(
      host,
      DASHBOARD_PORT_B,
      false,
      "phase-5-dashboard-b-after-stop",
    );
    const listenerBAfterStop = await inspectNoListener(
      host,
      DASHBOARD_PORT_B,
      "phase-5-dashboard-listener-b-after-stop",
    );
    expect(releasedForwardB.reachable, releasedForwardB.output).toBe(false);
    expect(listenerBAfterStop.exitCode, resultText(listenerBAfterStop)).toBe(1);
    expect(listenerBAfterStop.timedOut, resultText(listenerBAfterStop)).toBe(false);

    const retainedForwardAAfterStop = await waitForDashboardReachability(
      host,
      DASHBOARD_PORT_A,
      true,
      "phase-5-dashboard-a-after-b-stop",
    );
    const listenerAAfterStop = await host.inspectOpenShellForwardListener(
      DASHBOARD_PORT_A,
      SANDBOX_A,
      {
        artifactName: "phase-5-dashboard-listener-a-after-b-stop",
        env: commandEnv(),
      },
    );
    expect(retainedForwardAAfterStop.reachable, retainedForwardAAfterStop.output).toBe(true);
    expect(listenerAAfterStop.valid, listenerAAfterStop.output).toBe(true);

    progress.phase("replace sandbox after stale registry refusal");
    const directDeleteA = await sandbox.openshell(["sandbox", "delete", SANDBOX_A], {
      artifactName: "phase-6-delete-sandbox-a-directly",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(directDeleteA.exitCode, resultText(directDeleteA)).toBe(0);
    await waitForSandboxAbsent(sandbox, SANDBOX_A, 60_000);
    expect(registryHas(SANDBOX_A), "direct deletion removed sandbox A registration").toBe(true);

    const staleStatus = await command(host, [SANDBOX_A, "status"], {
      artifactName: "phase-6-stale-status",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(staleStatus.exitCode, resultText(staleStatus)).toBe(1);
    expect(registryHas(SANDBOX_A), "status removed sandbox A registration").toBe(true);

    const staleConnect = await command(host, [SANDBOX_A, "connect"], {
      artifactName: "phase-6-stale-connect",
      env: commandEnv(),
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    expect(staleConnect.exitCode, resultText(staleConnect)).toBe(1);
    expect(registryHas(SANDBOX_A), "connect removed sandbox A registration").toBe(true);

    const removeStale = await command(host, [SANDBOX_A, "destroy", "--yes"], {
      artifactName: "phase-6-remove-stale-registry-a",
      env: commandEnv(),
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    expect(removeStale.exitCode, resultText(removeStale)).toBe(0);
    expect(registryHas(SANDBOX_A), "destroy kept sandbox A registration").toBe(false);

    const replacement = await runOnboard(
      host,
      SANDBOX_A,
      fake.baseUrl,
      "phase-6-clean-replacement-onboard",
    );
    expect(replacement.exitCode, resultText(replacement)).toBe(0);
    await sandbox.expectListed(SANDBOX_A, {
      artifactName: "phase-6-openshell-sandbox-a-replacement-listed",
      env: commandEnv(),
    });
    expect(registryHas(SANDBOX_A), "replacement did not register sandbox A").toBe(true);

    progress.phase("remove double-onboard resources");
    await cleanupDoubleOnboardResources(host, sandbox, forwardTargets);
    await waitForSandboxAbsent(sandbox, SANDBOX_A, 60_000);
    await waitForSandboxAbsent(sandbox, SANDBOX_B, 60_000);
    expect(
      registryHas(SANDBOX_A) || registryHas(SANDBOX_B),
      "registry still contains test entries",
    ).toBe(false);

    const remainingListeners = await Promise.all(
      forwardPorts.map((port) => inspectNoListener(host, port, `phase-7-final-listener-${port}`)),
    );
    remainingListeners.forEach((listener) => {
      expect(listener.exitCode, resultText(listener)).toBe(1);
      expect(listener.timedOut, resultText(listener)).toBe(false);
    });

    await artifacts.target.complete({
      id: "double-onboard",
      fakeOpenAiRequests: fake.requests(),
      assertions: {
        gatewayReused: gatewayAfterReuse === gatewayBeforeReuse,
        sandboxReused: sandboxAIdAfterReuse === sandboxAIdBeforeReuse,
        dashboardForwardOwnedAfterReuse:
          dashboardAfterReuse.reachable && dashboardListenerAfterReuse.valid,
        hermesApiForwardOwned,
        siblingForwardIsolated:
          !releasedForwardB.reachable &&
          retainedForwardAAfterStop.reachable &&
          listenerAAfterStop.valid,
        staleRegistrationRecovered: replacement.exitCode === 0,
        cleanupComplete:
          !registryHas(SANDBOX_A) &&
          !registryHas(SANDBOX_B) &&
          remainingListeners.every((listener) => listener.exitCode === 1 && !listener.timedOut),
      },
    });
  },
);
