// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { proveKilledDockerOpenClawRecovery } from "./openclaw-stopped-recovery.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-rebuild-oc";
const DASHBOARD_PORT = 18_792;

function nativePluginInstallScript(): string {
  const packageJson = JSON.stringify({
    name: "@nemoclaw/e2e-rebuild-plugin",
    version: "1.0.0",
    type: "module",
    main: "index.js",
    files: ["index.js", "openclaw.plugin.json"],
    openclaw: { extensions: ["./index.js"] },
    peerDependencies: { openclaw: ">=2026.7.1" },
  });
  const manifest = JSON.stringify({
    id: "e2e-rebuild-plugin",
    name: "E2E Rebuild Plugin",
    version: "1.0.0",
    description: "Native plugin rebuild persistence fixture",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  const entrypoint = `export default { id: "e2e-rebuild-plugin", name: "E2E Rebuild Plugin", version: "1.0.0", register() {} };\n`;
  return [
    "source_dir=/sandbox/e2e-rebuild-plugin-source",
    'rm -rf -- "$source_dir"',
    'mkdir -p -- "$source_dir"',
    `printf '%s' ${shellQuote(packageJson)} > "$source_dir/package.json"`,
    `printf '%s' ${shellQuote(manifest)} > "$source_dir/openclaw.plugin.json"`,
    `printf '%s' ${shellQuote(entrypoint)} > "$source_dir/index.js"`,
    'HOME=/sandbox openclaw plugins install --force --accept-capabilities "$source_dir"',
    "HOME=/sandbox openclaw plugins inspect e2e-rebuild-plugin --json >/dev/null",
  ].join("\n");
}

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
        "recover a killed Docker source",
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
        "workspace state and a native user-installed plugin survive the rebuild",
        "the native OpenClaw health endpoint is ready after restore",
        "Docker Error-state recovery preserves workspace and native plugin state",
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
        [
          `umask 077; mkdir -p /sandbox/.openclaw/workspace; printf '%s\\n' '${marker}' > /sandbox/.openclaw/workspace/.rebuild-state-marker; sync`,
          nativePluginInstallScript(),
        ].join("\n"),
      ),
      {
        artifactName: "rebuild-openclaw-write-marker",
        env,
        redactionValues: redactions,
      },
    );
    assertExitZero(write, "write OpenClaw rebuild marker");

    const rebuildSource = async (artifactName: string) => {
      const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes", "--verbose"], {
        artifactName,
        env,
        redactionValues: redactions,
        timeoutMs: 20 * 60_000,
      });
      assertExitZero(rebuild, "rebuild OpenClaw sandbox");
      expect(resultText(rebuild)).toContain(`Sandbox '${SANDBOX_NAME}' rebuild completed`);
    };
    const verifyRestoredState = async (artifactPrefix: string) => {
      await waitForNativeOpenClaw(sandbox, redactions, artifactPrefix);
      const read = await sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(
          'marker="$(cat /sandbox/.openclaw/workspace/.rebuild-state-marker)"; HOME=/sandbox openclaw plugins inspect e2e-rebuild-plugin --runtime --json >/dev/null; printf "%s\\n" "$marker"',
        ),
        {
          artifactName: `${artifactPrefix}-read-marker`,
          env,
          redactionValues: redactions,
        },
      );
      assertExitZero(read, "read restored OpenClaw marker");
      expect(read.stdout.trim(), resultText(read)).toBe(marker);
    };

    progress.phase("rebuild the sandbox");
    await rebuildSource("rebuild-openclaw-current-managed-image");
    progress.phase("verify restored state and native readiness");
    await verifyRestoredState("rebuild-openclaw");

    progress.phase("recover a killed Docker source");
    await proveKilledDockerOpenClawRecovery(
      sandbox,
      runtimeProvider,
      artifacts,
      SANDBOX_NAME,
      async () => {
        await rebuildSource("rebuild-openclaw-stopped-source");
        await verifyRestoredState("rebuild-openclaw-stopped-source");
      },
      "native-readiness",
    );

    await artifacts.target.complete({
      id: "rebuild-openclaw",
      status: "passed",
      stateRestored: true,
      nativeReady: true,
      staleBaseConstructed: false,
    });
  },
);

async function waitForNativeOpenClaw(
  sandbox: SandboxClient,
  redactions: string[],
  artifactPrefix: string,
): Promise<void> {
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
      artifactName: `${artifactPrefix}-native-ready`,
      env: buildAvailabilityProbeEnv(),
      redactionValues: redactions,
      timeoutMs: 180_000,
    },
  );
  assertExitZero(ready, "native OpenClaw readiness after rebuild");
}
