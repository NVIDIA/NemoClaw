// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

import { isLocalForwardReachable } from "../../../src/lib/actions/sandbox/forward-health.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-legacy-forward-migration";
const DASHBOARD_PORT = Number(process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789");
const GATEWAY_NAME = "nemoclaw";
const TEST_TIMEOUT_MS = 45 * 60_000;

type LegacyForward = {
  sandboxName: string;
  port: number;
  status: string;
};

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_DASHBOARD_PORT: String(DASHBOARD_PORT),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: GATEWAY_NAME,
    ...extra,
  };
}

function legacyForwards(output: string): LegacyForward[] {
  return output
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((columns) => columns.length >= 5 && columns[0]?.toLowerCase() !== "sandbox")
    .map((columns) => ({
      sandboxName: columns[0] ?? "",
      port: Number(columns[2]),
      status: columns.slice(4).join(" ").toLowerCase(),
    }))
    .filter((forward) => Number.isInteger(forward.port));
}

function hasLegacyForward(output: string, sandboxName: string, port: number): boolean {
  return legacyForwards(output).some(
    (forward) =>
      forward.sandboxName === sandboxName &&
      forward.port === port &&
      /running|active/u.test(forward.status),
  );
}

async function unusedLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate an unrelated legacy forward port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForPort(port: number, reachable: boolean): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    if (isLocalForwardReachable(port) === reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `host port ${String(port)} did not become ${reachable ? "reachable" : "released"}`,
  );
}

async function waitForSandboxReady(sandbox: SandboxClient): Promise<void> {
  let lastOutput = "";
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = await sandbox.openshell(
      ["sandbox", "get", SANDBOX_NAME, "--gateway", GATEWAY_NAME],
      {
        artifactName: `legacy-forward-wait-sandbox-ready-${attempt}`,
        env: env(),
        timeoutMs: 30_000,
      },
    );
    lastOutput = resultText(result);
    if (result.exitCode === 0 && /\bReady\b/iu.test(lastOutput)) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`sandbox did not return to Ready after gateway restart: ${lastOutput}`);
}

async function listLegacyForwards(sandbox: SandboxClient, artifactName: string): Promise<string> {
  const result = await sandbox.openshell(["forward", "list", "--gateway", GATEWAY_NAME], {
    artifactName,
    env: env(),
    timeoutMs: 30_000,
  });
  assertExitZero(result, "openshell forward list");
  return resultText(result);
}

async function startLegacyForward(
  sandbox: SandboxClient,
  port: number,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.openshell(
    ["forward", "start", "--background", String(port), SANDBOX_NAME, "--gateway", GATEWAY_NAME],
    { artifactName, env: env(), timeoutMs: 60_000 },
  );
  assertExitZero(result, `openshell forward start ${String(port)} ${SANDBOX_NAME}`);
  await waitForPort(port, true);
}

test(
  "migrates only the registered legacy dashboard forward to ForwardTcp service",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "install and register the sandbox",
        "restart the gateway and seed tracked legacy forwards",
        "recover through the production migration path",
        "verify exact migration and unrelated forward preservation",
        "stop the sandbox and verify natural port release",
      ],
    },
  },
  async ({ artifacts, cleanup, host, lifecycle, progress, sandbox, secrets, skip }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const redactionValues = [hosted.apiKey];

    await artifacts.target.declare({
      id: "legacy-forward-migration",
      boundary: "real-openshell-legacy-forward-to-direct-forwardtcp-service",
      sandboxName: SANDBOX_NAME,
      dashboardPort: DASHBOARD_PORT,
      contracts: [
        "a real tracked openshell forward start --background entry owns the registered dashboard port",
        "normal NemoClaw recovery removes that exact legacy entry and launches ForwardTcp service",
        "an unregistered legacy forward for the same sandbox is preserved",
        "stopping the migrated sandbox releases the ForwardTcp service port naturally",
        "terminal cleanup removes every sandbox, forward, listener, and gateway created by the test",
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "legacy-forward-prereq-docker-info",
      env: env(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for legacy forward migration E2E: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for legacy forward migration E2E");
    }

    await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
      artifactName: "legacy-forward-precleanup-nemoclaw-sandbox",
      env: env(),
    });
    await host
      .cleanupForward(DASHBOARD_PORT, {
        artifactName: "legacy-forward-precleanup-dashboard-forward",
        env: env(),
      })
      .catch(() => undefined);
    await sandbox
      .cleanupSandbox(SANDBOX_NAME, {
        artifactName: "legacy-forward-precleanup-openshell-sandbox",
        env: env(),
        timeoutMs: 60_000,
      })
      .catch(() => undefined);
    await host
      .cleanupGatewayRegistration(GATEWAY_NAME, {
        artifactName: "legacy-forward-precleanup-gateway",
        env: env(),
      })
      .catch(() => undefined);

    cleanup.trackGateway(host, GATEWAY_NAME, {
      artifactName: "legacy-forward-cleanup-gateway",
      env: env(),
      redactionValues,
      timeoutMs: 120_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "legacy-forward-cleanup-openshell-sandbox",
        env: env(),
        redactionValues,
        timeoutMs: 120_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "legacy-forward-cleanup-nemoclaw-sandbox",
      env: env(),
      redactionValues,
      timeoutMs: 15 * 60_000,
    });

    progress.phase("install and register the sandbox");
    const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
      artifactName: "legacy-forward-install-and-onboard",
      cwd: REPO_ROOT,
      env: env({ ...hosted.env, NVIDIA_INFERENCE_API_KEY: hosted.apiKey }),
      redactionValues,
      timeoutMs: 25 * 60_000,
    });
    assertExitZero(install, "install and onboard legacy migration sandbox");
    await waitForPort(DASHBOARD_PORT, true);
    cleanup.trackForward(host, DASHBOARD_PORT, {
      artifactName: "legacy-forward-cleanup-dashboard-forward",
      env: env(),
      timeoutMs: 60_000,
    });

    progress.phase("restart the gateway and seed tracked legacy forwards");
    await lifecycle.restartGatewayRuntime({ delayMs: 3_000 });
    await lifecycle.waitForGatewayConnected({ attempts: 60, intervalMs: 2_000 });
    await waitForSandboxReady(sandbox);
    await waitForPort(DASHBOARD_PORT, false);

    let unrelatedPort = await unusedLoopbackPort();
    while (unrelatedPort === DASHBOARD_PORT) unrelatedPort = await unusedLoopbackPort();
    cleanup.trackForward(host, unrelatedPort, {
      artifactName: "legacy-forward-cleanup-unregistered-forward",
      env: env(),
      timeoutMs: 60_000,
    });
    await startLegacyForward(
      sandbox,
      DASHBOARD_PORT,
      "legacy-forward-seed-registered-dashboard-forward",
    );
    await startLegacyForward(
      sandbox,
      unrelatedPort,
      "legacy-forward-seed-unregistered-sandbox-forward",
    );
    const seeded = await listLegacyForwards(sandbox, "legacy-forward-list-seeded");
    expect(hasLegacyForward(seeded, SANDBOX_NAME, DASHBOARD_PORT), seeded).toBe(true);
    expect(hasLegacyForward(seeded, SANDBOX_NAME, unrelatedPort), seeded).toBe(true);

    progress.phase("recover through the production migration path");
    const recover = await host.nemoclaw([SANDBOX_NAME, "recover"], {
      artifactName: "legacy-forward-nemoclaw-recover",
      env: env(),
      redactionValues,
      timeoutMs: 10 * 60_000,
    });
    assertExitZero(recover, "nemoclaw recover legacy forward migration sandbox");

    progress.phase("verify exact migration and unrelated forward preservation");
    const migrated = await listLegacyForwards(sandbox, "legacy-forward-list-after-migration");
    expect(hasLegacyForward(migrated, SANDBOX_NAME, DASHBOARD_PORT), migrated).toBe(false);
    expect(hasLegacyForward(migrated, SANDBOX_NAME, unrelatedPort), migrated).toBe(true);
    await waitForPort(DASHBOARD_PORT, true);
    await waitForPort(unrelatedPort, true);

    const stopUnrelated = await sandbox.openshell(
      ["forward", "stop", String(unrelatedPort), SANDBOX_NAME, "--gateway", GATEWAY_NAME],
      { artifactName: "legacy-forward-stop-unregistered-forward", env: env(), timeoutMs: 60_000 },
    );
    assertExitZero(stopUnrelated, "stop unrelated legacy forward");
    await waitForPort(unrelatedPort, false);

    progress.phase("stop the sandbox and verify natural port release");
    const stop = await host.nemoclaw([SANDBOX_NAME, "stop"], {
      artifactName: "legacy-forward-stop-migrated-sandbox",
      env: env(),
      redactionValues,
      timeoutMs: 5 * 60_000,
    });
    assertExitZero(stop, "stop migrated sandbox");
    await waitForPort(DASHBOARD_PORT, false);

    await artifacts.target.complete({
      id: "legacy-forward-migration",
      status: "passed",
      assertions: {
        registeredLegacyForwardSeeded: true,
        registeredLegacyForwardRemoved: true,
        unregisteredLegacyForwardPreserved: true,
        forwardTcpServiceReachable: true,
        migratedSandboxPortReleasedAfterStop: true,
      },
    });
  },
);
