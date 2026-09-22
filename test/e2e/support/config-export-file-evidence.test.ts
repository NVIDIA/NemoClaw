// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readProtectedConfigExportFile } from "./config-export-file-evidence.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-export-evidence-"));
  directories.push(directory);
  return directory;
}

describe("protected config export evidence reads", () => {
  it("reads a bounded regular file through its verified descriptor", () => {
    const filePath = path.join(temporaryDirectory(), "config.yaml");
    fs.writeFileSync(filePath, "kind: NemoClawConfig\n");

    expect(readProtectedConfigExportFile(filePath)).toEqual({
      ok: true,
      raw: "kind: NemoClawConfig\n",
    });
  });

  it("rejects a symlink instead of reading its target", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "host-file");
    const output = path.join(directory, "config.yaml");
    fs.writeFileSync(target, "host-only contents");
    fs.symlinkSync(target, output);

    expect(readProtectedConfigExportFile(output)).toEqual({
      ok: false,
      reason: "export output could not be opened safely",
    });
  });

  it("rejects a file with another hard link", () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "config.yaml");
    fs.writeFileSync(output, "kind: NemoClawConfig\n");
    fs.linkSync(output, path.join(directory, "second-link.yaml"));

    expect(readProtectedConfigExportFile(output)).toEqual({
      ok: false,
      reason: "export output must have exactly one hard link",
    });
  });

  it("rejects a file larger than the configured bound", () => {
    const output = path.join(temporaryDirectory(), "config.yaml");
    fs.writeFileSync(output, "12345");

    expect(readProtectedConfigExportFile(output, 4)).toEqual({
      ok: false,
      reason: "export output exceeds the 4-byte limit",
    });
  });
});
