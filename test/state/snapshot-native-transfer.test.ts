// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeFakeOpenshell,
  writeFakeSsh,
  writeSnapshotRegistry,
} from "../support/native-snapshot";

const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-transfer-"));
process.env.HOME = home;
const state = await import("../../src/lib/state/sandbox");
let nativeRoot: string;
let bin: string;
let backupPath: string;
const payload = Buffer.alloc(5 * 1024 * 1024 + 17, 97);

beforeEach(() => {
  const fixture = fs.mkdtempSync(path.join(home, "case-"));
  nativeRoot = path.join(fixture, "native");
  bin = path.join(fixture, "bin");
  fs.mkdirSync(nativeRoot);
  fs.mkdirSync(bin);
  writeFakeOpenshell(bin);
  writeFakeSsh(bin);
  writeSnapshotRegistry(home, "alpha", "hermes");
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", path.join(bin, "openshell"));
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_ROOT", nativeRoot);
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_HOME", nativeRoot);
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_WORKSPACE", nativeRoot);
  fs.writeFileSync(path.join(nativeRoot, "payload"), payload);
  const backup = state.backupSandboxState("alpha", {
    nativeStateSource: { root: nativeRoot, directory: nativeRoot, assertCurrent: vi.fn() },
  });
  expect(backup.success, backup.error).toBe(true);
  backupPath = backup.manifest!.backupPath;
  fs.rmSync(path.join(nativeRoot, "payload"));
  fs.writeFileSync(path.join(nativeRoot, "replacement"), "unchanged");
});

afterAll(() => {
  originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe("native restore transfer", () => {
  it("uploads the validated descriptor even when the original archive is replaced", async () => {
    const sftp = path.join(bin, "sftp");
    fs.writeFileSync(
      sftp,
      fs
        .readFileSync(sftp, "utf8")
        .replace(
          "const batch =",
          `fs.writeFileSync(${JSON.stringify(path.join(backupPath, "native-home.tar"))}, "replaced after validation");\nconst batch =`,
        ),
    );

    const restored = await state.restoreSandboxState("alpha", backupPath);

    expect(restored.success, restored.error).toBe(true);
    expect(fs.readFileSync(path.join(backupPath, "native-home.tar"), "utf8")).toBe(
      "replaced after validation",
    );
    expect(fs.readFileSync(path.join(nativeRoot, "payload")).equals(payload)).toBe(true);
    expect(
      fs.readdirSync(nativeRoot).filter((name) => name.startsWith(".nemoclaw-native-restore")),
    ).toEqual([]);
    expect(fs.existsSync(path.join(nativeRoot, "replacement"))).toBe(false);
  });

  it.each([
    ["checksum mismatch", 'fs.writeFileSync(target, "tampered");'],
    ["exit 42", "process.exit(42);"],
    ["exit 1", 'fs.linkSync(target, path.join(root, "retained-hardlink"));'],
  ])("preserves replacement state and the backup after %s", async (error, injection) => {
    fs.appendFileSync(path.join(bin, "sftp"), injection);
    const originalArchive = fs.readFileSync(path.join(backupPath, "native-home.tar"));

    const restored = await state.restoreSandboxState("alpha", backupPath);

    expect(restored).toMatchObject({ success: false, restoredDirs: [] });
    expect(restored.error).toContain(error);
    expect(fs.readFileSync(path.join(nativeRoot, "replacement"), "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(nativeRoot, "payload"))).toBe(false);
    expect(
      fs.readdirSync(nativeRoot).filter((name) => name.startsWith(".nemoclaw-native-restore")),
    ).toEqual([]);
    expect(fs.readFileSync(path.join(backupPath, "native-home.tar")).equals(originalArchive)).toBe(
      true,
    );
  });

  it("rechecks authority after upload and removes staging when authority changes", async () => {
    const validateBeforeMutation = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("replacement generation changed"));

    const restored = await state.restoreSandboxState("alpha", backupPath, {
      validateBeforeMutation,
    });

    expect(validateBeforeMutation).toHaveBeenCalledTimes(2);
    expect(restored).toMatchObject({ success: false, restoredDirs: [] });
    expect(restored.error).toContain("replacement generation changed");
    expect(fs.readdirSync(nativeRoot)).toEqual(["replacement"]);
  });

  it("reports cleanup failure without deleting a substituted staging directory", async () => {
    const sftp = path.join(bin, "sftp");
    fs.appendFileSync(
      sftp,
      `
const transfer = path.dirname(target);
fs.renameSync(transfer, transfer + ".retained");
fs.mkdirSync(transfer);
fs.writeFileSync(path.join(transfer, "unrelated"), "preserve");
process.exit(42);
`,
    );

    const restored = await state.restoreSandboxState("alpha", backupPath);

    expect(restored.success).toBe(false);
    expect(restored.error).toContain("upload failed: exit 42");
    expect(restored.error).toContain("cleanup failed");
    const substituted = fs
      .readdirSync(nativeRoot)
      .find((name) => name.startsWith(".nemoclaw-native-restore") && !name.endsWith(".retained"))!;
    expect(fs.readFileSync(path.join(nativeRoot, substituted, "unrelated"), "utf8")).toBe(
      "preserve",
    );
    expect(fs.readFileSync(path.join(nativeRoot, "replacement"), "utf8")).toBe("unchanged");
  });

  it("rejects an unavailable SFTP client before obtaining target access", async () => {
    const calls = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 0,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: null,
      signal: null,
      error: new Error("ENOENT"),
    });
    syncBuiltinESMExports();

    const restored = await state.restoreSandboxState("alpha", backupPath);

    expect(restored.error).toContain("Install the OpenSSH client tools");
    expect(calls.mock.calls.map(([command]) => command)).toEqual(["sftp"]);
    expect(fs.readdirSync(nativeRoot)).toEqual(["replacement"]);
  });
});
