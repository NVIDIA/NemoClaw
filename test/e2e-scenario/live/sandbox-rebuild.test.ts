// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  latestRebuildBackupDir,
  listCredentialLeakPaths,
  patchRegistrySandboxEntry,
  readRegistrySandboxEntry,
  restoreRegistryAndSession,
  snapshotRegistryAndSession,
} from "../fixtures/phases/state-validation.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Direct Vitest replacement coverage for test/e2e/test-sandbox-rebuild.sh.
// This dependent migration reuses the rebuild/state helper shape seeded by the
// OpenClaw rebuild anchor while keeping the contract focused: onboard a real
// sandbox, mark workspace state, force stale registry metadata, run the real
// `nemoclaw <sandbox> rebuild --yes`, then verify state preservation, registry
// refresh, and backup credential hygiene.

const MARKER_FILE = "/sandbox/.openclaw/workspace/rebuild-marker.txt";
const STALE_AGENT_VERSION = "0.0.1";
const TEST_SANDBOX_PREFIX = "e2e-sandbox-rebuild";
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  [TEST_SANDBOX_PREFIX, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.pid]
    .filter(Boolean)
    .join("-");
const TEST_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? 1_200) * 1_000;
const CONNECT_PROBE_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 60_000;
const ONBOARD_TIMEOUT_MS = TEST_TIMEOUT_MS;
const REBUILD_TIMEOUT_MS = TEST_TIMEOUT_MS;
const MARKER_CONTENT = `REBUILD_E2E_${Date.now()}`;

function resultText(result: ShellProbeResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function sandboxRebuildEnv(apiKey: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NVIDIA_INFERENCE_API_KEY: apiKey,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
  };
}

function assertTestOwnedSandboxName(): void {
  if (!SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX)) {
    throw new Error(
      `sandbox-rebuild live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
    );
  }
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup remains best-effort so earlier lifecycle failures stay visible.
  }
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "sandbox-rebuild: rebuild preserves marker state and refreshes registry metadata",
  async ({
    artifacts,
    cleanup,
    environment,
    host,
    lifecycle,
    onboard,
    sandbox,
    secrets,
    skip,
    stateValidation,
  }) => {
    assertTestOwnedSandboxName();
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_INFERENCE_API_KEY must start with nvapi-").toBe(
      true,
    );

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for sandbox-rebuild live coverage: ${resultText(dockerInfo)}`,
        );
      }
      skip("Docker is required for sandbox-rebuild live coverage");
    }

    const ready = await environment.assertReady({
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
    });

    await artifacts.writeJson("contract.json", {
      legacySource: "test/e2e/test-sandbox-rebuild.sh",
      sandboxName: SANDBOX_NAME,
      markerFile: MARKER_FILE,
      staleAgentVersion: STALE_AGENT_VERSION,
      preservedBoundaries: [
        "real nemoclaw onboard with Docker/OpenShell",
        "openshell sandbox exec marker write/read",
        "local registry stale agentVersion mutation",
        "real nemoclaw <sandbox> rebuild --yes",
        "backup credential leak scan under ~/.nemoclaw/rebuild-backups",
      ],
    });

    const stateSnapshot = snapshotRegistryAndSession();
    const backupRoot = path.join(
      process.env.HOME ?? os.homedir(),
      ".nemoclaw",
      "rebuild-backups",
      SANDBOX_NAME,
    );
    cleanup.add(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
      restoreRegistryAndSession(stateSnapshot);
      fs.rmSync(backupRoot, { recursive: true, force: true });
    });
    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1") return;
      await bestEffort(() => onboard.destroySandbox(SANDBOX_NAME, "cleanup-nemoclaw-destroy"));
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-sandbox-delete",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 60_000,
        }),
      );
    });

    await bestEffort(() => onboard.destroySandbox(SANDBOX_NAME, "pre-cleanup-nemoclaw-destroy"));
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-sandbox-delete",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      }),
    );

    const instance = await onboard.from(ready, {
      sandboxName: SANDBOX_NAME,
      timeoutMs: ONBOARD_TIMEOUT_MS,
    });

    const status = await host.nemoclaw([SANDBOX_NAME, "status"], {
      artifactName: "phase-2-status-version-detection",
      env: sandboxRebuildEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    await artifacts.writeText("phase-2-status-output.txt", resultText(status));
    if (/Agent:.*v?\d+\.\d+/i.test(resultText(status))) {
      await artifacts.writeJson("phase-2-status-version-summary.json", { versionVisible: true });
    } else {
      await artifacts.writeJson("phase-2-status-version-summary.json", {
        versionVisible: false,
        note: "Legacy shell accepted first-run status output without cached version.",
      });
    }

    await stateValidationWriteMarker();

    patchRegistrySandboxEntry(SANDBOX_NAME, { agentVersion: STALE_AGENT_VERSION });
    await artifacts.writeJson("phase-4-stale-registry-summary.json", {
      sandboxName: SANDBOX_NAME,
      agentVersion: readRegistrySandboxEntry(SANDBOX_NAME).agentVersion,
    });

    const connect = await host.command(
      "bash",
      [
        "-lc",
        'timeout 10 "$1" "$2" connect <<<"exit"',
        "connect-stale",
        host.commandPath,
        SANDBOX_NAME,
      ],
      {
        artifactName: "phase-4-connect-stale-warning",
        env: sandboxRebuildEnv(apiKey),
        redactionValues: [apiKey],
        timeoutMs: CONNECT_PROBE_TIMEOUT_MS,
      },
    );
    if (!/rebuild/i.test(resultText(connect))) {
      await artifacts.writeText(
        "phase-4-connect-stale-warning-note.txt",
        "No rebuild warning was observed; legacy bash treated this as acceptable when the sandbox is not live.\n",
      );
    }

    await lifecycle.rebuildSandbox(instance, {
      artifactName: "phase-5-nemoclaw-rebuild",
      env: sandboxRebuildEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    await lifecycle.assertSandboxReadyAfterRebuild(instance, {
      artifactNamePrefix: "phase-5-sandbox-ready-after-rebuild",
      env: buildAvailabilityProbeEnv(),
      attempts: 12,
      delayMs: 5_000,
    });

    await stateValidation.expectMarkerFileContent(instance, MARKER_FILE, MARKER_CONTENT, {
      artifactName: "phase-6-read-marker-after-rebuild",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });

    const updatedVersion = stateValidation.expectRegistryAgentVersionUpdated(
      SANDBOX_NAME,
      STALE_AGENT_VERSION,
    );
    await artifacts.writeJson("phase-7-registry-version-summary.json", {
      sandboxName: SANDBOX_NAME,
      staleVersion: STALE_AGENT_VERSION,
      updatedVersion,
    });

    const backupDir = latestRebuildBackupDir(SANDBOX_NAME);
    const leaks = listCredentialLeakPaths(backupDir, { extraSecrets: [apiKey] });
    await artifacts.writeJson("phase-8-backup-credential-scan.json", {
      backupDir: backupDir ?? null,
      leaks,
      note: backupDir ? undefined : "No backup directory found; legacy shell skipped this check.",
    });
    expect(leaks, "backup files must not contain credential-shaped values").toEqual([]);

    async function stateValidationWriteMarker(): Promise<void> {
      await stateValidation.writeMarkerFile(instance, MARKER_FILE, MARKER_CONTENT, {
        artifactName: "phase-3-write-marker",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      });
      await stateValidation.expectMarkerFileContent(instance, MARKER_FILE, MARKER_CONTENT, {
        artifactName: "phase-3-read-marker-before-rebuild",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      });
    }
  },
  TEST_TIMEOUT_MS * 3,
);
