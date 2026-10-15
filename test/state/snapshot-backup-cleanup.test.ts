// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beforeNextBackupDirectoryCreate } from "./snapshot-backup-cleanup-fixture";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-cleanup-"));
process.env.HOME = TMP_HOME;

const sandboxState = (await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
)) as typeof import("../../src/lib/state/sandbox.js");
const SANDBOX_BACKUPS = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups", "alpha");
const NATIVE_ROOT = path.join(TMP_HOME, "native-home");
const INVALID_TMPDIR = path.join(TMP_HOME, "not-a-directory");
const OPENSHELL = path.join(TMP_HOME, "openshell");

beforeEach(() => {
  fs.rmSync(SANDBOX_BACKUPS, { recursive: true, force: true });
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
  fs.mkdirSync(NATIVE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(NATIVE_ROOT, "state.txt"), "preserved\n");
  fs.writeFileSync(INVALID_TMPDIR, "occupied\n");
  fs.writeFileSync(
    OPENSHELL,
    '#!/usr/bin/env node\nprocess.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");\n',
    { mode: 0o755 },
  );
  vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", OPENSHELL);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function captureNativeBackup() {
  const result = sandboxState.backupSandboxState("alpha", {
    nativeStateSource: {
      root: "/sandbox",
      directory: NATIVE_ROOT,
      assertCurrent: () => undefined,
    },
  });
  expect(result.success, result.error).toBe(true);
  const manifest = result.manifest!;
  const manifestPath = path.join(manifest.backupPath, "rebuild-manifest.json");
  const archivePath = path.join(manifest.backupPath, "native-home.tar");
  return {
    timestamp: manifest.timestamp,
    manifestPath,
    manifestContents: fs.readFileSync(manifestPath),
    archivePath,
    archiveContents: fs.readFileSync(archivePath),
  };
}

function prepareSshTempFailure() {
  const previous = captureNativeBackup();
  vi.setSystemTime(Date.now() + 1_000);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  vi.spyOn(os, "tmpdir").mockReturnValue(INVALID_TMPDIR);
  return { previous, timestamp, backupPath: path.join(SANDBOX_BACKUPS, timestamp) };
}

describe("cleanup after native backup throws", () => {
  it("removes its new directory when SSH temporary-directory creation fails (#12277)", () => {
    const { previous } = prepareSshTempFailure();

    let failure: unknown;
    try {
      sandboxState.backupSandboxState("alpha");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "ENOTDIR" });

    expect(fs.readdirSync(SANDBOX_BACKUPS)).toEqual([previous.timestamp]);
    expect(fs.readFileSync(previous.manifestPath)).toEqual(previous.manifestContents);
    expect(fs.readFileSync(previous.archivePath)).toEqual(previous.archiveContents);
  });

  it("reports the retained path and original error when cleanup is denied (#12277)", () => {
    const { previous, timestamp, backupPath } = prepareSshTempFailure();
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: cleanup denied"), { code: "EACCES" });
    });
    syncBuiltinESMExports();

    let failure: unknown;
    try {
      sandboxState.backupSandboxState("alpha");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: expect.stringContaining(`Incomplete backup at '${backupPath}' could not be removed`),
      cause: expect.objectContaining({ code: "ENOTDIR" }),
    });
    expect(fs.readdirSync(SANDBOX_BACKUPS).sort()).toEqual([previous.timestamp, timestamp]);
    expect(fs.readdirSync(backupPath)).toEqual([]);
    expect(fs.readFileSync(previous.manifestPath)).toEqual(previous.manifestContents);
    expect(fs.readFileSync(previous.archivePath)).toEqual(previous.archiveContents);
  });

  it("preserves the deadline and reports incomplete cleanup after capture throws (#12277)", () => {
    const { previous, timestamp, backupPath } = prepareSshTempFailure();
    const deadlineMs = Date.now() + 30_000;
    const originalMkdtempSync = fs.mkdtempSync;
    vi.spyOn(fs, "mkdtempSync").mockImplementationOnce((prefix, options) => {
      vi.setSystemTime(deadlineMs);
      return Reflect.apply(originalMkdtempSync, undefined, [prefix, options]);
    });
    syncBuiltinESMExports();

    let failure: unknown;
    try {
      sandboxState.backupSandboxState("alpha", { deadlineMs });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: expect.stringContaining(`Incomplete backup at '${backupPath}' could not be removed`),
      cause: expect.objectContaining({ code: "ENOTDIR" }),
    });
    expect(fs.readdirSync(SANDBOX_BACKUPS).sort()).toEqual([previous.timestamp, timestamp]);
    expect(fs.readdirSync(backupPath)).toEqual([]);
    expect(fs.readFileSync(previous.manifestPath)).toEqual(previous.manifestContents);
    expect(fs.readFileSync(previous.archivePath)).toEqual(previous.archiveContents);
  });

  it("preserves a backup completed by another writer before directory creation (#12277)", () => {
    fs.writeFileSync(OPENSHELL, "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
    let concurrent: ReturnType<typeof captureNativeBackup> | undefined;
    beforeNextBackupDirectoryCreate(SANDBOX_BACKUPS, () => {
      concurrent = captureNativeBackup();
    });

    expect(() => sandboxState.backupSandboxState("alpha")).toThrow(/EEXIST/);

    expect(concurrent).toBeDefined();
    expect(fs.readdirSync(SANDBOX_BACKUPS)).toEqual([concurrent!.timestamp]);
    expect(fs.readFileSync(concurrent!.manifestPath)).toEqual(concurrent!.manifestContents);
    expect(fs.readFileSync(concurrent!.archivePath)).toEqual(concurrent!.archiveContents);
  });
});
