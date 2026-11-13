// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  writeFakeOpenshell,
  writeFakeSsh,
  writeSnapshotRegistry,
} from "../support/native-snapshot.ts";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-observability-marker-home-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

type MarkerPaths = { marker: string; session: string };

// Backs up a native home holding a session file (and optionally the marker),
// lets `mutateReplacement` change the replacement sandbox, restores, then
// hands the restored paths to `verify`.
async function rebuildWithReplacement(
  archivedMarker: boolean,
  mutateReplacement: (paths: MarkerPaths) => void,
  verify: (paths: MarkerPaths) => void,
): Promise<void> {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-observability-marker-"));
  const saved = [
    "PATH",
    "NEMOCLAW_OPENSHELL_BIN",
    "NEMOCLAW_TEST_NATIVE_ROOT",
    "NEMOCLAW_TEST_NATIVE_HOME",
    "NEMOCLAW_TEST_NATIVE_WORKSPACE",
    "NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT",
  ].map((name) => [name, process.env[name]] as const);
  try {
    const binDir = path.join(fixture, "bin");
    const nativeRoot = path.join(fixture, "native-home");
    const paths: MarkerPaths = {
      marker: path.join(nativeRoot, ".deepagents", ".nemoclaw-observability-enabled"),
      session: path.join(nativeRoot, ".deepagents", "session.json"),
    };
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.dirname(paths.session), { recursive: true });
    fs.writeFileSync(paths.session, "archived-session\n");
    archivedMarker && fs.writeFileSync(paths.marker, "1\n");
    writeFakeOpenshell(binDir);
    writeFakeSsh(binDir);
    process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
    process.env.NEMOCLAW_TEST_NATIVE_ROOT = nativeRoot;
    process.env.NEMOCLAW_TEST_NATIVE_HOME = nativeRoot;
    process.env.NEMOCLAW_TEST_NATIVE_WORKSPACE = nativeRoot;
    process.env.NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT = "1";
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    writeSnapshotRegistry(TMP_HOME, "alpha", null);
    const backup = sandboxState.backupSandboxState("alpha", {
      nativeStateSource: {
        root: nativeRoot,
        directory: nativeRoot,
        assertCurrent: () => undefined,
      },
    });
    expect(backup.success, backup.error).toBe(true);
    const archivedPaths = spawnSync("tar", [
      "-tf",
      path.join(backup.manifest!.backupPath, "native-home.tar"),
    ]).stdout.toString();
    expect(archivedPaths).toContain(".deepagents/session.json");
    expect(archivedPaths).not.toContain(".nemoclaw-observability-enabled");
    fs.writeFileSync(paths.session, "replacement-session\n");
    mutateReplacement(paths);
    const restore = await sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);
    expect(restore.success, restore.error).toBe(true);
    expect(fs.readFileSync(paths.session, "utf8")).toBe("archived-session\n");
    verify(paths);
  } finally {
    for (const [name, value] of saved) restoreEnv(name, value);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

describe("native restore keeps the replacement observability marker (#14302)", () => {
  it("keeps the marker the replacement wrote when rebuild turns observability on", async () => {
    await rebuildWithReplacement(
      false,
      ({ marker }) => fs.writeFileSync(marker, "1\n", { mode: 0o444 }),
      ({ marker }) => expect(fs.readFileSync(marker, "utf8")).toBe("1\n"),
    );
  });

  it("does not resurrect the archived marker when rebuild turns observability off", async () => {
    await rebuildWithReplacement(
      true,
      ({ marker }) => fs.rmSync(marker, { force: true }),
      ({ marker }) => expect(fs.existsSync(marker)).toBe(false),
    );
  });
});
