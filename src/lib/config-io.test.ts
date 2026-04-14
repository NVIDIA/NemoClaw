// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigPermissionError,
  ensureConfigDir,
  readConfigFile,
  writeConfigFile,
} from "../../dist/lib/config-io";

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-io-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config-io", () => {
  it("creates config directories recursively", () => {
    const dir = path.join(makeTempDir(), "a", "b", "c");
    ensureConfigDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("returns the fallback when the config file is missing", () => {
    const file = path.join(makeTempDir(), "missing.json");
    expect(readConfigFile(file, { ok: true })).toEqual({ ok: true });
  });

  it("returns the fallback when the config file is malformed", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{not-json");
    expect(readConfigFile(file, { ok: true })).toEqual({ ok: true });
  });

  it("writes and reads JSON atomically", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "config.json");
    writeConfigFile(file, { token: "abc", nested: { enabled: true } });

    expect(readConfigFile(file, null)).toEqual({ token: "abc", nested: { enabled: true } });
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  it("cleans up temp files when rename fails", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "config.json");
    const originalRename = fs.renameSync;
    fs.renameSync = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    try {
      expect(() => writeConfigFile(file, { ok: true })).toThrow(ConfigPermissionError);
    } finally {
      fs.renameSync = originalRename;
    }
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  it("wraps permission errors with a user-facing error", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "config.json");
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    try {
      expect(() => writeConfigFile(file, { ok: true })).toThrow(ConfigPermissionError);
      expect(() => writeConfigFile(file, { ok: true })).toThrow(/HOME points to a user-owned directory/);
    } finally {
      fs.writeFileSync = originalWrite;
    }
  });
});
