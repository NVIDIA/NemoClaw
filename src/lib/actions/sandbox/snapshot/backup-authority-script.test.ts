// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { OPENCLAW_CONFIG_CAPTURE_SCRIPT } from "./backup-authority";

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

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
