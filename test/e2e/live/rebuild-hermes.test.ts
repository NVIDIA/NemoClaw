// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeout } from "../../helpers/timeouts.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
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

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-rebuild-hermes";

test(
  "rebuild-hermes restores durable state and native readiness",
  {
    timeout: testTimeout(45 * 60_000),
    meta: {
      e2ePhases: [
        "prepare the Hermes rebuild fixture",
        "onboard the exact managed image",
        "write durable Hermes state",
        "rebuild the sandbox",
        "verify restored state and native readiness",
      ],
    },
  },
  async ({
    artifacts,
    cleanup,
    host,
    lifecycle,
    progress,
    runtimeProvider,
    sandbox,
    secrets,
    skip,
  }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const env = phase6Env({
      agent: "hermes",
      apiKey: hosted.apiKey,
      sandboxName: SANDBOX_NAME,
      extra: { NEMOCLAW_DASHBOARD_PORT: "18796" },
    });
    const redactions = redactionValues(hosted.apiKey);

    await artifacts.target.declare({
      id: "rebuild-hermes",
      boundary: "exact managed Hermes rebuild state restoration and native readiness",
      contracts: [
        "rebuild uses the published exact managed image without stale controller fixtures",
        "Hermes memory state survives the rebuild",
        "the native Hermes health endpoint is ready after restore",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "rebuild-hermes-runtime-provider",
      scenarioLabel: "Hermes rebuild",
    });
    await precleanSandbox(host, SANDBOX_NAME, env, redactions, "rebuild-hermes-preclean");
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "rebuild-hermes-cleanup-openshell-delete",
        env,
        redactionValues: redactions,
        timeoutMs: 120_000,
      }),
    );

    progress.phase("onboard the exact managed image");
    const install = await installSandboxOrSkipOnRateLimit(
      host,
      env,
      redactions,
      "rebuild-hermes-install",
      skip,
      "NVIDIA endpoint validation was rate-limited before Hermes rebuild assertions ran",
    );
    assertExitZero(install, "Hermes rebuild install");
    await expectSandboxReady(
      host,
      SANDBOX_NAME,
      env,
      redactions,
      "rebuild-hermes-ready-before-rebuild",
    );

    progress.phase("write durable Hermes state");
    const marker = `rebuild-hermes-${Date.now()}`;
    const write = await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      `umask 077; mkdir -p /sandbox/.hermes/memories; printf '%s\\n' '${marker}' > /sandbox/.hermes/memories/.rebuild-state-marker; sync`,
      { artifactName: "rebuild-hermes-write-marker", redactionValues: redactions },
    );
    assertExitZero(write, "write Hermes rebuild marker");

    progress.phase("rebuild the sandbox");
    const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes", "--verbose"], {
      artifactName: "rebuild-hermes-current-managed-image",
      env,
      redactionValues: redactions,
      timeoutMs: 20 * 60_000,
    });
    const rebuildOutput = resultText(rebuild);
    expect(
      rebuild.exitCode === 0 || /Restore result: success=true/u.test(rebuildOutput),
      rebuildOutput,
    ).toBe(true);

    progress.phase("verify restored state and native readiness");
    await lifecycle.assertSandboxReadyAfterRebuild(SANDBOX_NAME, {
      artifactNamePrefix: "rebuild-hermes-ready-after-rebuild",
      env,
    });
    await waitForNativeHermes(sandbox, redactions);
    const read = await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      "cat /sandbox/.hermes/memories/.rebuild-state-marker",
      { artifactName: "rebuild-hermes-read-marker", redactionValues: redactions },
    );
    assertExitZero(read, "read restored Hermes marker");
    expect(read.stdout.trim(), resultText(read)).toBe(marker);

    await artifacts.target.complete({
      id: "rebuild-hermes",
      status: "passed",
      stateRestored: true,
      nativeReady: true,
      staleControllerRecovery: false,
    });
  },
);

async function waitForNativeHermes(
  sandbox: Parameters<typeof sandboxSh>[0],
  redactions: string[],
): Promise<void> {
  const ready = await sandboxSh(
    sandbox,
    SANDBOX_NAME,
    [
      "set -eu",
      "attempt=0",
      'while [ "$attempt" -lt 30 ]; do',
      "  code=\"$(curl -q --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 http://127.0.0.1:8642/health 2>/dev/null || true)\"",
      '  case "$code" in 200|401) printf "native-ready\\n"; exit 0 ;; esac',
      "  attempt=$((attempt + 1))",
      "  sleep 5",
      "done",
      "exit 1",
    ].join("\n"),
    {
      artifactName: "rebuild-hermes-native-ready",
      redactionValues: redactions,
      timeoutMs: 180_000,
    },
  );
  assertExitZero(ready, "native Hermes readiness after rebuild");
}
