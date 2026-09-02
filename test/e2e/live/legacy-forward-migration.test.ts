// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-legacy-forward";
const DASHBOARD_PORT = Number(process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789");
const UNREGISTERED_PORT = 19_789;
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

async function waitForPort(
  host: HostCliClient,
  port: number,
  reachable: boolean,
  artifactName: string,
): Promise<void> {
  const probe = await host.command(
    "bash",
    [
      "-lc",
      String.raw`set +e
port="$1"
expected="$2"
for _ in $(seq 1 60); do
  node -e '
    const net = require("node:net");
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); process.exit(0); });
    socket.once("error", () => process.exit(1));
    socket.once("timeout", () => { socket.destroy(); process.exit(1); });
  ' "$port" && actual=1 || actual=0
  [ "$actual" = "$expected" ] && exit 0
  sleep 0.5
done
exit 1`,
      "legacy-forward-wait-port",
      String(port),
      reachable ? "1" : "0",
    ],
    { artifactName, env: env(), timeoutMs: 90_000 },
  );
  assertExitZero(
    probe,
    `wait for host port ${String(port)} to become ${reachable ? "reachable" : "released"}`,
  );
}

async function waitForSandboxReady(host: HostCliClient): Promise<void> {
  const ready = await host.command(
    "bash",
    [
      "-lc",
      String.raw`set +e
sandbox_name="$1"
for _ in $(seq 1 60); do
  output="$(openshell sandbox get "$sandbox_name" --gateway nemoclaw 2>&1)" && status=0 || status=$?
  [ "$status" -eq 0 ] && printf '%s\n' "$output" | grep -Eiq '\bReady\b' && exit 0
  sleep 2
done
printf '%s\n' "$output" >&2
exit 1`,
      "legacy-forward-wait-sandbox",
      SANDBOX_NAME,
    ],
    {
      artifactName: "legacy-forward-wait-sandbox-ready",
      env: env(),
      timeoutMs: 150_000,
    },
  );
  assertExitZero(ready, "wait for legacy migration sandbox Ready phase");
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
  host: HostCliClient,
  port: number,
  artifactName: string,
): Promise<void> {
  const result = await host.command(
    "bash",
    [
      "-lc",
      String.raw`set +e
log="$(mktemp)"
trap 'rm -f -- "$log"' EXIT
openshell forward start --background "$1" "$2" --gateway nemoclaw \
  </dev/null >"$log" 2>&1
status=$?
cat "$log"
exit "$status"`,
      "legacy-forward-start",
      String(port),
      SANDBOX_NAME,
    ],
    { artifactName, env: env(), timeoutMs: 60_000 },
  );
  assertExitZero(result, `openshell forward start ${String(port)} ${SANDBOX_NAME}`);
  await waitForPort(host, port, true, `${artifactName}-local-port-reachable`);
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
  async ({ artifacts, cleanup, host, lifecycle, progress, sandbox, secrets }) => {
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
    expect(docker.exitCode, `Docker is required for legacy forward migration E2E`).toBe(0);

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
    await host
      .cleanupForward(UNREGISTERED_PORT, {
        artifactName: "legacy-forward-precleanup-unregistered-forward",
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
    await waitForPort(host, DASHBOARD_PORT, true, "legacy-forward-onboard-dashboard-reachable");
    cleanup.trackForward(host, DASHBOARD_PORT, {
      artifactName: "legacy-forward-cleanup-dashboard-forward",
      env: env(),
      timeoutMs: 60_000,
    });

    progress.phase("restart the gateway and seed tracked legacy forwards");
    await lifecycle.restartGatewayRuntime({ delayMs: 3_000 });
    await lifecycle.waitForGatewayConnected({ attempts: 60, intervalMs: 2_000 });
    await waitForSandboxReady(host);
    await waitForPort(
      host,
      DASHBOARD_PORT,
      false,
      "legacy-forward-direct-service-released-after-gateway-restart",
    );

    cleanup.trackForward(host, UNREGISTERED_PORT, {
      artifactName: "legacy-forward-cleanup-unregistered-forward",
      env: env(),
      timeoutMs: 60_000,
    });
    await startLegacyForward(
      host,
      DASHBOARD_PORT,
      "legacy-forward-seed-registered-dashboard-forward",
    );
    await startLegacyForward(
      host,
      UNREGISTERED_PORT,
      "legacy-forward-seed-unregistered-sandbox-forward",
    );
    const seeded = await listLegacyForwards(sandbox, "legacy-forward-list-seeded");
    expect(hasLegacyForward(seeded, SANDBOX_NAME, DASHBOARD_PORT), seeded).toBe(true);
    expect(hasLegacyForward(seeded, SANDBOX_NAME, UNREGISTERED_PORT), seeded).toBe(true);

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
    expect(hasLegacyForward(migrated, SANDBOX_NAME, UNREGISTERED_PORT), migrated).toBe(true);
    await waitForPort(host, DASHBOARD_PORT, true, "legacy-forward-service-replacement-reachable");
    await waitForPort(
      host,
      UNREGISTERED_PORT,
      true,
      "legacy-forward-unregistered-listener-preserved",
    );

    const stopUnrelated = await sandbox.openshell(
      ["forward", "stop", String(UNREGISTERED_PORT), SANDBOX_NAME, "--gateway", GATEWAY_NAME],
      { artifactName: "legacy-forward-stop-unregistered-forward", env: env(), timeoutMs: 60_000 },
    );
    assertExitZero(stopUnrelated, "stop unrelated legacy forward");
    await waitForPort(
      host,
      UNREGISTERED_PORT,
      false,
      "legacy-forward-unregistered-listener-released",
    );

    progress.phase("stop the sandbox and verify natural port release");
    const stop = await host.nemoclaw([SANDBOX_NAME, "stop"], {
      artifactName: "legacy-forward-stop-migrated-sandbox",
      env: env(),
      redactionValues,
      timeoutMs: 5 * 60_000,
    });
    assertExitZero(stop, "stop migrated sandbox");
    await waitForPort(
      host,
      DASHBOARD_PORT,
      false,
      "legacy-forward-service-released-after-sandbox-stop",
    );

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
