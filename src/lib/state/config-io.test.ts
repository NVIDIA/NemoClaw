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
} from "../../../dist/lib/state/config-io";

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

  it("readConfigFile repairs a 755 parent directory to 700", () => {
    const root = makeTempDir();
    const dir = path.join(root, "loose-dir");
    fs.mkdirSync(dir, { mode: 0o755 });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ repaired: true }), { mode: 0o600 });

    const result = readConfigFile(file, null);

    expect(result).toEqual({ repaired: true });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("readConfigFile repairs a 644 file to 600", () => {
    const dir = makeTempDir();
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ tight: true }), { mode: 0o644 });

    const result = readConfigFile(file, null);

    expect(result).toEqual({ tight: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("ensureConfigDir heals every root-level file in the dir, not just the one being read (#4546)", () => {
    // #4546 expects auto-repair across all root-level files. Most of those
    // files (onboard-session.json, ollama-proxy-token, etc.) are written by
    // code paths that don't flow through readConfigFile, so the read-time
    // per-file heal alone misses them. The dir walk in ensureConfigDir is
    // what covers them — verify by writing several siblings at 644 and
    // confirming a single read tightens all of them to 600.
    const dir = makeTempDir();
    fs.chmodSync(dir, 0o700);
    const target = path.join(dir, "config.json");
    fs.writeFileSync(target, JSON.stringify({ ok: true }), { mode: 0o600 });

    const siblings = [
      "onboard-session.json",
      "ollama-proxy-token",
      "ollama-auth-proxy.pid",
      "usage-notice.json",
    ];
    for (const name of siblings) {
      fs.writeFileSync(path.join(dir, name), "stale", { mode: 0o644 });
    }

    readConfigFile(target, null);

    for (const name of siblings) {
      const mode = fs.statSync(path.join(dir, name)).mode & 0o777;
      expect(mode, `${name} should be tightened to 600`).toBe(0o600);
    }
  });

  it("ensureConfigDir skips symlinks during the root-level heal", () => {
    // A chmod on a symlink follows to the target — if ~/.nemoclaw/X is a
    // symlink to /etc/passwd, healing must NOT chmod /etc/passwd. lstat
    // before chmod keeps the heal scoped to real files inside the dir.
    const dir = makeTempDir();
    fs.chmodSync(dir, 0o700);
    const target = path.join(dir, "config.json");
    fs.writeFileSync(target, JSON.stringify({ ok: true }), { mode: 0o600 });

    const outside = path.join(os.tmpdir(), `nemoclaw-symlink-target-${String(process.pid)}`);
    fs.writeFileSync(outside, "outside", { mode: 0o644 });
    const linkPath = path.join(dir, "rogue-link");
    fs.symlinkSync(outside, linkPath);

    try {
      readConfigFile(target, null);
      expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
    } finally {
      fs.unlinkSync(linkPath);
      fs.unlinkSync(outside);
    }
  });

  it("readConfigFile does not chmod through a symlink even via the per-file heal", () => {
    // Defensive duplicate of the symlink check, this time for the per-file
    // heal in readConfigFile itself (not the dir walk in ensureConfigDir).
    const dir = makeTempDir();
    fs.chmodSync(dir, 0o700);

    const outside = path.join(os.tmpdir(), `nemoclaw-symlink-readtarget-${String(process.pid)}`);
    fs.writeFileSync(outside, JSON.stringify({ outside: true }), { mode: 0o644 });
    const symlinkPath = path.join(dir, "config.json");
    fs.symlinkSync(outside, symlinkPath);

    try {
      // Reading through the symlink should not chmod the target file.
      readConfigFile(symlinkPath, null);
      expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
    } finally {
      fs.unlinkSync(symlinkPath);
      fs.unlinkSync(outside);
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
