// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  writeFakeOpenshell,
  writeFakeSsh,
  writeNativeQuiescenceStates,
  writeSnapshotRegistry,
} from "../support/native-snapshot.ts";

const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-quiescence-"));
process.env.HOME = home;
const sandboxState = await import("../../src/lib/state/sandbox.ts");
const backupsRoot = path.join(home, ".nemoclaw", "rebuild-backups");
const binDir = path.join(home, "bin");
const nativeRoot = path.join(home, "native-home");
const procRoot = path.join(home, "proc");
const signalLog = path.join(home, "signals");

beforeEach(() => {
  fs.rmSync(backupsRoot, { recursive: true, force: true });
  fs.rmSync(procRoot, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.writeFileSync(signalLog, "");
  fs.writeFileSync(path.join(nativeRoot, "payload.txt"), "native payload");
  writeFakeOpenshell(binDir);
  writeFakeSsh(binDir);
  writeSnapshotRegistry(home, "alpha");
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", path.join(binDir, "openshell"));
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_ROOT", nativeRoot);
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_HOME", nativeRoot);
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_PROC", procRoot);
  vi.stubEnv("NEMOCLAW_TEST_SIGNAL_LOG", signalLog);
});

afterAll(() => {
  originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
  fs.rmSync(home, { recursive: true, force: true });
});

function assertNativeStateResumed(): void {
  expect(fs.readFileSync(signalLog, "utf8").trim().split("\n")).toEqual([
    "-STOP 424242",
    "-CONT 424242",
  ]);
  expect(fs.readFileSync(path.join(nativeRoot, "payload.txt"), "utf8")).toBe("native payload");
}

it.each([
  ["exited leader with stopped sibling", "Z", "Z", "T"],
  ["exited thread group", "Z", "Z", "Z"],
] as const)("captures quiescent native state for %s", (_case, leader, first, second) => {
  writeNativeQuiescenceStates(procRoot, leader, first, second);
  const backup = sandboxState.backupSandboxState("alpha");
  expect(backup.success, backup.error).toBe(true);
  assertNativeStateResumed();
  expect(backup.manifest?.backupComplete).toBe(true);
  const archive = path.join(backup.manifest!.backupPath, "native-home.tar");
  expect(spawnSync("tar", ["-xOf", archive, "./payload.txt"], { encoding: "utf8" }).stdout).toBe(
    "native payload",
  );
});

it.each([
  ["exited leader with running sibling", "Z", "Z", "S"],
  ["stopped leader with running sibling", "T", "T", "S"],
  ["missing task inventory", "T", null, null],
  ["unreadable task state", "T", "T", ""],
] as const)("rejects native capture with %s", (_case, leader, first, second) => {
  writeNativeQuiescenceStates(procRoot, leader, first, second);
  const backup = sandboxState.backupSandboxState("alpha");
  expect(backup.success, backup.error).toBe(false);
  assertNativeStateResumed();
  expect(backup.error).toContain("Native home/workspace capture failed");
  expect(fs.readdirSync(path.join(backupsRoot, "alpha"))).toEqual([]);
});
