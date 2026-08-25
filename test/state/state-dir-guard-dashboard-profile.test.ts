// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgent } from "../../src/lib/agent/defs";

const GUARD_PATH = path.resolve("scripts/state-dir-guard.py");
const OPENCLAW_STATE_LOCK_PLAN = loadAgent("openclaw").stateLockPlan;
const HERMES_STATE_LOCK_PLAN = loadAgent("hermes").stateLockPlan;
const fixtures: string[] = [];

const RUN_GUARD_AS_CURRENT_USER = String.raw`
import importlib.util
import os
import sys

guard_path, action, config_dir, plan_json = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard_dashboard", guard_path)
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
raise SystemExit(module.main([
    action,
    "--config-dir",
    config_dir,
    "--plan-json",
    plan_json,
]))
`;

function fixture(configDirName: ".hermes" | ".openclaw"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dashboard-guard-"));
  fixtures.push(root);
  const configDir = path.join(root, configDirName);
  fs.mkdirSync(configDir, { recursive: true });
  return fs.realpathSync(configDir);
}

function runGuard(action: "lock" | "unlock", configDir: string, plan: unknown) {
  return spawnSync(
    "python3",
    ["-c", RUN_GUARD_AS_CURRENT_USER, GUARD_PATH, action, configDir, JSON.stringify(plan)],
    { encoding: "utf-8", timeout: 15_000 },
  );
}

function mode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o7777;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("state-dir guard dashboard profiles", () => {
  it("keeps the Hermes dashboard profile writable and private while Shields are up (#7200)", () => {
    const configDir = fixture(".hermes");
    const dashboardHome = path.join(configDir, "profiles", "dashboard-home");
    const dashboardMemory = path.join(dashboardHome, "MEMORY.md");
    fs.mkdirSync(dashboardHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(dashboardHome, 0o700);
    fs.writeFileSync(dashboardMemory, "dashboard runtime\n", { mode: 0o600 });
    const dashboardFd = fs.openSync(dashboardMemory, "a+");
    const oldMemoryInode = fs.fstatSync(dashboardFd).ino;

    try {
      const locked = runGuard("lock", configDir, HERMES_STATE_LOCK_PLAN);

      expect(locked.status, locked.stderr).toBe(0);
      expect(mode(path.join(configDir, "profiles"))).toBe(0o755);
      expect(mode(dashboardHome)).toBe(0o700);
      expect(mode(dashboardMemory)).toBe(0o600);
      expect(fs.fstatSync(dashboardFd).ino).toBe(oldMemoryInode);
      fs.writeSync(dashboardFd, "updated\n");

      const relocked = runGuard("lock", configDir, HERMES_STATE_LOCK_PLAN);
      expect(relocked.status, relocked.stderr).toBe(0);
      expect(mode(dashboardHome)).toBe(0o700);
      expect(fs.fstatSync(dashboardFd).ino).toBe(oldMemoryInode);

      const unlocked = runGuard("unlock", configDir, HERMES_STATE_LOCK_PLAN);
      expect(unlocked.status, unlocked.stderr).toBe(0);
      expect(mode(dashboardHome)).toBe(0o700);
      const contents = Buffer.alloc(fs.fstatSync(dashboardFd).size);
      fs.readSync(dashboardFd, contents, 0, contents.length, 0);
      expect(contents.toString("utf-8")).toBe("dashboard runtime\nupdated\n");
    } finally {
      fs.closeSync(dashboardFd);
    }
  });

  it("keeps a dashboard-named OpenClaw profile inside the Shields boundary", () => {
    const configDir = fixture(".openclaw");
    const dashboardHome = path.join(configDir, "profiles", "dashboard-home");
    const dashboardMemory = path.join(dashboardHome, "MEMORY.md");
    fs.mkdirSync(dashboardHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(dashboardMemory, "protected\n", { mode: 0o600 });
    const oldMemoryInode = fs.statSync(dashboardMemory).ino;

    const locked = runGuard("lock", configDir, OPENCLAW_STATE_LOCK_PLAN);

    expect(locked.status, locked.stderr).toBe(0);
    expect(mode(dashboardHome)).toBe(0o755);
    expect(fs.statSync(dashboardMemory).ino).not.toBe(oldMemoryInode);
  });
});
