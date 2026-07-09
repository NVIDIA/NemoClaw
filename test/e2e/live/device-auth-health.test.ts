// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the legacy #2342 contract with real install/onboard, sandbox HTTP
 * probes, `nemoclaw status`, host port-forward checks, and gateway recovery:
 * device-auth 401 responses must not be misreported as Health Offline.
 */

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  assertDockerAvailable,
  bestEffort,
  cleanupDeviceAuthSandbox,
  commandEnv,
  DASHBOARD_PORT,
  httpCodeFromSandbox,
  installDeviceAuthSandbox,
  maybeWriteHostHealthExpectation,
  SANDBOX_NAME,
  waitForRecoveryArtifact,
} from "./device-auth-health-helpers.ts";

const LIVE_TIMEOUT_MS = 30 * 60_000;
const INFERENCE_API_KEY = "device-auth-health-fixture-credential";
const INFERENCE_MODEL = "device-auth-health-model";

function assertStatusNotOffline(output: string, context: string): void {
  expect(output, `${context} must not report the #2342 false Health Offline state`).not.toMatch(
    /offline/i,
  );
}

test("device auth health probes treat 401 as live instead of offline (#2342)", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, skip }) => {
  const installLog = artifacts.pathFor("phase-1-install-device-auth-health.log");
  // The sandbox cannot reach runner loopback, so expose the fixture through
  // OpenShell's host bridge while keeping readiness checks local to the runner.
  const inference = await startFakeOpenAiCompatibleServer({
    apiKey: INFERENCE_API_KEY,
    host: "0.0.0.0",
    model: INFERENCE_MODEL,
    publicHost: "host.openshell.internal",
    requireAuth: true,
  });
  cleanup.add("close device-auth compatible inference fixture", async () => {
    await artifacts.writeJson("compatible-inference-requests.json", inference.requests());
    await inference.close();
  });
  const inferenceConfig = {
    apiKey: INFERENCE_API_KEY,
    endpointUrl: inference.baseUrl,
    model: INFERENCE_MODEL,
  };

  await artifacts.target.declare({
    id: "device-auth-health",
    boundary: "install.sh + OpenShell sandbox exec + NemoClaw status + host curl",
    sandboxName: SANDBOX_NAME,
    dashboardPort: DASHBOARD_PORT,
    contracts: [
      "onboard succeeds with device auth enabled",
      "onboard authenticates to the fixture inference endpoint",
      "/health is reachable from inside the sandbox",
      "the authenticated dashboard root may return 401 without being treated as offline",
      "nemoclaw status reports the gateway as live, not Health Offline",
      "status remains non-offline after a gateway kill/recovery attempt",
    ],
  });

  const dockerInfo = await host.command("docker", ["info"], {
    artifactName: "phase-0-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  assertDockerAvailable(dockerInfo, skip);

  cleanup.add(`destroy device-auth sandbox ${SANDBOX_NAME}`, () =>
    cleanupDeviceAuthSandbox(host, sandbox),
  );
  await bestEffort(() => cleanupDeviceAuthSandbox(host, sandbox));

  const install = await installDeviceAuthSandbox(host, inferenceConfig, installLog);
  expect(install.exitCode, resultText(install)).toBe(0);
  expect(inference.requests()).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      model: INFERENCE_MODEL,
      path: "/v1/chat/completions",
    }),
  );

  await host.expectListed(SANDBOX_NAME, {
    artifactName: "phase-1-nemoclaw-list-device-auth-health",
    env: commandEnv(),
    timeoutMs: 60_000,
  });

  const health = await httpCodeFromSandbox(sandbox, "/health", "phase-2-sandbox-health-code");
  expect(health.exitCode, resultText(health)).toBe(0);
  expect(health.stdout.trim()).toBe("200");

  const root = await httpCodeFromSandbox(sandbox, "/", "phase-2-sandbox-root-code");
  expect(root.exitCode, resultText(root)).toBe(0);
  expect(["200", "401"], `dashboard root returned ${root.stdout.trim()}`).toContain(
    root.stdout.trim(),
  );

  const status = await host.nemoclaw([SANDBOX_NAME, "status"], {
    artifactName: "phase-3-nemoclaw-status-device-auth-health",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  expect(status.exitCode, resultText(status)).toBe(0);
  assertStatusNotOffline(resultText(status), "initial status");
  expect(resultText(status)).toMatch(/running|online|healthy|OpenClaw|Ready/i);

  const hostHealth = await host.command(
    "curl",
    [
      "-so",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "5",
      `http://127.0.0.1:${DASHBOARD_PORT}/health`,
    ],
    {
      artifactName: "phase-4-host-health-code",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  await maybeWriteHostHealthExpectation(hostHealth, (codes, message, actual) =>
    expect(codes, message).toContain(actual),
  );

  await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript("pkill -f 'openclaw.*gateway' 2>/dev/null || true"),
    {
      artifactName: "phase-5-kill-gateway-process",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const recoveryStatus = await host.nemoclaw([SANDBOX_NAME, "status"], {
    artifactName: "phase-5-nemoclaw-status-after-gateway-kill",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  expect(recoveryStatus.exitCode, resultText(recoveryStatus)).toBe(0);
  assertStatusNotOffline(resultText(recoveryStatus), "recovery status");
  await waitForRecoveryArtifact(artifacts, sandbox);
});
