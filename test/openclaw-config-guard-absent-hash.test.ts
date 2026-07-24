// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GUARD_PATH = path.resolve("scripts/openclaw-config-guard.py");
const fixtures: string[] = [];

const RUN_AS_CURRENT_USER = String.raw`
import importlib.util
import os
import sys

guard_path, action, config_dir, failure = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("nemoclaw_openclaw_config_guard", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(),
    root_gid=os.getgid(),
    sandbox_uid=os.getuid(),
    sandbox_gid=os.getgid(),
)
module.os.geteuid = lambda: 0
module._production_identity = lambda: identity
module.PRODUCTION_CONFIG_DIR = config_dir
module.JOURNAL_PATH = os.path.join(os.path.dirname(config_dir), ".nemoclaw-test", "transaction.json")
module.MUTEX_PATH = os.path.join(os.path.dirname(config_dir), ".nemoclaw-test", "mutation.lock")
module.STARTUP_READY_PATH = os.path.join(os.path.dirname(config_dir), ".nemoclaw-test", "ready.json")
module.STARTUP_CAPABILITY_PATH = os.path.join(os.path.dirname(config_dir), ".nemoclaw-test", "ready-capability.json")
module.NODE_BINARY_PATH = os.environ.get("NEMOCLAW_TEST_NODE_PATH", module.NODE_BINARY_PATH)
module.JSON5_MODULE_PATH = os.environ.get("NEMOCLAW_TEST_JSON5_PATH", module.JSON5_MODULE_PATH)
if failure in {"install-fails-hash-vanishes", "install-fails-hash-vanishes-publish-fails"}:
    def vanish_then_fail(opened, targets):
        os.unlink(os.path.join(config_dir, ".config-hash"))
        raise OSError("injected install failure")
    module._install_stored_pair = vanish_then_fail
if failure == "install-fails-hash-vanishes-publish-fails":
    def refuse_publish(opened, name, data, identity):
        raise OSError("injected publish failure")
    module._force_replace_bytes = refuse_publish
raise SystemExit(module.main([action, "--config-dir", config_dir]))
`;

type GuardLine = {
  type: "issue" | "result";
  action?: string;
  status?: string;
  code?: string;
  path?: string;
  detail?: string;
  chattrApplied?: boolean;
  configSha256?: string;
  hashSynthesized?: boolean;
  recovery?: string;
  originalLocked?: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function trustedNodePath(configDir: string): string {
  return path.join(path.dirname(configDir), ".nemoclaw-test-node");
}

const CONFIG_BYTES = Buffer.from('{"gateway":{"port":18789}}\n');
const CONFIG_HASH_RECORD = `${createHash("sha256").update(CONFIG_BYTES).digest("hex")}  openclaw.json\n`;

function fixture() {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-guard-absent-hash-"));
  const root = fs.realpathSync(created);
  fixtures.push(root);
  const configDir = path.join(root, ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  const hashPath = path.join(configDir, ".config-hash");
  const nodePath = trustedNodePath(configDir);
  fs.mkdirSync(configDir);
  fs.writeFileSync(nodePath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, {
    mode: 0o500,
  });
  fs.writeFileSync(configPath, CONFIG_BYTES, { mode: 0o660 });
  fs.writeFileSync(hashPath, CONFIG_HASH_RECORD, { mode: 0o660 });
  fs.chmodSync(configPath, 0o660);
  fs.chmodSync(hashPath, 0o660);
  fs.chmodSync(configDir, 0o2770);
  fs.chmodSync(root, 0o755);
  return { root, configDir, configPath, hashPath };
}

function runGuard(action: "lock" | "unlock", configDir: string, failure = "none") {
  const result = spawnSync(
    "python3",
    ["-c", RUN_AS_CURRENT_USER, GUARD_PATH, action, configDir, failure],
    {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        NEMOCLAW_TEST_NODE_PATH: trustedNodePath(configDir),
        NEMOCLAW_TEST_JSON5_PATH: path.resolve("nemoclaw/node_modules/json5"),
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const lines = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GuardLine);
  return { ...result, lines };
}

function mode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o7777;
}

function rejectedNames(configDir: string): string[] {
  return fs.readdirSync(configDir).filter((name) => name.startsWith(".nemoclaw-rejected-"));
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    try {
      fs.chmodSync(root, 0o700);
      const configDir = path.join(root, ".openclaw");
      for (const existingConfigDir of fs.existsSync(configDir) &&
      !fs.lstatSync(configDir).isSymbolicLink()
        ? [configDir]
        : []) {
        fs.chmodSync(existingConfigDir, 0o700);
        for (const name of fs.readdirSync(existingConfigDir)) {
          const filePath = path.join(existingConfigDir, name);
          for (const existingFilePath of fs.lstatSync(filePath).isFile() ? [filePath] : []) {
            fs.chmodSync(existingFilePath, 0o600);
          }
        }
      }
    } catch {
      // Best effort before recursive fixture cleanup.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("openclaw-config-guard lock with an absent .config-hash", () => {
  it("locks from mutable by synthesizing the hash from openclaw.json", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    fs.rmSync(hashPath);

    const result = runGuard("lock", configDir);

    expect(result.status, JSON.stringify(result.lines)).toBe(0);
    expect(result.lines.at(-1)).toMatchObject({
      type: "result",
      action: "lock",
      status: "ok",
      hashSynthesized: true,
    });
    expect(mode(root)).toBe(0o1775);
    expect(mode(configDir)).toBe(0o755);
    expect(mode(configPath)).toBe(0o444);
    expect(mode(hashPath)).toBe(0o444);
    expect(fs.readFileSync(configPath)).toEqual(CONFIG_BYTES);
    expect(fs.readFileSync(hashPath, "utf-8")).toBe(CONFIG_HASH_RECORD);
    expect(rejectedNames(configDir)).toEqual([]);
  });

  it("relocks idempotently after a synthesized-hash lock without rewriting inodes", () => {
    const { configDir, configPath, hashPath } = fixture();
    fs.rmSync(hashPath);
    expect(runGuard("lock", configDir).status).toBe(0);
    const configInode = fs.lstatSync(configPath).ino;
    const hashInode = fs.lstatSync(hashPath).ino;

    const second = runGuard("lock", configDir);

    expect(second.status, JSON.stringify(second.lines)).toBe(0);
    expect(second.lines.at(-1)?.hashSynthesized).toBeUndefined();
    expect(fs.lstatSync(configPath).ino).toBe(configInode);
    expect(fs.lstatSync(hashPath).ino).toBe(hashInode);
    expect(mode(configPath)).toBe(0o444);
    expect(mode(hashPath)).toBe(0o444);
  });

  it("stays fail-closed when openclaw.json and the hash are both absent", () => {
    const { configDir, configPath, hashPath } = fixture();
    fs.rmSync(configPath);
    fs.rmSync(hashPath);

    const result = runGuard("lock", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "issue", code: "stat-failed" })]),
    );
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(hashPath)).toBe(false);
    expect(rejectedNames(configDir)).toEqual([]);
  });

  it("preserves openclaw.json through a fail-closed lock when the hash vanishes mid-transition", () => {
    const { configDir, configPath, hashPath } = fixture();

    const result = runGuard("lock", configDir, "install-fails-hash-vanishes");

    expect(result.status).toBe(1);
    expect(mode(configPath)).toBe(0o444);
    expect(fs.readFileSync(configPath)).toEqual(CONFIG_BYTES);
    expect(mode(hashPath)).toBe(0o444);
    expect(fs.readFileSync(hashPath, "utf-8")).toBe(CONFIG_HASH_RECORD);
    expect(rejectedNames(configDir)).toEqual([]);
  });

  it("locks a pristine pair without recording a synthesized hash", () => {
    const { configDir } = fixture();

    const result = runGuard("lock", configDir);

    expect(result.status, JSON.stringify(result.lines)).toBe(0);
    expect(result.lines.at(-1)).toMatchObject({ type: "result", action: "lock", status: "ok" });
    expect(result.lines.at(-1)?.hashSynthesized).toBeUndefined();
  });

  it("refuses to repair a planted symlink at .config-hash and fails closed", () => {
    const { configDir, configPath, hashPath } = fixture();
    fs.rmSync(hashPath);
    fs.symlinkSync("openclaw.json", hashPath);

    const result = runGuard("lock", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "unsafe-config-file" }),
      ]),
    );
    expect(fs.lstatSync(hashPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(hashPath).isFile()).toBe(true);
    expect(fs.readFileSync(configPath)).toEqual(CONFIG_BYTES);
    expect(rejectedNames(configDir).filter((name) => name.includes("openclaw"))).toEqual([]);
  });

  it("refuses to repair a dangling symlink at .config-hash and fails closed", () => {
    const { configDir, configPath, hashPath } = fixture();
    fs.rmSync(hashPath);
    fs.symlinkSync("does-not-exist", hashPath);

    const result = runGuard("lock", configDir);

    expect(result.status, JSON.stringify(result.lines)).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "unsafe-config-file" }),
      ]),
    );
    expect(fs.lstatSync(hashPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(configPath)).toEqual(CONFIG_BYTES);
    expect(rejectedNames(configDir).filter((name) => name.includes("openclaw"))).toEqual([]);
  });

  it("keeps unlock fail-closed when the hash is absent", () => {
    const { configDir, configPath, hashPath } = fixture();
    fs.rmSync(hashPath);

    const result = runGuard("unlock", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "issue", code: "stat-failed" })]),
    );
    expect(fs.readFileSync(configPath)).toEqual(CONFIG_BYTES);
    expect(fs.existsSync(hashPath)).toBe(false);
    expect(rejectedNames(configDir)).toEqual([]);
  });

  it("keeps a locked-posture relock fail-closed when the hash was removed", () => {
    const { configDir, configPath, hashPath } = fixture();
    expect(runGuard("lock", configDir).status).toBe(0);
    fs.rmSync(hashPath);

    const result = runGuard("lock", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "issue", code: "stat-failed" })]),
    );
    expect(mode(configPath)).toBe(0o444);
    expect(fs.readFileSync(configPath)).toEqual(CONFIG_BYTES);
    expect(fs.existsSync(hashPath)).toBe(false);
    expect(rejectedNames(configDir)).toEqual([]);
  });

  it("reports the quarantine name when the last-resort sever renames openclaw.json", () => {
    const { configDir, configPath } = fixture();

    const result = runGuard("lock", configDir, "install-fails-hash-vanishes-publish-fails");

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          detail: expect.stringContaining("openclaw.json: quarantined as .nemoclaw-rejected-"),
        }),
      ]),
    );
    expect(fs.existsSync(configPath)).toBe(false);
    const [rejected] = rejectedNames(configDir);
    expect(rejected).toMatch(/^\.nemoclaw-rejected-openclaw\.json-[0-9a-f]{32}$/);
    expect(fs.readFileSync(path.join(configDir, rejected))).toEqual(CONFIG_BYTES);
  });
});
