// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempSshConfig } from "./temp-ssh-config.js";

describe("createTempSshConfig", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-temp-ssh-test-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(tmpRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes the SSH config inside a private mkdtemp directory and cleans it up", () => {
    const temp = createTempSshConfig("Host openshell-alpha\n", "nemoclaw-ssh-test-");
    const expectedParentPrefix = path.join(tmpRoot, "nemoclaw-ssh-test-");

    expect(temp.dir).not.toBe(tmpRoot);
    expect(temp.dir.startsWith(expectedParentPrefix)).toBe(true);
    expect(temp.file).toBe(path.join(temp.dir, "ssh_config"));
    expect(fs.readFileSync(temp.file, "utf-8")).toBe("Host openshell-alpha\n");
    expect((fs.statSync(temp.file).mode & 0o777).toString(8)).toBe("600");

    temp.cleanup();

    expect(fs.existsSync(temp.dir)).toBe(false);
  });

  it("removes the private directory when writing the SSH config fails", () => {
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("write failed");
    });

    expect(() => createTempSshConfig("Host openshell-alpha\n", "nemoclaw-ssh-fail-")).toThrow(
      "write failed",
    );

    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });
});
