// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  writeExecutable,
  writeFakeOpenshell,
  writeFakeSsh,
  writeOpenClawRegistry,
} from "../support/snapshot-native-processes";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-late-state-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(TMP_HOME, ".nemoclaw", "rebuild-backups"), { recursive: true, force: true });
});

type CollisionKind =
  | "owned-directory"
  | "owned-symlink"
  | "foreign-directory"
  | "foreign-symlink"
  | "last-moment-directory";

async function restoreWithLateCollision(collisionKind: CollisionKind) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-late-directory-"));
  const binDir = path.join(fixture, "bin");
  const nativeRoot = path.join(fixture, "native-home");
  const hermes = path.join(nativeRoot, ".hermes");
  const kanban = path.join(hermes, "kanban");
  const outside = path.join(fixture, "outside");
  const dispose = () => {
    fs.existsSync(kanban) && !fs.lstatSync(kanban).isSymbolicLink() && fs.chmodSync(kanban, 0o700);
    fs.rmSync(fixture, { recursive: true, force: true });
  };
  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(kanban, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "untouched.txt"), "outside state");
    fs.writeFileSync(path.join(kanban, "archived-board.txt"), "retained board");
    fs.writeFileSync(path.join(hermes, "sibling.txt"), "retained sibling");
    writeFakeOpenshell(binDir);
    writeFakeSsh(binDir);
    // A startup writer creates its default directory after the target glob is expanded.
    writeExecutable(
      path.join(binDir, "stat"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const target = process.argv.at(-1);
if (process.argv[2] !== "-c" || process.argv[3] !== "%u" || !target) process.exit(95);
if (path.basename(target) === "replacement-only-trigger") {
  const kind = ${JSON.stringify(collisionKind)};
  if (kind.endsWith("symlink")) {
    fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(kanban)});
  } else if (kind !== "last-moment-directory") {
    fs.mkdirSync(${JSON.stringify(kanban)});
    fs.writeFileSync(${JSON.stringify(path.join(kanban, "replacement-board.txt"))}, "replacement default");
    if (kind === "foreign-directory") fs.chmodSync(${JSON.stringify(kanban)}, 0o555);
  }
}
const foreign = ${JSON.stringify(collisionKind)}.startsWith("foreign-") && (target === ${JSON.stringify(kanban)} || path.dirname(target) === ${JSON.stringify(kanban)});
process.stdout.write(String(fs.lstatSync(target).uid + (foreign ? 1 : 0)) + "\\n");
`,
    );
    const systemMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
    expect(systemMv).not.toBe("");
    writeExecutable(
      path.join(binDir, "mv"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const source = args.at(-2);
const destination = args.at(-1);
if (${collisionKind === "last-moment-directory"} && path.basename(source) === "kanban" && destination === ${JSON.stringify(`${hermes}/`)}) {
  fs.mkdirSync(${JSON.stringify(kanban)});
  fs.writeFileSync(${JSON.stringify(path.join(kanban, "replacement-board.txt"))}, "replacement default");
}
const result = spawnSync(${JSON.stringify(systemMv)}, args, { stdio: "inherit" });
process.exit(result.status ?? 96);
`,
    );
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", path.join(binDir, "openshell"));
    vi.stubEnv("NEMOCLAW_TEST_NATIVE_ROOT", nativeRoot);
    vi.stubEnv("NEMOCLAW_TEST_NATIVE_HOME", nativeRoot);
    vi.stubEnv("NEMOCLAW_TEST_NATIVE_WORKSPACE", nativeRoot);
    vi.stubEnv("NEMOCLAW_TEST_EXECUTE_RESTORE_SCRIPT", "1");
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    writeOpenClawRegistry(TMP_HOME, "alpha");
    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup.success, backup.error).toBe(true);
    const backupPath = backup.manifest!.backupPath;
    const archiveBefore = fs.readFileSync(path.join(backupPath, "native-home.tar"));
    fs.rmSync(kanban, { recursive: true });
    fs.writeFileSync(path.join(hermes, "replacement-only-trigger"), "startup trigger");
    fs.writeFileSync(path.join(hermes, "sibling.txt"), "replacement sibling");
    fs.mkdirSync(path.join(hermes, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(hermes, "runtime", "gateway.pid"), "replacement-pid");
    const restored = await sandboxState.restoreSandboxState("alpha", backupPath);
    expect(fs.readdirSync(outside)).toEqual(["untouched.txt"]);
    expect(fs.readFileSync(path.join(outside, "untouched.txt"), "utf8")).toBe("outside state");
    expect(fs.readFileSync(path.join(hermes, "runtime", "gateway.pid"), "utf8")).toBe(
      "replacement-pid",
    );
    expect(fs.readFileSync(path.join(backupPath, "native-home.tar"))).toEqual(archiveBefore);
    expect(
      fs.readdirSync(nativeRoot).some((name) => name.startsWith(".nemoclaw-native-restore.")),
    ).toBe(false);
    return { restored, kanban, hermes, outside, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

describe("late native restore collisions", () => {
  it.each(["owned-directory", "owned-symlink"] as const)(
    "restores archived state when a late %s appears",
    async (collisionKind) => {
      const fixture = await restoreWithLateCollision(collisionKind);
      try {
        expect(fixture.restored.success, fixture.restored.error).toBe(true);
        expect(fs.lstatSync(fixture.kanban).isSymbolicLink()).toBe(false);
        expect(fs.readdirSync(fixture.kanban)).toEqual(["archived-board.txt"]);
        expect(fs.readFileSync(path.join(fixture.kanban, "archived-board.txt"), "utf8")).toBe(
          "retained board",
        );
        expect(fs.readFileSync(path.join(fixture.hermes, "sibling.txt"), "utf8")).toBe(
          "retained sibling",
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it("preserves a foreign directory that appears during restore", async () => {
    const fixture = await restoreWithLateCollision("foreign-directory");
    try {
      expect(fixture.restored.success).toBe(false);
      expect(fixture.restored.error).toContain(
        "native restore could not remove replacement-only state",
      );
      expect(fs.readdirSync(fixture.kanban)).toEqual(["replacement-board.txt"]);
      expect(fs.readFileSync(path.join(fixture.kanban, "replacement-board.txt"), "utf8")).toBe(
        "replacement default",
      );
    } finally {
      fixture.dispose();
    }
  });

  it("preserves a foreign symlink that appears during restore", async () => {
    const fixture = await restoreWithLateCollision("foreign-symlink");
    try {
      expect(fixture.restored.success).toBe(false);
      expect(fixture.restored.error).toContain("native restore could not preserve archived state");
      expect(fs.readlinkSync(fixture.kanban)).toBe(fixture.outside);
    } finally {
      fixture.dispose();
    }
  });

  it("does not overwrite a directory created immediately before the move", async () => {
    const fixture = await restoreWithLateCollision("last-moment-directory");
    try {
      expect(fixture.restored.success).toBe(false);
      expect(fixture.restored.error).toContain("Native home/workspace restore failed");
      expect(fs.readdirSync(fixture.kanban)).toEqual(["replacement-board.txt"]);
      expect(fs.readFileSync(path.join(fixture.kanban, "replacement-board.txt"), "utf8")).toBe(
        "replacement default",
      );
    } finally {
      fixture.dispose();
    }
  });
});
