// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoundedRegularFile, snapshotBoundedExecutable } from "./bounded-file";

const temporaryDirectories: string[] = [];

function temporaryFile(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-bounded-file-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "input");
  fs.writeFileSync(filePath, contents);
  return filePath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("bounded regular file reads", () => {
  it("returns one stable regular file within its declared limit", () => {
    const filePath = temporaryFile("bounded input");

    expect(
      readBoundedRegularFile(filePath, {
        label: "fixture input",
        minBytes: 1,
        maxBytes: 32,
      }).toString("utf8"),
    ).toBe("bounded input");
  });

  it("rejects a symbolic link", () => {
    const filePath = temporaryFile("bounded input");
    const linkPath = path.join(path.dirname(filePath), "input-link");
    fs.symlinkSync(filePath, linkPath);

    expect(() =>
      readBoundedRegularFile(linkPath, {
        label: "fixture input",
        maxBytes: 32,
      }),
    ).toThrow();
  });

  it("rejects same-size source mutation observed after the bounded read", () => {
    const filePath = temporaryFile("12345678");
    const originalReadSync = fs.readSync;
    let changed = false;
    vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
      const bytesRead = Reflect.apply(originalReadSync, fs, args) as number;
      const mutateAfterRead = !changed;
      changed = true;
      mutateAfterRead ? fs.writeFileSync(filePath, "abcdefgh") : undefined;
      return bytesRead;
    }) as typeof fs.readSync);

    expect(() =>
      readBoundedRegularFile(filePath, {
        label: "fixture input",
        minBytes: 1,
        maxBytes: 8,
      }),
    ).toThrow("changed during bounded validation");
  });

  it("rejects a script whose interpreter is caller-writable", () => {
    const interpreter = temporaryFile("#!/bin/sh\nexit 0\n");
    fs.chmodSync(interpreter, 0o755);
    const script = temporaryFile(`#!${interpreter}\nexit 0\n`);
    fs.chmodSync(script, 0o755);

    expect(() =>
      snapshotBoundedExecutable(script, {
        label: "fixture executable",
        minBytes: 1,
        maxBytes: 1024,
        temporaryDirectoryPrefix: "nemoclaw-cua-executable-fixture-",
      }),
    ).toThrow("untrusted interpreter");
  });
});
