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
  it("creates config directories recursively with mode 0o700", () => {
    const dir = path.join(makeTempDir(), "a", "b", "c");
    ensureConfigDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink in place of the config directory", () => {
    // Place temp dir under HOME so rejectSymlinksOnPath inspects it.
    const home = process.env.HOME || os.homedir();
    const tmp = fs.mkdtempSync(path.join(home, ".nemoclaw-test-"));
    tmpDirs.push(tmp);
    const attackerDir = path.join(tmp, "attacker");
    fs.mkdirSync(attackerDir);
    const symlinkPath = path.join(tmp, ".nemoclaw");
    fs.symlinkSync(attackerDir, symlinkPath);

    expect(() => ensureConfigDir(symlinkPath)).toThrow(/symbolic link/);
    expect(() => ensureConfigDir(symlinkPath)).toThrow(/symlink attack/);
  });

  it("rejects a symlink in an ancestor of the config directory", () => {
    const home = process.env.HOME || os.homedir();
    const tmp = fs.mkdtempSync(path.join(home, ".nemoclaw-test-"));
    tmpDirs.push(tmp);
    const attackerDir = path.join(tmp, "attacker");
    fs.mkdirSync(attackerDir);
    const symlinkPath = path.join(tmp, ".nemoclaw");
    fs.symlinkSync(attackerDir, symlinkPath);
    const nestedDir = path.join(symlinkPath, "state");

    expect(() => ensureConfigDir(nestedDir)).toThrow(/symbolic link/);
  });

  it("allows a normal directory (no symlinks)", () => {
    const home = process.env.HOME || os.homedir();
    const tmp = fs.mkdtempSync(path.join(home, ".nemoclaw-test-"));
    tmpDirs.push(tmp);
    const dir = path.join(tmp, ".nemoclaw");
    ensureConfigDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(false);
  });

  it("tightens pre-existing weak directory permissions to 0o700", () => {
    const dir = path.join(makeTempDir(), "config");
    fs.mkdirSync(dir, { mode: 0o755 });

    ensureConfigDir(dir);

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
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
    const data = { token: "abc", nested: { enabled: true } };

    writeConfigFile(file, data);

    expect(readConfigFile(file, null)).toEqual(data);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
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
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("wraps permission errors with sudo and non-sudo remediation guidance", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "config.json");
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    try {
      expect(() => writeConfigFile(file, { ok: true })).toThrow(ConfigPermissionError);
      expect(() => writeConfigFile(file, { ok: true })).toThrow(/sudo chown/);
      expect(() => writeConfigFile(file, { ok: true })).toThrow(/\bmv\b/);
      expect(() => writeConfigFile(file, { ok: true })).toThrow(/HOME=/);
    } finally {
      fs.writeFileSync = originalWrite;
    }
  });

  it("supports both rich and legacy constructor forms", () => {
    const rich = new ConfigPermissionError("test error", "/some/path");
    expect(rich.name).toBe("ConfigPermissionError");
    expect(rich.code).toBe("EACCES");
    expect(rich.configPath).toBe("/some/path");
    expect(rich.filePath).toBe("/some/path");
    expect(rich.message).toContain("test error");
    expect(rich.remediation).toContain("sudo chown");
    expect(rich.remediation).toContain("mv ");
    expect(rich.remediation).toContain("HOME=");

    const legacy = new ConfigPermissionError("/other/path", "write");
    expect(legacy.filePath).toBe("/other/path");
    expect(legacy.message).toContain("Cannot write config file");
  });
});
