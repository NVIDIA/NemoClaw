// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-state-backup";
const DASHBOARD_PORT = 18_792;

test(
  "state-backup-restore: rebuild restores the complete native home",
  {
    timeout: testTimeout(45 * 60_000),
    meta: {
      e2ePhases: [
        "prepare the complete native-home compatibility fixture",
        "onboard the exact managed image",
        "write state across the native home",
        "rebuild from the complete native-home backup",
        "verify native-home state and readiness",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const env = {
      ...buildAvailabilityProbeEnv(),
      ...hosted.env,
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_DASHBOARD_PORT: String(DASHBOARD_PORT),
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    };
    const redactions = [hosted.apiKey];

    await artifacts.target.declare({
      id: "state-backup-restore",
      boundary: "trusted-main compatibility for complete native-home rebuild persistence",
      contracts: [
        "the legacy target exercises the supported rebuild replacement",
        "unknown home, workspace, config, and local-data state survive rebuild",
        "the restored OpenClaw runtime reaches its native health endpoint",
      ],
    });
    await runtimeProvider.requireAvailable({
      artifactName: "state-backup-restore-runtime-provider",
      scenarioLabel: "complete native-home backup compatibility",
    });
    try {
      await sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "state-backup-restore-preclean",
        env,
        timeoutMs: 120_000,
      });
    } catch {
      // The named gateway does not exist before first onboarding.
    }
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "state-backup-restore-cleanup",
        env,
        redactionValues: redactions,
        timeoutMs: 120_000,
      }),
    );

    progress.phase("onboard the exact managed image");
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "state-backup-restore-install",
      cwd: REPO_ROOT,
      env,
      redactionValues: redactions,
      timeoutMs: execTimeout(20 * 60_000),
    });
    assertExitZero(install, "complete native-home compatibility install");

    progress.phase("write state across the native home");
    const marker = `state-backup-restore-${Date.now()}`;
    const markerPaths = [
      "/sandbox/.state-backup-unknown",
      "/sandbox/.openclaw/workspace/.state-backup-workspace",
      "/sandbox/.config/e2e-native-home/marker",
      "/sandbox/.local/share/e2e-native-home/marker",
    ];
    const markerDirectories = markerPaths
      .slice(1)
      .map((target) => target.slice(0, target.lastIndexOf("/")));
    const write = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          "umask 077",
          `mkdir -p ${markerDirectories.map(shellQuote).join(" ")}`,
          `for target in ${markerPaths.map(shellQuote).join(" ")}; do printf '%s\\n' ${shellQuote(marker)} > "$target"; done`,
          "sync",
        ].join("\n"),
      ),
      { artifactName: "state-backup-restore-write", env, redactionValues: redactions },
    );
    assertExitZero(write, "write complete native-home markers");

    progress.phase("rebuild from the complete native-home backup");
    const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes", "--verbose"], {
      artifactName: "state-backup-restore-rebuild",
      env,
      redactionValues: redactions,
      timeoutMs: 20 * 60_000,
    });
    assertExitZero(rebuild, "rebuild from complete native-home backup");

    progress.phase("verify native-home state and readiness");
    const verify = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `for target in ${markerPaths.map(shellQuote).join(" ")}; do test "$(cat "$target")" = ${shellQuote(marker)}; done`,
          "attempt=0",
          'while [ "$attempt" -lt 30 ]; do',
          `  code="$(curl -q --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 http://127.0.0.1:${String(DASHBOARD_PORT)}/health 2>/dev/null || true)"`,
          '  case "$code" in 200|401) break ;; esac',
          "  attempt=$((attempt + 1))",
          "  sleep 5",
          "done",
          'case "$code" in 200|401) ;; *) exit 1 ;; esac',
          `printf '%s\\n' ${shellQuote(marker)}`,
        ].join("\n"),
      ),
      {
        artifactName: "state-backup-restore-verify",
        env,
        redactionValues: redactions,
        timeoutMs: 330_000,
      },
    );
    assertExitZero(verify, "verify complete native-home restore and readiness");
    expect(verify.stdout.trim(), resultText(verify)).toBe(marker);

    await artifacts.target.complete({
      id: "state-backup-restore",
      status: "passed",
      stateRestored: true,
      nativeReady: true,
    });
  },
);
