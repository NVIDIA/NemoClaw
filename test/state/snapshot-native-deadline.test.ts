// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeExecutable } from "../support/native-snapshot.ts";

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

  it("classifies a timed-out credential extraction as a backup deadline failure", () => {
    const { fixture, nativeRoot } = createNativeSource();
    const binDir = path.join(fixture, "bin");
    const timeoutMarker = path.join(fixture, "extraction-timed-out");
    const systemTar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
    const oldPath = process.env.PATH;
    const baseNow = Date.now();
    let scanStarted = false;
    const originalTempDir = fs.mkdtempSync;
    const tempDir = vi.spyOn(fs, "mkdtempSync").mockImplementation((...args) => {
      scanStarted ||= String(args[0]).includes(".native-scan-");
      return Reflect.apply(originalTempDir, fs, args) as string;
    });
    syncBuiltinESMExports();
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() =>
        scanStarted ? baseNow + sandboxState.NATIVE_STATE_CAPTURE_TIMEOUT_MS - 500 : baseNow,
      );
    try {
      fs.writeFileSync(path.join(nativeRoot, ".env"), "SAFE=value\n");
      fs.mkdirSync(binDir);
      writeExecutable(
        path.join(binDir, "tar"),
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          `if (args.includes("-xf") && args.includes("-T")) { process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(timeoutMarker)}, "1"); process.exit(143); }); setTimeout(() => undefined, 3000); }`,
          `else process.exit(spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" }).status ?? 1);`,
        ].join("\n"),
      );
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      const backup = sandboxState.backupSandboxState("alpha", {
        deadlineMs: baseNow + sandboxState.NATIVE_STATE_CAPTURE_TIMEOUT_MS,
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });
      expect(scanStarted).toBe(true);
      expect(fs.existsSync(timeoutMarker)).toBe(true);
      expect(backup.success).toBe(false);
      expect(backup.error).toContain("credential scan exceeded the backup deadline");
      expect(sandboxState.getLatestBackup("alpha")).toBeNull();
    } finally {
      clock.mockRestore();
      tempDir.mockRestore();
      syncBuiltinESMExports();
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("stops raw inventory inspection at its deadline and removes private staging", () => {
    const { fixture, nativeRoot } = createNativeSource();
    try {
      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });
      expect(backup.success, backup.error).toBe(true);
      const backupPath = backup.manifest!.backupPath;
      const baseNow = Date.now();
      let listingComplete = false;
      let readRawHeader = false;
      const originalRead = fs.readSync;
      const originalRemove = fs.rmSync;
      const remove = vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
        Reflect.apply(originalRemove, fs, args);
        listingComplete ||= path.basename(String(args[0])).startsWith("nemoclaw-tar-listing-");
      });
      const read = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
        const count = Reflect.apply(originalRead, fs, args) as number;
        const readArgs: readonly unknown[] = args;
        readRawHeader ||= listingComplete && readArgs[3] === 512;
        return count;
      });
      syncBuiltinESMExports();
      const clock = vi
        .spyOn(Date, "now")
        .mockImplementation(() =>
          readRawHeader ? baseNow + sandboxState.NATIVE_STATE_CAPTURE_TIMEOUT_MS + 1 : baseNow,
        );
      try {
        expect(() => sandboxState.inspectNativeSandboxState(backupPath, () => undefined)).toThrow(
          "Native home/workspace archive inspection exceeded its deadline",
        );
        expect(readRawHeader).toBe(true);
        expect(fs.existsSync(backupPath)).toBe(true);
        expect(fs.readdirSync(backupPath).some((name) => name.startsWith(".native-"))).toBe(false);
      } finally {
        clock.mockRestore();
        read.mockRestore();
        remove.mockRestore();
        syncBuiltinESMExports();
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
