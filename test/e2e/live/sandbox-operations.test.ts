// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, outputContainsSandbox, resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import {
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  phase6Env,
  precleanSandbox,
  redactionValues,
  sandboxSh,
} from "./phase6-messaging-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-sb-ops";
const DASHBOARD_PORT = 18_791;

test(
  "OpenShell owns sandbox stop, start, and delete while native state survives",
  {
    timeout: testTimeout(30 * 60_000),
    meta: {
      e2ePhases: [
        "prepare the sandbox operation fixture",
        "onboard and prove native readiness",
        "write durable sandbox state",
        "stop and start through OpenShell",
        "prove native readiness and state survival",
        "delete through OpenShell and prove absence",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
    const hosted = requireHostedInferenceConfig(secrets);
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
        "OpenShell deletion removes the sandbox",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "sandbox-operations-runtime-provider",
      scenarioLabel: "OpenShell sandbox operations",
    });
    await precleanSandbox(host, SANDBOX_NAME, env, redactions, "sandbox-operations-preclean");
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "sandbox-operations-cleanup-openshell-delete",
        env,
        redactionValues: redactions,
        timeoutMs: 120_000,
      }),
    );

    progress.phase("onboard and prove native readiness");
    const install = await installSandboxOrSkipOnRateLimit(
      host,
      env,
      redactions,
      "sandbox-operations-install",
      skip,
      "NVIDIA endpoint validation was rate-limited before sandbox lifecycle assertions ran",
    );
    assertExitZero(install, "sandbox operations install");
    await expectSandboxReady(
      host,
      SANDBOX_NAME,
      env,
      redactions,
      "sandbox-operations-ready-before-stop",
    );
    await waitForNativeOpenClaw(sandbox, redactions, "before-stop");

    progress.phase("write durable sandbox state");
    const marker = `sandbox-operations-${Date.now()}`;
    const write = await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      `umask 077; printf '%s\\n' '${marker}' > /sandbox/.openclaw/workspace/.sandbox-operations-marker; sync`,
      {
        artifactName: "sandbox-operations-write-marker",
        redactionValues: redactions,
      },
    );
    assertExitZero(write, "write sandbox operations marker");

    progress.phase("stop and start through OpenShell");
    const gateway = process.env.OPENSHELL_GATEWAY ?? "nemoclaw";
    const stop = await sandbox.openshell(["sandbox", "stop", "-g", gateway, SANDBOX_NAME], {
      artifactName: "sandbox-operations-openshell-stop",
      env,
      timeoutMs: 120_000,
    });
    assertExitZero(stop, "OpenShell sandbox stop");
    const start = await sandbox.openshell(["sandbox", "start", "-g", gateway, SANDBOX_NAME], {
      artifactName: "sandbox-operations-openshell-start",
      env,
      timeoutMs: 120_000,
    });
    assertExitZero(start, "OpenShell sandbox start");

    progress.phase("prove native readiness and state survival");
    await expectSandboxReady(
      host,
      SANDBOX_NAME,
      env,
      redactions,
      "sandbox-operations-ready-after-start",
    );
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
    assertExitZero(read, "read sandbox operations marker");
    expect(read.stdout.trim(), resultText(read)).toBe(marker);

    progress.phase("delete through OpenShell and prove absence");
    await sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "sandbox-operations-openshell-delete",
      env,
      redactionValues: redactions,
      timeoutMs: 120_000,
    });
    const list = await sandbox.list({
      artifactName: "sandbox-operations-list-after-delete",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    assertExitZero(list, "OpenShell sandbox list after delete");
    expect(outputContainsSandbox(list, SANDBOX_NAME), resultText(list)).toBe(false);

    await artifacts.target.complete({
      id: "sandbox-operations",
      status: "passed",
      openshellStopStartDelete: true,
      nativeReadinessBeforeAndAfter: true,
      stateSurvived: true,
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
