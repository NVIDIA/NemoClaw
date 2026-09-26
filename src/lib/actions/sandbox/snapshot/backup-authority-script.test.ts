// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HERMES_STATE_CAPTURE_SCRIPT } from "./backup-authority";

const fixtureRoots: string[] = [];
const linuxIt = process.platform === "linux" ? it : it.skip;

function fixtureDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-capture-"));
  fixtureRoots.push(root);
  const directory = path.join(root, ".openclaw");
  fs.mkdirSync(directory);
  return directory;
}

function hermesCopyMutationHarness(mutation: string): string {
  return `import os, sys
capture_script = ${JSON.stringify(HERMES_STATE_CAPTURE_SCRIPT)}
base = sys.argv[1]
relative = sys.argv[2]
real_read = os.read
mutated = False
def mutate_after_first_read(fd, size):
    global mutated
    data = real_read(fd, size)
    if not mutated:
        mutated = True
${mutation}
    return data
os.read = mutate_after_first_read
exec(capture_script)
`;
}

function hermesSqliteMutationHarness(mutation: string): string {
  return `import os, sqlite3, sys
capture_script = ${JSON.stringify(HERMES_STATE_CAPTURE_SCRIPT)}
base = sys.argv[1]
relative = sys.argv[2]
real_connect = sqlite3.connect
mutated = False
def mutate_before_connect(database, *args, **kwargs):
    global mutated
    if not mutated and str(database).startswith("file:/proc/self/fd/"):
        mutated = True
${mutation}
    return real_connect(database, *args, **kwargs)
sqlite3.connect = mutate_before_connect
exec(capture_script)
`;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Hermes privileged state capture scripts", () => {
  it("captures a regular file while rejecting unsafe file metadata", () => {
    const directory = fixtureDirectory();
    fs.writeFileSync(path.join(directory, "SOUL.md"), "soul");
    const copied = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", HERMES_STATE_CAPTURE_SCRIPT, directory, "SOUL.md", "copy"],
      { encoding: null },
    );
    expect(copied.status).toBe(0);
    expect(copied.stdout).toEqual(Buffer.from("soul"));
    fs.symlinkSync(path.join(directory, "SOUL.md"), path.join(directory, "unsafe"));
    const unsafe = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", HERMES_STATE_CAPTURE_SCRIPT, directory, "unsafe", "copy"],
      { encoding: null },
    );
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stdout).toEqual(Buffer.alloc(0));
  });

  // The shipped sandbox probe opens SQLite through Linux /proc/self/fd.
  linuxIt("uses SQLite backup with a valid database", () => {
    const directory = fixtureDirectory();
    const database = path.join(directory, "state.db");
    expect(
      spawnSync("/usr/bin/python3", [
        "-c",
        `import sqlite3; db = sqlite3.connect(${JSON.stringify(database)}); db.execute('create table state (value text)'); db.execute("insert into state values ('saved')"); db.commit()`,
      ]).status,
    ).toBe(0);
    const captured = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", HERMES_STATE_CAPTURE_SCRIPT, directory, "state.db", "sqlite_backup"],
      { encoding: null },
    );
    expect(captured.status).toBe(0);
    const restored = path.join(directory, "restored.db");
    fs.writeFileSync(restored, captured.stdout);
    expect(
      spawnSync("/usr/bin/python3", [
        "-c",
        `import sqlite3; assert sqlite3.connect(${JSON.stringify(restored)}).execute('select value from state').fetchone() == ('saved',)`,
      ]).status,
    ).toBe(0);
  });

  it("captures a state file larger than the previous privileged buffer limit", () => {
    const directory = fixtureDirectory();
    const expected = Buffer.alloc(18 * 1024 * 1024, 0xa5);
    fs.writeFileSync(path.join(directory, "SOUL.md"), expected);

    const captured = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", HERMES_STATE_CAPTURE_SCRIPT, directory, "SOUL.md", "copy"],
      { encoding: null, maxBuffer: 256 * 1024 * 1024 },
    );

    expect(captured.status).toBe(0);
    expect(captured.stdout).toHaveLength(expected.length);
    expect(captured.stdout.equals(expected)).toBe(true);
  });

  it("rejects a copied file replaced during capture without returning bytes", () => {
    const directory = fixtureDirectory();
    const source = path.join(directory, "SOUL.md");
    const outside = path.join(path.dirname(directory), "outside-copy");
    fs.writeFileSync(source, Buffer.alloc(128 * 1024, 0x61));
    fs.writeFileSync(outside, "outside-secret");
    const script = hermesCopyMutationHarness(
      `        original = os.path.join(base, relative)\n` +
        `        os.rename(original, original + ".old")\n` +
        `        os.symlink(${JSON.stringify(outside)}, original)`,
    );

    const captured = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", script, directory, "SOUL.md", "copy"],
      { encoding: null },
    );

    expect(captured.status).toBe(13);
    expect(captured.stdout).toEqual(Buffer.alloc(0));
  });

  // The shipped sandbox probe opens SQLite through Linux /proc/self/fd.
  linuxIt("rejects a SQLite file replaced during capture without returning bytes", () => {
    const directory = fixtureDirectory();
    const database = path.join(directory, "state.db");
    const outside = path.join(path.dirname(directory), "outside.db");
    expect(
      spawnSync("/usr/bin/python3", [
        "-c",
        `import sqlite3; db = sqlite3.connect(${JSON.stringify(database)}); db.execute('create table state (value text)'); db.execute("insert into state values ('saved')"); db.commit()`,
      ]).status,
    ).toBe(0);
    expect(
      spawnSync("/usr/bin/python3", [
        "-c",
        `import sqlite3; db = sqlite3.connect(${JSON.stringify(outside)}); db.execute('create table state (value text)'); db.execute("insert into state values ('saved')"); db.commit()`,
      ]).status,
    ).toBe(0);
    const script = hermesSqliteMutationHarness(
      `        original = os.path.join(base, relative)\n` +
        `        os.rename(original, original + ".old")\n` +
        `        os.symlink(${JSON.stringify(outside)}, original)`,
    );

    const captured = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", script, directory, "state.db", "sqlite_backup"],
      { encoding: null },
    );

    expect(captured.status).toBe(13);
    expect(captured.stdout).toEqual(Buffer.alloc(0));
  });

  it("rejects an intermediate directory replaced during capture", () => {
    const directory = fixtureDirectory();
    const runtime = path.join(directory, "runtime");
    const outside = path.join(path.dirname(directory), "outside-runtime");
    fs.mkdirSync(runtime);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(runtime, "state.db"), Buffer.alloc(128 * 1024, 0x61));
    fs.writeFileSync(path.join(outside, "state.db"), "outside-secret");
    const script = hermesCopyMutationHarness(
      `        original = os.path.join(base, "runtime")\n` +
        `        os.rename(original, original + ".old")\n` +
        `        os.symlink(${JSON.stringify(outside)}, original)`,
    );

    const captured = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", script, directory, "runtime/state.db", "copy"],
      { encoding: null },
    );

    expect(captured.status).toBe(13);
    expect(captured.stdout).toEqual(Buffer.alloc(0));
  });
});
