// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-rebuild-oc";
const DASHBOARD_PORT = 18_792;

test(
  "rebuild-openclaw restores durable state and native readiness",
  {
    timeout: testTimeout(45 * 60_000),
    meta: {
      e2ePhases: [
        "prepare the OpenClaw rebuild fixture",
        "onboard the exact managed image",
        "write durable OpenClaw state",
        "rebuild the sandbox",
        "verify restored state and native readiness",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const env = {
      ...buildAvailabilityProbeEnv(),
      ...hosted.env,
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_DASHBOARD_PORT: String(DASHBOARD_PORT),
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    };
    const redactions = [hosted.apiKey];

    await artifacts.target.declare({
      id: "rebuild-openclaw",
      boundary: "exact managed OpenClaw rebuild state restoration and native readiness",
      contracts: [
        "rebuild uses the published exact managed image instead of constructing a stale base",
        "workspace state survives the rebuild",
        "the native OpenClaw health endpoint is ready after restore",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "rebuild-openclaw-runtime-provider",
      scenarioLabel: "OpenClaw rebuild",
    });
    try {
      await sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "rebuild-openclaw-preclean-openshell-delete",
        env,
        timeoutMs: 120_000,
      });
    } catch {
      // The named gateway does not exist before first onboarding.
    }
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "rebuild-openclaw-cleanup-openshell-delete",
        env,
        redactionValues: redactions,
        timeoutMs: 120_000,
      }),
    );

    progress.phase("onboard the exact managed image");
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "rebuild-openclaw-install",
      cwd: REPO_ROOT,
      env,
      redactionValues: redactions,
      timeoutMs: execTimeout(20 * 60_000),
    });
    assertExitZero(install, "OpenClaw rebuild install");

    progress.phase("write durable OpenClaw state");
    const marker = `rebuild-openclaw-${Date.now()}`;
    const write = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `umask 077; mkdir -p /sandbox/.openclaw/workspace; printf '%s\\n' '${marker}' > /sandbox/.openclaw/workspace/.rebuild-state-marker; sync`,
      ),
      {
        artifactName: "rebuild-openclaw-write-marker",
        env,
        redactionValues: redactions,
      },
    );
    assertExitZero(write, "write OpenClaw rebuild marker");

    progress.phase("rebuild the sandbox");
    const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes", "--verbose"], {
      artifactName: "rebuild-openclaw-current-managed-image",
      env,
      redactionValues: redactions,
      timeoutMs: 20 * 60_000,
    });
    assertExitZero(rebuild, "rebuild OpenClaw sandbox");
    expect(resultText(rebuild)).toContain(`Sandbox '${SANDBOX_NAME}' rebuild completed`);

    progress.phase("verify restored state and native readiness");
    await waitForNativeOpenClaw(sandbox, redactions);
    const read = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript("cat /sandbox/.openclaw/workspace/.rebuild-state-marker"),
      {
        artifactName: "rebuild-openclaw-read-marker",
        env,
        redactionValues: redactions,
      },
    );
    assertExitZero(read, "read restored OpenClaw marker");
    expect(read.stdout.trim(), resultText(read)).toBe(marker);

    await artifacts.target.complete({
      id: "rebuild-openclaw",
      status: "passed",
      stateRestored: true,
      nativeReady: true,
      staleBaseConstructed: false,
    });
  },
);

async function waitForNativeOpenClaw(sandbox: SandboxClient, redactions: string[]): Promise<void> {
  const ready = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
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
    ),
    {
      artifactName: "rebuild-openclaw-native-ready",
      env: buildAvailabilityProbeEnv(),
      redactionValues: redactions,
      timeoutMs: 180_000,
    },
  );
  assertExitZero(ready, "native OpenClaw readiness after rebuild");
}
