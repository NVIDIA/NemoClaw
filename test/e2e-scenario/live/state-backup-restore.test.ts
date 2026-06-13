// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { sandboxAccessEnv, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import {
  restoreRegistryAndSession,
  snapshotRegistryAndSession,
} from "../fixtures/phases/state-validation.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Direct Vitest replacement coverage for test/e2e/test-state-backup-restore.sh.
// Keep the core boundary identical to the legacy shell lane: write durable
// workspace state in a real OpenClaw sandbox, run scripts/backup-workspace.sh
// backup, destroy and recreate the sandbox, run scripts/backup-workspace.sh
// restore, then verify the five top-level workspace files plus memory/ return.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKSPACE_PATH = "/sandbox/.openclaw/workspace";
const WORKSPACE_FILES = ["SOUL.md", "USER.md", "IDENTITY.md", "AGENTS.md", "MEMORY.md"];
const MEMORY_FILE = "memory/2026-04-20.md";
const TEST_SANDBOX_PREFIX = "e2e-state-backup";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? TEST_SANDBOX_PREFIX;
const TEST_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? 3_600) * 1_000;
const ONBOARD_TIMEOUT_MS = 30 * 60_000;
const BACKUP_RESTORE_TIMEOUT_MS = 5 * 60_000;
const DESTROY_ATTEMPTS = 3;
const DESTROY_RETRY_DELAY_MS = 10_000;

validateSandboxName(SANDBOX_NAME);

type BackupExpectation = {
  relativePath: string;
  expected: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertTestOwnedSandboxName(): void {
  if (!SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX)) {
    throw new Error(
      `state-backup-restore live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
    );
  }
}

function backupRoot(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "backups");
}

function listBackupDirs(root = backupRoot()): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function latestBackupDir(candidates: readonly string[]): string | undefined {
  return [...candidates]
    .filter((candidate) => fs.existsSync(candidate))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .at(0);
}

function backupRestoreEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

function commandFailed(result: ShellProbeResult): boolean {
  return result.exitCode !== 0 || result.timedOut;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNvidiaEndpointValidationUnavailable(text: string): boolean {
  return (
    /NVIDIA Endpoints endpoint validation failed/i.test(text) &&
    (/Validation details were omitted/i.test(text) ||
      /HTTP 429|rate limit|quota|temporarily unavailable|timed out|timeout/i.test(text))
  );
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup remains best-effort so the primary E2E failure stays visible.
  }
}

function hostFileContains(filePath: string, expected: string): boolean {
  return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(expected);
}

async function destroySandboxUntilAbsent(
  sandboxName: string,
  destroy: (artifactName: string) => Promise<ShellProbeResult>,
  list: (artifactName: string) => Promise<ShellProbeResult>,
): Promise<void> {
  let lastList = "";
  for (let attempt = 1; attempt <= DESTROY_ATTEMPTS; attempt += 1) {
    await bestEffort(() => destroy(`phase-3-destroy-attempt-${attempt}`));
    const listResult = await list(`phase-3-list-after-destroy-${attempt}`);
    lastList = resultText(listResult);
    if (listResult.exitCode === 0 && !lastList.includes(sandboxName)) return;
    if (attempt < DESTROY_ATTEMPTS) await sleep(DESTROY_RETRY_DELAY_MS);
  }
  throw new Error(
    `TC-STATE-01: Destroy failed; sandbox ${sandboxName} still exists after ${DESTROY_ATTEMPTS} attempts:\n${lastList}`,
  );
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "state-backup-restore: backup-workspace.sh restores workspace files and memory directory",
  { timeout: TEST_TIMEOUT_MS },
  async ({
    artifacts,
    cleanup,
    environment,
    host,
    onboard,
    sandbox,
    secrets,
    skip,
    stateValidation,
  }) => {
    assertTestOwnedSandboxName();
    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "backup-workspace.sh"))).toBe(true);

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for state-backup-restore live coverage: ${resultText(dockerInfo)}`,
        );
      }
      skip("Docker is required for state-backup-restore live coverage");
    }

    await artifacts.writeJson("contract.json", {
      legacySource: "test/e2e/test-state-backup-restore.sh",
      sandboxName: SANDBOX_NAME,
      workspacePath: WORKSPACE_PATH,
      restoredFiles: WORKSPACE_FILES,
      restoredDirectoryProbe: MEMORY_FILE,
      preservedBoundaries: [
        "real nemoclaw onboard with Docker/OpenShell",
        "openshell sandbox exec workspace marker writes and reads",
        "real scripts/backup-workspace.sh backup host process",
        "real nemoclaw <sandbox> destroy --yes",
        "real scripts/backup-workspace.sh restore host process",
      ],
    });

    const stateSnapshot = snapshotRegistryAndSession();
    let createdBackupDir: string | undefined;
    cleanup.add(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
      restoreRegistryAndSession(stateSnapshot);
    });
    cleanup.add("remove generated backup-workspace.sh backup", () => {
      if (!createdBackupDir) return;
      const root = backupRoot();
      const resolved = path.resolve(createdBackupDir);
      if (resolved !== root && resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    });
    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1") return;
      await bestEffort(() => onboard.destroySandbox(SANDBOX_NAME, "cleanup-nemoclaw-destroy"));
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-sandbox-delete",
          env: sandboxAccessEnv(),
          timeoutMs: 60_000,
        }),
      );
    });
    cleanup.add("stop NemoClaw gateway", async () => {
      await bestEffort(() =>
        host.nemoclaw(["stop"], {
          artifactName: "cleanup-nemoclaw-stop",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 60_000,
        }),
      );
    });

    await bestEffort(() => onboard.destroySandbox(SANDBOX_NAME, "pre-cleanup-nemoclaw-destroy"));
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-sandbox-delete",
        env: sandboxAccessEnv(),
        timeoutMs: 60_000,
      }),
    );

    const ready = await environment.assertReady({
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
    });

    let instance: NemoClawInstance;
    try {
      instance = await onboard.from(ready, {
        sandboxName: SANDBOX_NAME,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      });
    } catch (error) {
      const text = errorText(error);
      if (isNvidiaEndpointValidationUnavailable(text)) {
        await artifacts.writeJson("scenario-result.json", {
          id: "state-backup-restore",
          status: "skipped",
          reason: "external-provider-validation-unavailable-before-state-backup-contract",
        });
        skip("NVIDIA endpoint validation was unavailable/rate-limited during onboarding");
      }
      throw error;
    }

    const markerContent = `E2E_BACKUP_TEST_${Date.now()}`;
    const expectations: BackupExpectation[] = WORKSPACE_FILES.map((file) => ({
      relativePath: file,
      expected: `${markerContent}_${file}`,
    }));
    expectations.push({
      relativePath: MEMORY_FILE,
      expected: `${markerContent}_daily`,
    });

    for (const expectation of expectations) {
      await stateValidation.writeMarkerFile(
        instance,
        path.posix.join(WORKSPACE_PATH, expectation.relativePath),
        expectation.expected,
        {
          artifactName: `phase-1-write-${expectation.relativePath.replace(/\//g, "-")}`,
          env: sandboxAccessEnv(),
          timeoutMs: 60_000,
        },
      );
    }
    await artifacts.writeJson("phase-1-marker-summary.json", {
      workspaceFilesWritten: WORKSPACE_FILES.length,
      memoryFilesWritten: 1,
    });

    const beforeBackupDirs = new Set(listBackupDirs());
    const backup = await host.command(
      "bash",
      [path.join(REPO_ROOT, "scripts", "backup-workspace.sh"), "backup", SANDBOX_NAME],
      {
        artifactName: "phase-2-backup-workspace",
        cwd: REPO_ROOT,
        env: backupRestoreEnv(),
        timeoutMs: BACKUP_RESTORE_TIMEOUT_MS,
      },
    );
    const backupText = resultText(backup);
    if (commandFailed(backup) || !backupText.includes("Backup saved")) {
      throw new Error(
        `TC-STATE-01: Backup failed; backup-workspace.sh backup exited ${backup.exitCode}:\n${backupText}`,
      );
    }

    const newBackupDirs = listBackupDirs().filter((dir) => !beforeBackupDirs.has(dir));
    createdBackupDir = latestBackupDir(newBackupDirs) ?? latestBackupDir(listBackupDirs());
    expect(createdBackupDir, "TC-STATE-01: Backup dir — no backup directory found").toBeTruthy();
    await artifacts.writeJson("phase-2-backup-summary.json", {
      backupDir: createdBackupDir,
      output: backupText,
    });

    let capturedFiles = 0;
    for (const file of WORKSPACE_FILES) {
      const expected = `${markerContent}_${file}`;
      if (hostFileContains(path.join(createdBackupDir!, file), expected)) {
        capturedFiles += 1;
      }
    }
    expect(
      capturedFiles,
      `TC-STATE-01: BackupCaptureFiles — expected all 5 markdown files in host backup ${createdBackupDir}`,
    ).toBe(WORKSPACE_FILES.length);

    const memoryBackupPath = path.join(createdBackupDir!, MEMORY_FILE);
    expect(
      fs.existsSync(memoryBackupPath),
      `TC-STATE-01: BackupCaptureDir — ${memoryBackupPath} must exist in host backup`,
    ).toBe(true);
    expect(
      hostFileContains(memoryBackupPath, `${markerContent}_daily`),
      "TC-STATE-01: BackupCaptureDir — memory file must contain expected marker",
    ).toBe(true);

    await destroySandboxUntilAbsent(
      SANDBOX_NAME,
      (artifactName) => onboard.destroySandbox(SANDBOX_NAME, artifactName),
      (artifactName) =>
        host.nemoclaw(["list"], {
          artifactName,
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 60_000,
        }),
    );
    await artifacts.writeJson("phase-3-destroy-summary.json", {
      sandboxName: SANDBOX_NAME,
      attempts: DESTROY_ATTEMPTS,
    });

    let restoredInstance: NemoClawInstance;
    try {
      restoredInstance = await onboard.from(ready, {
        sandboxName: SANDBOX_NAME,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      });
    } catch (error) {
      const text = errorText(error);
      if (isNvidiaEndpointValidationUnavailable(text)) {
        await artifacts.writeJson("scenario-result.json", {
          id: "state-backup-restore",
          status: "skipped",
          reason: "external-provider-validation-unavailable-during-reonboard",
        });
        skip("NVIDIA endpoint validation was unavailable/rate-limited during re-onboard");
      }
      throw error;
    }
    await artifacts.writeJson("phase-4-reonboard-summary.json", {
      sandboxName: restoredInstance.sandboxName,
    });

    const restore = await host.command(
      "bash",
      [path.join(REPO_ROOT, "scripts", "backup-workspace.sh"), "restore", SANDBOX_NAME],
      {
        artifactName: "phase-5-restore-workspace",
        cwd: REPO_ROOT,
        env: backupRestoreEnv(),
        timeoutMs: BACKUP_RESTORE_TIMEOUT_MS,
      },
    );
    const restoreText = resultText(restore);
    if (commandFailed(restore) || !restoreText.includes("Restored")) {
      throw new Error(
        `TC-STATE-01: Restore failed; backup-workspace.sh restore exited ${restore.exitCode}:\n${restoreText}`,
      );
    }
    await artifacts.writeText("phase-5-restore-output.txt", restoreText);

    let restoredFiles = 0;
    const mismatches: Array<{ file: string; actual: string }> = [];
    for (const file of WORKSPACE_FILES) {
      const remotePath = path.posix.join(WORKSPACE_PATH, file);
      const read = await sandbox.exec(
        SANDBOX_NAME,
        ["sh", "-c", 'cat "$1" 2>/dev/null', "sh", remotePath],
        {
          artifactName: `phase-6-read-${file}`,
          env: sandboxAccessEnv(),
          timeoutMs: 60_000,
        },
      );
      const expected = `${markerContent}_${file}`;
      if (read.exitCode === 0 && read.stdout.includes(expected)) {
        restoredFiles += 1;
      } else {
        mismatches.push({ file, actual: resultText(read).slice(0, 200) });
      }
    }
    await artifacts.writeJson("phase-6-files-restore-summary.json", {
      restoredFiles,
      expectedFiles: WORKSPACE_FILES.length,
      mismatches,
    });
    expect(
      restoredFiles,
      "TC-STATE-01: FilesRestore — backup-workspace.sh must restore all 5 workspace files",
    ).toBe(WORKSPACE_FILES.length);

    const memoryRemotePath = path.posix.join(WORKSPACE_PATH, MEMORY_FILE);
    const memoryProbe = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-c",
        'if [ -f "$1" ]; then printf "STATE=EXISTS\\n"; cat "$1"; else printf "STATE=MISSING\\n"; fi',
        "sh",
        memoryRemotePath,
      ],
      {
        artifactName: "phase-6-read-memory-directory-file",
        env: sandboxAccessEnv(),
        timeoutMs: 60_000,
      },
    );
    const memoryText = resultText(memoryProbe);
    await artifacts.writeText("phase-6-memory-probe.txt", memoryText);
    if (memoryText.includes("STATE=MISSING")) {
      await artifacts.writeText("phase-6-restore-output-for-memory-missing.txt", restoreText);
    }
    expect(memoryText).toContain("STATE=EXISTS");
    expect(memoryText).toContain(`${markerContent}_daily`);
  },
);
