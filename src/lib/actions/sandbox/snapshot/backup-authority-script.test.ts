// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  HERMES_DIRECTORY_CAPTURE_SCRIPT,
  HERMES_STATE_CAPTURE_SCRIPT,
  OPENCLAW_CONFIG_CAPTURE_SCRIPT,
} from "./backup-authority";

const CONFIG_NAME = "openclaw.json";
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const PROTOCOL_PREFIX = "nemoclaw-openclaw-config-capture:";
const fixtureRoots: string[] = [];

interface CaptureResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function fixtureDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-capture-"));
  fixtureRoots.push(root);
  const directory = path.join(root, ".openclaw");
  fs.mkdirSync(directory);
  return directory;
}

function runCapture(directory: string, script = OPENCLAW_CONFIG_CAPTURE_SCRIPT): CaptureResult {
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", script, directory, CONFIG_NAME], {
    encoding: null,
    timeout: 30_000,
    maxBuffer: MAX_CONFIG_BYTES + 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "",
  };
}

function mutationHarness(mutation: string): string {
  return `import os, sys
capture_script = ${JSON.stringify(OPENCLAW_CONFIG_CAPTURE_SCRIPT)}
directory = sys.argv[1]
name = sys.argv[2]
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

function hermesDirectoryMutationHarness(mutation: string): string {
  return `import os, sys, tarfile
capture_script = ${JSON.stringify(HERMES_DIRECTORY_CAPTURE_SCRIPT)}
base = sys.argv[1]
real_addfile = tarfile.TarFile.addfile
mutated = False
def mutate_before_file_read(archive, info, fileobj=None):
    global mutated
    if fileobj is not None and not mutated:
        mutated = True
${mutation}
    return real_addfile(archive, info, fileobj)
tarfile.TarFile.addfile = mutate_before_file_read
exec(capture_script)
`;
}

function hermesDirectoryListingMutationHarness(mutation: string): string {
  return `import os, sys
capture_script = ${JSON.stringify(HERMES_DIRECTORY_CAPTURE_SCRIPT)}
real_listdir = os.listdir
mutated = False
def mutate_after_list(descriptor):
    global mutated
    entries = real_listdir(descriptor)
    if not mutated:
        mutated = True
${mutation}
    return entries
os.listdir = mutate_after_list
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

  it("uses SQLite backup with a valid database", () => {
    const directory = fixtureDirectory();
    const database = path.join(directory, "state.db");
    expect(
      spawnSync("/usr/bin/python3", [
        "-c",
        `import sqlite3; db = sqlite3.connect(${JSON.stringify(database)}); db.execute('create table state (value text)'); db.execute(\"insert into state values ('saved')\"); db.commit()`,
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

  it("rejects a SQLite file replaced during capture without returning bytes", () => {
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

  it.each([
    ["symbolic link", "os.symlink"],
    ["hard link", "os.link"],
  ])("rejects a directory file replaced with a %s during archive read", (_kind, replacement) => {
    const directory = fixtureDirectory();
    const workspace = path.join(directory, "workspace");
    const marker = path.join(workspace, "marker");
    const outside = path.join(path.dirname(directory), "outside-directory-file");
    fs.mkdirSync(workspace);
    fs.writeFileSync(marker, Buffer.alloc(128 * 1024, 0x61));
    fs.writeFileSync(outside, "outside-secret");
    const mutation =
      `        original = os.path.join(base, "workspace", "marker")\n` +
      `        os.rename(original, original + ".old")\n` +
      `        replacement = ${replacement}\n` +
      `        replacement(${JSON.stringify(outside)}, original)`;
    const script = hermesDirectoryMutationHarness(mutation);

    const captured = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", script, directory, "workspace"],
      { encoding: null },
    );

    expect(captured.status).toBe(13);
    expect(captured.stdout.includes(Buffer.from("outside-secret"))).toBe(false);
  });

  it("rejects a directory entry created after traversal starts", () => {
    const directory = fixtureDirectory();
    const workspace = path.join(directory, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "marker"), "state");
    const script = hermesDirectoryListingMutationHarness(
      `        descriptor = os.open("late-state", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=descriptor)\n` +
        `        os.write(descriptor, b"late")\n` +
        `        os.close(descriptor)`,
    );

    const captured = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", script, directory, "workspace"],
      { encoding: null },
    );

    expect(captured.status).toBe(13);
    expect(fs.readFileSync(path.join(workspace, "late-state"), "utf8")).toBe("late");
  });

  it("rejects unsafe directory entries before streaming a tar archive", () => {
    const directory = fixtureDirectory();
    const workspace = path.join(directory, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "marker"), "state");
    const captured = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", HERMES_DIRECTORY_CAPTURE_SCRIPT, directory, "workspace"],
      { encoding: null },
    );
    expect(captured.status).toBe(0);
    expect(spawnSync("tar", ["-tf", "-"], { input: captured.stdout }).status).toBe(0);
    fs.symlinkSync(path.join(workspace, "marker"), path.join(workspace, "unsafe"));
    const unsafe = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", HERMES_DIRECTORY_CAPTURE_SCRIPT, directory, "workspace"],
      { encoding: null },
    );
    expect(unsafe.status).not.toBe(0);
  });
});

describe("OpenClaw privileged config capture script", () => {
  it("returns bytes only for a stable regular file", () => {
    const directory = fixtureDirectory();
    const expected = Buffer.from('{"models":{"default":"nvidia/test"}}\n');
    fs.writeFileSync(path.join(directory, CONFIG_NAME), expected);

    const result = runCapture(directory);

    expect(result).toEqual({ status: 0, stdout: expected, stderr: "" });
  });

  it("returns all bytes for a stable file at the 16 MiB limit", () => {
    const directory = fixtureDirectory();
    const expected = Buffer.alloc(MAX_CONFIG_BYTES, 0xa5);
    fs.writeFileSync(path.join(directory, CONFIG_NAME), expected);

    const result = runCapture(directory);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toHaveLength(expected.length);
    expect(result.stdout.equals(expected)).toBe(true);
  });

  it.each([
    {
      kind: "symbolic link",
      setup(directory: string) {
        const target = path.join(path.dirname(directory), "target.json");
        fs.writeFileSync(target, "target");
        fs.symlinkSync(target, path.join(directory, CONFIG_NAME));
      },
    },
    {
      kind: "hard link",
      setup(directory: string) {
        const target = path.join(path.dirname(directory), "target.json");
        fs.writeFileSync(target, "target");
        fs.linkSync(target, path.join(directory, CONFIG_NAME));
      },
    },
    {
      kind: "FIFO",
      setup(directory: string) {
        const result = spawnSync("mkfifo", [path.join(directory, CONFIG_NAME)]);
        expect(result.status).toBe(0);
      },
    },
    {
      kind: "directory",
      setup(directory: string) {
        fs.mkdirSync(path.join(directory, CONFIG_NAME));
      },
    },
    {
      kind: "oversized file",
      setup(directory: string) {
        const descriptor = fs.openSync(path.join(directory, CONFIG_NAME), "w");
        try {
          fs.ftruncateSync(descriptor, MAX_CONFIG_BYTES + 1);
        } finally {
          fs.closeSync(descriptor);
        }
      },
    },
  ])("rejects a $kind without returning captured bytes", ({ setup }) => {
    const directory = fixtureDirectory();
    setup(directory);

    const result = runCapture(directory);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(result.stderr).toContain(PROTOCOL_PREFIX);
  });

  it("rejects a file replaced during the read without returning captured bytes", () => {
    const directory = fixtureDirectory();
    fs.writeFileSync(path.join(directory, CONFIG_NAME), "original");
    const script = mutationHarness(
      `        original = os.path.join(directory, name)\n` +
        `        os.rename(original, original + ".old")\n` +
        `        with open(original, "wb") as replacement:\n` +
        `            replacement.write(b"replacement")`,
    );

    const result = runCapture(directory, script);

    expect(result.status).toBe(13);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(result.stderr).toBe(`${PROTOCOL_PREFIX}file-changed-during-read\n`);
  });

  it("rejects a directory replaced during the read without returning captured bytes", () => {
    const directory = fixtureDirectory();
    fs.writeFileSync(path.join(directory, CONFIG_NAME), "original");
    const script = mutationHarness(
      `        os.rename(directory, directory + ".old")\n` +
        `        os.mkdir(directory)\n` +
        `        with open(os.path.join(directory, name), "wb") as replacement:\n` +
        `            replacement.write(b"replacement")`,
    );

    const result = runCapture(directory, script);

    expect(result.status).toBe(13);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(result.stderr).toBe(`${PROTOCOL_PREFIX}directory-changed-during-read\n`);
  });
});
