// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test, type E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { STOPPED_CONTAINER_STARTUP_LOG_READER } from "../fixtures/stopped-container-startup-log.ts";
import {
  OPENCLAW_RESTORE_HOST_PROGRAM,
  OPENCLAW_RESTORE_NATIVE_PROGRAM,
  OPENCLAW_RESTORE_SUITE_TIMEOUT_MS,
  createOpenClawRestoreDeadline,
  openClawRestoreFixture,
  type OpenClawRestoreScenario,
} from "../fixtures/openclaw-restore-fixture.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-state-backup";
const DASHBOARD_PORT = 18_792;
// Leave the existing job time for setup, both cleanup callbacks, and artifact upload.
const restoreDeadline = createOpenClawRestoreDeadline(
  testTimeout(OPENCLAW_RESTORE_SUITE_TIMEOUT_MS) - 60_000,
);

const restoreOptions = {
  timeout: testTimeout(OPENCLAW_RESTORE_SUITE_TIMEOUT_MS),
  meta: {
    e2ePhases: [
      "prepare the complete native-home compatibility fixture",
      "onboard the exact managed image",
      "write state across the native home",
      "prepare native state while the production backup gate holds the gateway",
      "rebuild from the complete native-home backup",
      "verify the exact original rebuild backup",
      "verify native-home state and readiness",
    ],
  },
};

async function rebuildFixture(
  scenario: OpenClawRestoreScenario,
  {
    artifacts,
    cleanup,
    host,
    progress,
    runtimeProvider,
    sandbox,
    secrets,
  }: Pick<
    E2ETargetFixtures,
    "artifacts" | "cleanup" | "host" | "progress" | "runtimeProvider" | "sandbox" | "secrets"
  >,
) {
  const sandboxName = scenario === "legacy" ? SANDBOX_NAME : `${SANDBOX_NAME}-r`;
  const deadline = restoreDeadline();
  const bounded = (cap: number) => {
    const remaining = Math.floor(deadline - performance.now());
    expect(remaining, "restore scenario exhausted its existing test budget").toBeGreaterThan(0);
    return Math.min(cap, remaining);
  };
  const hosted = requireHostedInferenceConfig(secrets);
  const env = {
    ...buildAvailabilityProbeEnv(),
    ...hosted.env,
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_DASHBOARD_PORT: String(DASHBOARD_PORT),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  const redactions = [hosted.apiKey];

  await artifacts.target.declare({
    id: "state-backup-restore",
    boundary: "real OpenShell rebuild, native legacy migrations, and retained recovery backup",
    contracts: [
      "the legacy target exercises the supported rebuild replacement",
      "unknown home, workspace, config, and local-data state survive rebuild",
      scenario === "legacy"
        ? "9.5/9.7 migrate legacy replay and sticker state before the restored 10.5 gateway becomes ready"
        : "startup refuses retained nonempty Telegram state and preserves the exact recovery backup",
    ],
  });
  await runtimeProvider.requireAvailable({
    artifactName: "state-backup-restore-runtime-provider",
    scenarioLabel: "complete native-home backup compatibility",
  });
  await sandbox.cleanupSandboxBeforeOnboard(sandboxName, {
    artifactName: "state-backup-restore-preclean",
    env,
    redactionValues: redactions,
    timeoutMs: bounded(120_000),
  });
  cleanup.trackDisposable(`destroy NemoClaw sandbox ${sandboxName}`, () =>
    host.cleanupSandbox(sandboxName, {
      artifactName: "state-backup-restore-cleanup",
      preserveGatewayRegistration: true,
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
    timeoutMs: bounded(execTimeout(20 * 60_000)),
  });
  await host.recordSandboxContainerDiscoveryOnFailure(sandboxName, install.exitCode, redactions);
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
    sandboxName,
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

  progress.phase("prepare native state while the production backup gate holds the gateway");
  const fixture = openClawRestoreFixture(marker);
  const hostFixture = async (mode: string, extra: Record<string, unknown> = {}, cap = 60_000) => {
    const result = await host.command(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        OPENCLAW_RESTORE_HOST_PROGRAM,
        JSON.stringify({ mode, sandboxName, gatewayName: env.OPENSHELL_GATEWAY, ...extra }),
      ],
      {
        artifactName: `state-backup-restore-${mode}`,
        cwd: REPO_ROOT,
        env,
        redactionValues: redactions,
        timeoutMs: bounded(cap),
      },
    );
    assertExitZero(result, `restore fixture ${mode}`);
    return JSON.parse(result.stdout);
  };
  const before = await hostFixture("list");
  await hostFixture("quiesce", {}, 8 * 60_000);
  const nativeInput = {
    scenario,
    stateRoot: "/sandbox/.openclaw",
    readyPath: "/tmp/nemoclaw-post-upgrade-doctor-ready",
    startupLog: "/tmp/nemoclaw-start.log",
    marker,
    fixture,
  };
  const prepare = await sandbox.exec(
    sandboxName,
    [
      "node",
      "-e",
      OPENCLAW_RESTORE_NATIVE_PROGRAM,
      JSON.stringify({ ...nativeInput, mode: "prepare" }),
    ],
    {
      artifactName: "state-backup-restore-native-fixture",
      env,
      redactionValues: redactions,
      timeoutMs: bounded(60_000),
    },
  );
  assertExitZero(prepare, "prepare native restore inputs under verified quiescence");

  progress.phase("rebuild from the complete native-home backup");
  const rebuild = await host.nemoclaw([sandboxName, "rebuild", "--yes", "--verbose"], {
    artifactName: "state-backup-restore-rebuild",
    env,
    redactionValues: redactions,
    timeoutMs: bounded(20 * 60_000),
  });
  const verifyBackup = async () => {
    progress.phase("verify the exact original rebuild backup");
    const backup = await hostFixture("backup", {
      before,
      refused: scenario === "retired-telegram",
      files: Object.fromEntries([
        ...Object.entries(scenario === "legacy" ? fixture.legacyFiles : fixture.refusedFiles).map(
          ([name, bytes]) => [`.openclaw/${name}`, bytes],
        ),
        ...markerPaths.map((name) => [name.slice("/sandbox/".length), `${marker}\n`]),
      ]),
    });
    await artifacts.writeJson("original-rebuild-backup.json", backup);
  };
  return {
    sandboxName,
    env,
    redactions,
    bounded,
    nativeInput,
    marker,
    markerPaths,
    rebuild,
    hostFixture,
    verifyBackup,
  };
}

test(
  "state-backup-restore: legacy native state migrates through the real rebuild",
  restoreOptions,
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const {
      sandboxName,
      env,
      redactions,
      bounded,
      nativeInput,
      marker,
      markerPaths,
      rebuild,
      verifyBackup,
    } = await rebuildFixture("legacy", {
      artifacts,
      cleanup,
      host,
      progress,
      runtimeProvider,
      sandbox,
      secrets,
    });
    assertExitZero(rebuild, "rebuild from complete native-home legacy backup");
    await verifyBackup();
    progress.phase("verify native-home state and readiness");
    const migrated = await sandbox.exec(
      sandboxName,
      [
        "node",
        "-e",
        OPENCLAW_RESTORE_NATIVE_PROGRAM,
        JSON.stringify({ ...nativeInput, mode: "verify" }),
      ],
      {
        artifactName: "state-backup-restore-native-migration",
        env,
        redactionValues: redactions,
        timeoutMs: bounded(60_000),
      },
    );
    assertExitZero(migrated, "verify actual restored legacy migrations and canonical data");
    await artifacts.writeJson("native-legacy-migration.json", JSON.parse(migrated.stdout));
    const verify = await sandbox.execShell(
      sandboxName,
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
        timeoutMs: bounded(330_000),
      },
    );
    expect(
      verify.exitCode,
      `verify complete native-home restore and readiness: ${resultText(verify)}`,
    ).toBe(0);

    await artifacts.target.complete({
      id: "state-backup-restore",
      status: "passed",
      scenario: "legacy",
      originalBackupPreserved: true,
      stateRestored: true,
      nativeReady: true,
    });
  },
);

test(
  "state-backup-restore: retired Telegram state refuses startup and retains recovery",
  restoreOptions,
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const { rebuild, hostFixture, verifyBackup, sandboxName, env, redactions, bounded } =
      await rebuildFixture("retired-telegram", {
        artifacts,
        cleanup,
        host,
        progress,
        runtimeProvider,
        sandbox,
        secrets,
      });
    expect(rebuild.timedOut, resultText(rebuild)).toBe(false);
    expect(rebuild.signal, resultText(rebuild)).toBeNull();
    expect(rebuild.exitCode, resultText(rebuild)).toBe(1);
    await verifyBackup();
    progress.phase("verify native-home state and readiness");
    // OpenShell diagnostic events do not contain entrypoint stderr. Read the
    // retained native log from the exact runtime, including when it is stopped.
    const resourceHandle = await runtimeProvider.resolveSandboxResourceHandle(sandboxName, {
      artifactName: "state-backup-restore-refusal-container",
      env,
      redactionValues: redactions,
      timeoutMs: bounded(30_000),
    });
    const copy = runtimeProvider.hostInvocation([
      "cp",
      `${resourceHandle}:/tmp/nemoclaw-start.log`,
      "-",
    ]);
    const startup = await host.command(
      "bash",
      [
        "-o",
        "pipefail",
        "-c",
        'reader="$1"; shift; "$@" | python3 -I -c "$reader"',
        "restore-refusal",
        STOPPED_CONTAINER_STARTUP_LOG_READER,
        copy.command,
        ...copy.args,
      ],
      {
        artifactName: "state-backup-restore-refusal-startup-log",
        env,
        redactionValues: redactions,
        captureLimitBytes: 128 * 1024,
        timeoutMs: bounded(30_000),
      },
    );
    assertExitZero(startup, "read actual stopped entrypoint refusal evidence");
    const { log: startupLog } = JSON.parse(startup.stdout) as { log: string };
    const refusal = await hostFixture("refusal", { startupLog });
    await artifacts.writeJson("native-retired-state-refusal.json", refusal);
    await artifacts.target.complete({
      id: "state-backup-restore",
      status: "passed",
      scenario: "retired-telegram",
      migrationRefused: true,
      originalBackupPreserved: true,
    });
  },
);
