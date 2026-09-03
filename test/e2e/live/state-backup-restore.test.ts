// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/index.ts";
import { sandboxAccessEnv, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import {
  restoreRegistryAndSession,
  snapshotRegistryAndSession,
} from "../fixtures/phases/state-validation.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Keep the core boundary identical to the former shell lane: write durable
// workspace state in a real OpenClaw sandbox, run scripts/backup-workspace.sh
// backup, destroy and recreate the sandbox, run scripts/backup-workspace.sh
// restore, then verify the five top-level workspace files plus memory/ return.

const WORKSPACE_PATH = "/sandbox/.openclaw/workspace";
const WORKSPACE_FILES = ["SOUL.md", "USER.md", "IDENTITY.md", "AGENTS.md", "MEMORY.md"];
const MEMORY_FILE = "memory/2026-04-20.md";
const UNSAFE_MEMORY_LINK = "memory/e2e-unsafe-link";
const TEST_SANDBOX_PREFIX = "e2e-state-backup";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? TEST_SANDBOX_PREFIX;
const TEST_TIMEOUT_MS = testTimeout(
  Number(process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? 3_600) * 1_000,
);
const ONBOARD_TIMEOUT_MS = execTimeout(30 * 60_000);
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

async function bestEffortLifecycleCleanup(run: () => Promise<unknown>): Promise<void> {
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
    await bestEffortLifecycleCleanup(() => destroy(`phase-3-destroy-attempt-${attempt}`));
    const listResult = await list(`phase-3-list-after-destroy-${attempt}`);
    lastList = resultText(listResult);
    if (listResult.exitCode === 0 && !lastList.includes(sandboxName)) return;
    if (attempt < DESTROY_ATTEMPTS) await sleep(DESTROY_RETRY_DELAY_MS);
  }
  throw new Error(
    `TC-STATE-01: Destroy failed; sandbox ${sandboxName} still exists after ${DESTROY_ATTEMPTS} attempts:\n${lastList}`,
  );
}

test(
  "state-backup-restore: rejects linked memory before restoring regular state (#8006, #10636)",
  {
  timeout: TEST_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "confirm the selected runtime and the workspace backup script",
      "onboard the source sandbox",
      "write workspace and memory markers",
      "reject a backup that contains a nested symbolic link",
      "capture and inspect the host backup",
      "destroy and re-onboard the sandbox",
      "restore the backup into the fresh sandbox",
      "validate restored workspace and memory",
    ],
  },
  },
  async ({
  artifacts,
  cleanup,
  environment,
  host,
  onboard,
  progress,
    runtimeProvider,
  sandbox,
  secrets,
  skip,
  stateValidation,
}) => {
  assertTestOwnedSandboxName();
  secrets.required("NVIDIA_INFERENCE_API_KEY");
    await runtimeProvider.requireAvailable({
    artifactName: "prereq-runtime-info",
      scenarioLabel: "state backup and restore",
  });

  await artifacts.writeJson("contract.json", {
    sandboxName: SANDBOX_NAME,
    workspacePath: WORKSPACE_PATH,
    restoredFiles: WORKSPACE_FILES,
    restoredDirectoryProbe: MEMORY_FILE,
    preservedBoundaries: [
      "real nemoclaw onboard with Docker/OpenShell",
      "openshell sandbox exec workspace marker writes and reads",
      "real backup helper rejects a nested workspace symbolic link without retaining a backup",
      "real scripts/backup-workspace.sh backup host process",
      "real nemoclaw <sandbox> destroy --yes",
      "real scripts/backup-workspace.sh restore host process",
      "legacy workspace backup and restore remains compatible with AgentDefinition state migration",
    ],
  });

  const stateSnapshot = snapshotRegistryAndSession();
  let createdBackupDir: string | undefined;
  let rejectedBackupDir: string | undefined;
  cleanup.trackDisposable(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
    restoreRegistryAndSession(stateSnapshot);
  });
  cleanup.trackDisposable("remove generated backup-workspace.sh backup", () => {
    const root = backupRoot();
    const rejectedResolved = rejectedBackupDir ? path.resolve(rejectedBackupDir) : root;
    if (rejectedResolved !== root && rejectedResolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
      fs.rmSync(rejectedResolved, { recursive: true, force: true });
    }
    const createdResolved = createdBackupDir ? path.resolve(createdBackupDir) : root;
    if (createdResolved !== root && createdResolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
      fs.rmSync(createdResolved, { recursive: true, force: true });
    }
  });
  if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1") {
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-sandbox-delete",
        env: sandboxAccessEnv(),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15 * 60_000,
    });
  }
  cleanup.trackDisposable("stop NemoClaw gateway", async () => {
    const result = await host.nemoclaw(["stop"], {
      artifactName: "cleanup-nemoclaw-stop",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    assertExitZero(result, "cleanup nemoclaw stop");
  });

  await bestEffortLifecycleCleanup(() =>
    onboard.destroySandbox(SANDBOX_NAME, "pre-cleanup-nemoclaw-destroy"),
  );
  await bestEffortLifecycleCleanup(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "pre-cleanup-openshell-sandbox-delete",
      env: sandboxAccessEnv(),
      timeoutMs: 60_000,
    }),
  );

  const ready = await environment.assertReady({
    platform: "ubuntu-local",
    install: "repo-current",
      runtime: "managed-runtime-running",
    onboarding: "cloud-openclaw",
  });

  progress.phase("onboard the source sandbox");
  let instance: NemoClawInstance;
  try {
    instance = await onboard.from(ready, {
      sandboxName: SANDBOX_NAME,
      timeoutMs: ONBOARD_TIMEOUT_MS,
    });
  } catch (error) {
    const text = errorText(error);
    if (isNvidiaEndpointValidationUnavailable(text)) {
      await artifacts.target.complete({
        id: "state-backup-restore",
        status: "skipped",
        reason: "external-provider-validation-unavailable-before-state-backup-contract",
      });
      skip("NVIDIA endpoint validation was unavailable/rate-limited during onboarding");
    }
    throw error;
  }

  progress.phase("write workspace and memory markers");
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

  progress.phase("reject a backup that contains a nested symbolic link");
  const unsafeLinkPath = path.posix.join(WORKSPACE_PATH, UNSAFE_MEMORY_LINK);
  const unsafeLinkTarget = path.posix.join(WORKSPACE_PATH, "SOUL.md");
  const createUnsafeLink = await sandbox.exec(
    SANDBOX_NAME,
    ["sh", "-c", 'ln -s "$2" "$1"', "sh", unsafeLinkPath, unsafeLinkTarget],
    {
      artifactName: "phase-2-create-unsafe-memory-link",
      env: sandboxAccessEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(
    commandFailed(createUnsafeLink),
    `TC-STATE-01: Could not create the nested workspace symbolic link:\n${resultText(createUnsafeLink)}`,
  ).toBe(false);

  const beforeRejectedBackupDirs = new Set(listBackupDirs());
  try {
    const rejectedBackup = await host.command(
      "bash",
      [path.join(REPO_ROOT, "scripts", "backup-workspace.sh"), "backup", SANDBOX_NAME],
      {
        artifactName: "phase-2-reject-unsafe-backup",
        cwd: REPO_ROOT,
        env: backupRestoreEnv(),
        timeoutMs: BACKUP_RESTORE_TIMEOUT_MS,
      },
    );
    const rejectedBackupText = resultText(rejectedBackup);
    const rejectedBackupDirs = listBackupDirs().filter(
      (dir) => !beforeRejectedBackupDirs.has(dir),
    );
    rejectedBackupDir = latestBackupDir(rejectedBackupDirs);
    await artifacts.writeJson("phase-2-rejected-backup-summary.json", {
      exitCode: rejectedBackup.exitCode,
      output: rejectedBackupText,
      retainedBackupDirs: rejectedBackupDirs,
    });

    expect(
      commandFailed(rejectedBackup) &&
        rejectedBackupText.includes(
          "the directory contains an entry that is not a regular file or directory",
        ) &&
        rejectedBackupDirs.length === 0,
      `TC-STATE-01: Unsafe workspace backup must fail with the expected error and retain no new directory:\n${rejectedBackupText}`,
    ).toBe(true);
  } finally {
    const removeUnsafeLink = await sandbox.exec(
      SANDBOX_NAME,
      ["sh", "-c", 'rm -f -- "$1"', "sh", unsafeLinkPath],
      {
        artifactName: "phase-2-remove-unsafe-memory-link",
        env: sandboxAccessEnv(),
        timeoutMs: 60_000,
      },
    );
    expect(
      commandFailed(removeUnsafeLink),
      `TC-STATE-01: Could not remove the nested workspace symbolic link:\n${resultText(removeUnsafeLink)}`,
    ).toBe(false);
  }

  progress.phase("capture and inspect the host backup");
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
  createdBackupDir = latestBackupDir(newBackupDirs);
  expect(createdBackupDir, "TC-STATE-01: Backup dir — no backup directory found").toBeTruthy();
  await artifacts.writeJson("phase-2-backup-summary.json", {
    backupDir: createdBackupDir,
    output: backupText,
  });

  let capturedFiles = 0;
  WORKSPACE_FILES.forEach((file) => {
    const expected = `${markerContent}_${file}`;
    if (hostFileContains(path.join(createdBackupDir!, file), expected)) {
      capturedFiles += 1;
    }
  });
  expect(
    capturedFiles,
    `TC-STATE-01: BackupCaptureFiles — expected all 5 markdown files in host backup ${createdBackupDir}`,
  ).toBe(WORKSPACE_FILES.length);

  const memoryBackupPath = path.join(createdBackupDir!, MEMORY_FILE);
  expect(
    hostFileContains(memoryBackupPath, `${markerContent}_daily`),
    `TC-STATE-01: BackupCaptureDir — ${memoryBackupPath} must contain the expected marker`,
  ).toBe(true);

  progress.phase("destroy and re-onboard the sandbox");
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
      await artifacts.target.complete({
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

  progress.phase("restore the backup into the fresh sandbox");
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

  progress.phase("validate restored workspace and memory");
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
  expect(
    memoryText.includes("STATE=EXISTS") && memoryText.includes(`${markerContent}_daily`),
    `TC-STATE-01: MemoryRestore — restored memory must exist and contain the expected marker:\n${memoryText}`,
  ).toBe(true);
  },
);
