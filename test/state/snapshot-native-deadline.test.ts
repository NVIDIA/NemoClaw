// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-deadline-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: { name: "alpha", model: "m", provider: "p", gpuEnabled: false, agent: null },
      },
    }),
  );
});

function createNativeSource(): { fixture: string; nativeRoot: string } {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-deadline-source-"));
  const nativeRoot = path.join(fixture, "native-home");
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, "state.txt"), "preserved");
  return { fixture, nativeRoot };
}

describe("complete native-home backup deadlines", () => {
  it("rejects an expired deadline before creating state", () => {
    const backup = sandboxState.backupSandboxState("alpha", { deadlineMs: Date.now() - 1 });

    expect(backup.success).toBe(false);
    expect(backup.unreachable).toBe(true);
    expect(backup.error).toContain("deadline expired before backup started");
    expect(fs.existsSync(path.join(BACKUPS_ROOT, "alpha"))).toBe(false);
  });

  it("keeps deferred backups nonselectable until retention completes", () => {
    const { fixture, nativeRoot } = createNativeSource();
    try {
      const backup = sandboxState.backupSandboxState("alpha", {
        deadlineMs: Date.now() + 60_000,
        deferCompletionPublication: true,
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });

      expect(backup.success, backup.error).toBe(true);
      expect(backup.manifest?.backupComplete).toBe(false);
      expect(sandboxState.getLatestBackup("alpha")).toBeNull();
      sandboxState.markRebuildBackupComplete(backup.manifest!);
      expect(sandboxState.getLatestBackup("alpha")?.backupComplete).toBe(true);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("preserves an incomplete backup after its cleanup deadline", () => {
    const { fixture, nativeRoot } = createNativeSource();
    try {
      const backup = sandboxState.backupSandboxState("alpha", {
        deferCompletionPublication: true,
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });
      expect(backup.success, backup.error).toBe(true);

      expect(
        sandboxState.removeSandboxStateBackup("alpha", backup.manifest!.backupPath, Date.now() - 1),
      ).toBe(false);
      expect(fs.existsSync(backup.manifest!.backupPath)).toBe(true);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects an archive when header inspection reaches the backup deadline before publication", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-deadline-lockfile-"));
    const nativeRoot = path.join(fixture, "native-home");
    fs.mkdirSync(nativeRoot, { recursive: true });
    fs.writeFileSync(path.join(nativeRoot, "yarn.lock"), "# yarn lockfile v1\n");
    const tmpRoot = os.tmpdir();
    const existingListingDirs = new Set(
      fs.readdirSync(tmpRoot).filter((entry) => entry.startsWith("nemoclaw-tar-listing-")),
    );
    const baseNow = Date.now();
    const deadlineMs = baseNow + 60_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const hasActiveListingDir = fs
        .readdirSync(tmpRoot)
        .some(
          (entry) => entry.startsWith("nemoclaw-tar-listing-") && !existingListingDirs.has(entry),
        );
      return hasActiveListingDir ? deadlineMs + 1 : baseNow;
    });
    try {
      const backup = sandboxState.backupSandboxState("alpha", {
        deadlineMs,
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });

      expect(backup.success).toBe(false);
      expect(backup.error).toContain("archive header inspection timed out");
      expect(sandboxState.getLatestBackup("alpha")).toBeNull();
    } finally {
      nowSpy.mockRestore();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
