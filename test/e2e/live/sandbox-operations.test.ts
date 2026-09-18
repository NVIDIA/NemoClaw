// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeout } from "../../helpers/timeouts.ts";
import { removeSandbox } from "../../../src/lib/state/registry.ts";
import { assertExitCode, assertExitZero, resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { cleanupUnlessVerified } from "../fixtures/cleanup-resources.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import {
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  phase6Env,
  precleanSandbox,
  redactionValues,
  sandboxSh,
} from "./phase6-messaging-helpers.ts";
import { isNvidiaEndpointRateLimitFailure } from "./messaging-providers-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-sb-ops";
const SURVIVOR_SANDBOX_NAME = `${SANDBOX_NAME}-survivor`;
const DASHBOARD_PORT = 18_791;
const SURVIVOR_DASHBOARD_PORT = 18_792;
const FINAL_DESTROY_TIMEOUT_MS = 60_000;

test(
  "OpenShell preserves sandbox lifecycle and fail-closed final gateway cleanup",
  {
    timeout: testTimeout(90 * 60_000),
    meta: {
      e2ePhases: [
        "prepare the sandbox operation fixture",
        "onboard and prove native readiness",
        "write durable sandbox state",
        "stop and start through OpenShell",
        "prove native readiness and state survival",
        "preserve the gateway for an unregistered live sandbox",
        "destroy the final sandbox and remove the gateway",
      ],
    },
  },
  async ({
    artifacts,
    cleanup,
    gateway,
    host,
    progress,
    runtimeProvider,
    sandbox,
    secrets,
    skip,
  }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const gatewayName = process.env.OPENSHELL_GATEWAY ?? "nemoclaw";
    const env = phase6Env({
      agent: "openclaw",
      apiKey: hosted.apiKey,
      sandboxName: SANDBOX_NAME,
      extra: { NEMOCLAW_DASHBOARD_PORT: String(DASHBOARD_PORT) },
    });
    const redactions = redactionValues(hosted.apiKey);

    await artifacts.target.declare({
      id: "sandbox-operations",
      boundary: "OpenShell sandbox stop/start/delete with native OpenClaw readiness",
      contracts: [
        "OpenShell is the only lifecycle actor for stop, start, and delete",
        "native OpenClaw readiness is checked without assuming process replacement",
        "sandbox state survives OpenShell stop/start",
        "final cleanup preserves the gateway when an unregistered live sandbox remains",
        "final cleanup removes the gateway after bounded live-sandbox confirmation",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "sandbox-operations-runtime-provider",
      scenarioLabel: "OpenShell sandbox operations",
    });
    await precleanSandbox(host, SANDBOX_NAME, env, redactions, "sandbox-operations-preclean");
    const survivorEnv = phase6Env({
      agent: "openclaw",
      apiKey: hosted.apiKey,
      sandboxName: SURVIVOR_SANDBOX_NAME,
      extra: { NEMOCLAW_DASHBOARD_PORT: String(SURVIVOR_DASHBOARD_PORT) },
    });
    await precleanSandbox(
      host,
      SURVIVOR_SANDBOX_NAME,
      survivorEnv,
      redactions,
      "sandbox-operations-survivor-preclean",
    );
    let finalGatewayRemovalVerified = false;
    cleanup.trackDisposable(`remove OpenShell gateway ${gatewayName}`, () =>
      host.cleanupGatewayRegistration(gatewayName, {
        artifactName: "sandbox-operations-cleanup-gateway",
        env,
        redactionValues: redactions,
        timeoutMs: 120_000,
      }),
    );
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      cleanupUnlessVerified(finalGatewayRemovalVerified, () =>
        sandbox.cleanupSandbox(SANDBOX_NAME, {
          artifactName: "sandbox-operations-cleanup-openshell-delete",
          env,
          redactionValues: redactions,
          timeoutMs: 120_000,
        }),
      ),
    );
    cleanup.trackDisposable(`delete OpenShell sandbox ${SURVIVOR_SANDBOX_NAME}`, () =>
      cleanupUnlessVerified(finalGatewayRemovalVerified, () =>
        sandbox.cleanupSandbox(SURVIVOR_SANDBOX_NAME, {
          artifactName: "sandbox-operations-survivor-cleanup-openshell-delete",
          env: survivorEnv,
          redactionValues: redactions,
          timeoutMs: 120_000,
        }),
      ),
    );

    progress.phase("onboard and prove native readiness");
    await installSandboxOrSkipOnRateLimit(
      host,
      env,
      redactions,
      "sandbox-operations-install",
      skip,
      "NVIDIA endpoint validation was rate-limited before sandbox lifecycle assertions ran",
    );

    progress.phase("write durable sandbox state");
    const marker = `sandbox-operations-${Date.now()}`;
    await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      `umask 077; printf '%s\\n' '${marker}' > /sandbox/.openclaw/workspace/.sandbox-operations-marker; sync`,
      {
        artifactName: "sandbox-operations-write-marker",
        redactionValues: redactions,
      },
    );

    progress.phase("stop and start through OpenShell");
    const stop = await sandbox.openshell(["sandbox", "stop", "-g", gatewayName, SANDBOX_NAME], {
      artifactName: "sandbox-operations-openshell-stop",
      env,
      timeoutMs: 120_000,
    });
    assertExitZero(stop, "OpenShell sandbox stop");
    const start = await sandbox.openshell(["sandbox", "start", "-g", gatewayName, SANDBOX_NAME], {
      artifactName: "sandbox-operations-openshell-start",
      env,
      timeoutMs: 120_000,
    });
    assertExitZero(start, "OpenShell sandbox start");

    progress.phase("prove native readiness and state survival");
    await waitForNativeOpenClaw(sandbox, redactions, "after-start");
    const read = await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      "cat /sandbox/.openclaw/workspace/.sandbox-operations-marker",
      {
        artifactName: "sandbox-operations-read-marker",
        redactionValues: redactions,
      },
    );
    expect(read.stdout.trim(), resultText(read)).toBe(marker);

    progress.phase("preserve the gateway for an unregistered live sandbox");
    const survivorOnboard = await host.nemoclaw(["onboard", "--non-interactive"], {
      artifactName: "sandbox-operations-survivor-onboard",
      env: survivorEnv,
      redactionValues: redactions,
      timeoutMs: FINAL_DESTROY_TIMEOUT_MS * 10,
    });
    survivorOnboard.exitCode !== 0 &&
      isNvidiaEndpointRateLimitFailure(resultText(survivorOnboard)) &&
      skip("NVIDIA endpoint validation was rate-limited before final cleanup assertions ran");
    await expectSandboxReady(
      host,
      SURVIVOR_SANDBOX_NAME,
      survivorEnv,
      redactions,
      "sandbox-operations-survivor-ready",
    );
    removeSandbox(SURVIVOR_SANDBOX_NAME);

    const preserved = await host.nemoclaw([SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"], {
      artifactName: "sandbox-operations-destroy-preserves-live-gateway",
      env,
      redactionValues: redactions,
      timeoutMs: FINAL_DESTROY_TIMEOUT_MS,
    });
    const preservedText = resultText(preserved);
    assertExitCode(preserved, 1, "destroy with an unregistered live sandbox");
    expect(preservedText).toMatch(
      new RegExp(
        `Shared NemoClaw gateway left running[\\s\\S]*--cleanup-gateway was not applied[\\s\\S]*${SURVIVOR_SANDBOX_NAME}[\\s\\S]*openshell sandbox list -g ${gatewayName}[\\s\\S]*openshell gateway remove ${gatewayName}`,
      ),
    );
    await gateway.expectOpenshellStatusConnected(gatewayName, {
      artifactName: "sandbox-operations-gateway-preserved",
      env,
      redactionValues: redactions,
    });

    await sandbox.cleanupSandbox(SURVIVOR_SANDBOX_NAME, {
      artifactName: "sandbox-operations-remove-survivor",
      env: survivorEnv,
      redactionValues: redactions,
      timeoutMs: 120_000,
    });
    await host.cleanupGatewayRegistration(gatewayName, {
      artifactName: "sandbox-operations-reset-gateway",
      env,
      redactionValues: redactions,
      timeoutMs: 120_000,
    });

    progress.phase("destroy the final sandbox and remove the gateway");
    await installSandboxOrSkipOnRateLimit(
      host,
      env,
      redactions,
      "sandbox-operations-final-install",
      skip,
      "NVIDIA endpoint validation was rate-limited before final gateway cleanup ran",
    );
    await expectSandboxReady(host, SANDBOX_NAME, env, redactions, "sandbox-operations-final-ready");
    const finalDestroyStartedAt = Date.now();
    const finalDestroy = await host.nemoclaw(
      [SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"],
      {
        artifactName: "sandbox-operations-final-destroy-cleanup-gateway",
        env,
        redactionValues: redactions,
        timeoutMs: FINAL_DESTROY_TIMEOUT_MS,
      },
    );
    const finalDestroyElapsedMs = Date.now() - finalDestroyStartedAt;
    assertExitZero(finalDestroy, "final sandbox destroy with gateway cleanup");
    await gateway.expectRemoved(gatewayName, {
      artifactName: "sandbox-operations-gateway-removed",
      env,
      redactionValues: redactions,
    });
    finalGatewayRemovalVerified = true;

    await artifacts.target.complete({
      id: "sandbox-operations",
      status: "passed",
      openshellStopStartDelete: true,
      nativeReadinessBeforeAndAfter: true,
      stateSurvived: true,
      preservedGatewayForUnregisteredLiveSandbox: true,
      finalCleanupElapsedMs: finalDestroyElapsedMs,
      finalGatewayRemoved: true,
    });
  },
);

async function waitForNativeOpenClaw(
  sandbox: Parameters<typeof sandboxSh>[0],
  redactions: string[],
  suffix: string,
): Promise<void> {
  const ready = await sandboxSh(
    sandbox,
    SANDBOX_NAME,
    [
      "set -eu",
      "attempt=0",
      'while [ "$attempt" -lt 30 ]; do',
      `  code="$(curl -q --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 http://127.0.0.1:${String(DASHBOARD_PORT)}/health 2>/dev/null || true)"`,
      '  case "$code" in 200|401) printf "native-ready\\n"; exit 0 ;; esac',
      "  attempt=$((attempt + 1))",
      "  sleep 5",
      "done",
      "exit 1",
    ].join("\n"),
    {
      artifactName: `sandbox-operations-native-ready-${suffix}`,
      redactionValues: redactions,
      timeoutMs: 180_000,
    },
  );
  assertExitZero(ready, `native OpenClaw readiness ${suffix}`);
}
