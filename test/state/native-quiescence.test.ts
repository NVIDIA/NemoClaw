// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  blockNativeSshCleanup,
  writeFakeOpenshell,
  writeFakeSsh,
  writeNativeQuiescenceStates,
  writeSnapshotRegistry,
} from "../support/native-snapshot.ts";

const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-quiescence-"));
process.env.HOME = home;
const sandboxState = await import("../../src/lib/state/sandbox.ts");
const { backupStartedSandboxState } =
  await import("../../src/lib/actions/sandbox/stopped-sandbox-backup.ts");
const backupsRoot = path.join(home, ".nemoclaw", "rebuild-backups");
const binDir = path.join(home, "bin");
const nativeRoot = path.join(home, "native-home");
const procRoot = path.join(home, "proc");
const signalLog = path.join(home, "signals");
const churnMarker = path.join(home, "churn-marker");

beforeEach(() => {
  fs.rmSync(backupsRoot, { recursive: true, force: true });
  fs.rmSync(procRoot, { recursive: true, force: true });
  fs.rmSync(churnMarker, { force: true });
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
  ["exited leader with stopped sibling", "Z", "Z", "T", false],
  ["exited thread group", "Z", "Z", "Z", false],
  ["native init ancestor", "T", "T", "T", true],
] as const)(
  "captures quiescent native state for %s",
  (_case, leader, first, second, initAncestor) => {
    vi.stubEnv("NEMOCLAW_TEST_NATIVE_INIT_ANCESTOR", String(Number(initAncestor)));
    writeNativeQuiescenceStates(procRoot, leader, first, second);
    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup.success, backup.error).toBe(true);
    assertNativeStateResumed();
    expect(backup.manifest?.backupComplete).toBe(true);
    const archive = path.join(backup.manifest!.backupPath, "native-home.tar");
    expect(spawnSync("tar", ["-xOf", archive, "./payload.txt"], { encoding: "utf8" }).stdout).toBe(
      "native payload",
    );
  },
);

it("classifies a churning live capture without retaining a failed backup (#12867)", () => {
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_CHURN_MARKER", churnMarker);
  const backup = sandboxState.backupSandboxState("alpha");
  expect(backup).toMatchObject({
    success: false,
    nativeChurn: true,
    error: expect.stringContaining("Native home/workspace capture failed: exit 21"),
  });
  expect(backup.unreachable).toBeUndefined();
  expect(fs.readdirSync(path.join(backupsRoot, "alpha"))).toEqual([]);
});

it("keeps a failed SSH cleanup from becoming a retryable capture (#12867)", () => {
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_CHURN_MARKER", churnMarker);
  const blockedCleanup = blockNativeSshCleanup();
  try {
    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup).toMatchObject({
      success: false,
      nativeChurn: false,
      error: expect.stringContaining("Remove that directory before retrying."),
    });
  } finally {
    blockedCleanup.restore();
    blockedCleanup.directories.forEach((directory) =>
      fs.rmSync(directory, { recursive: true, force: true }),
    );
  }
});

it("retries exit-21 capture through the default managed backup adapter (#12867)", async () => {
  vi.stubEnv("NEMOCLAW_TEST_NATIVE_CHURN_MARKER", churnMarker);
  writeNativeQuiescenceStates(procRoot, "Z", "Z", "T");
  const backup = await backupStartedSandboxState("alpha", {
    probe: () => true,
    sleep: async () => {},
  });
  expect(backup.success, backup.error).toBe(true);
  expect(fs.existsSync(churnMarker)).toBe(true);
  expect(backup.manifest?.backupComplete).toBe(true);
  expect(fs.readdirSync(path.join(backupsRoot, "alpha"))).toHaveLength(1);
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
