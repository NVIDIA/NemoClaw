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
import hashlib
import os
import sys
import time

guard_path, action, config_dir, failure, expected_sha256 = sys.argv[1:6]
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
if failure in {"installed-current", "installed-not-ready", "installed-nonroot-no-cap", "installed-nonroot-not-ready", "startup-owner", "old-image-no-cap"}:
    module._pid1_is_nemoclaw_start = lambda: True
    module._process_start_time = lambda pid: "424242" if pid == 1 else None
    module._process_namespace_inode = lambda pid: 424242 if pid == 1 else None
    module._startup_process_identity_is_live = lambda start_time, namespace_inode, effective_uid=0: (
        start_time == "424242" and namespace_inode == 424242
    )
if failure in {"installed-current", "installed-not-ready", "installed-nonroot-no-cap", "installed-nonroot-not-ready", "installed-foreign-pid1", "installed-remapped", "installed-remapped-any-live", "installed-openshell-supervised", "installed-openshell-stale-marker", "startup-owner"}:
    module.INSTALLED_HELPER_PATH = guard_path
if failure == "installed-foreign-pid1":
    module._pid1_is_nemoclaw_start = lambda: False
if failure in {"installed-openshell-supervised", "installed-openshell-stale-marker"}:
    module._pid1_is_nemoclaw_start = lambda: False
    module._openshell_supervised_nonroot_start_is_live = lambda root_uid, sandbox_uid, required_pid=None: True
    module._startup_markers_absent = lambda identity: failure == "installed-openshell-supervised"
if failure == "installed-remapped":
    module._pid1_is_nemoclaw_start = lambda: False
    module._startup_process_identity_is_live = lambda start_time, namespace_inode, effective_uid=0: (
        start_time == "424242" and namespace_inode == 424242
    )
if failure == "installed-remapped-any-live":
    module._pid1_is_nemoclaw_start = lambda: False
    module._startup_process_identity_is_live = lambda start_time, namespace_inode, effective_uid=0: (
        (start_time, namespace_inode) in {
            ("424242", 424242),
            ("525252", 525252),
        }
    )
if failure in {"installed-not-ready", "installed-current"}:
    module._pid1_effective_uid = lambda: identity.root_uid
if failure in {"installed-nonroot-no-cap", "installed-nonroot-not-ready"}:
    module._pid1_effective_uid = lambda: identity.root_uid + 1
if failure == "startup-owner":
    module.os.getppid = lambda: 1
if failure == "pair-race":
    original_snapshot = module._snapshot_file
    raced = False
    def race_pair(opened, name):
        global raced
        snapshot = original_snapshot(opened, name)
        if name == "openclaw.json" and not raced:
            raced = True
            updated = b'{"gateway":{"port":19001}}\n'
            with open(os.path.join(config_dir, "openclaw.json"), "wb") as stream:
                stream.write(updated)
            digest = hashlib.sha256(updated).hexdigest()
            with open(os.path.join(config_dir, ".config-hash"), "w", encoding="ascii") as stream:
                stream.write(digest + "  openclaw.json\n")
        return snapshot
    module._snapshot_file = race_pair
if failure.startswith("immutable"):
    inode_flags = {}
    flag_log = os.environ["NEMOCLAW_TEST_FLAG_LOG"]
    def fake_get_flags(fd):
        return inode_flags.get(os.fstat(fd).st_ino, module.FS_IMMUTABLE_FL)
    def fake_set_flags(fd, flags):
        inode_flags[os.fstat(fd).st_ino] = flags
        with open(flag_log, "a", encoding="utf-8") as stream:
            stream.write(str(flags) + "\n")
    module._get_inode_flags = fake_get_flags
    module._set_inode_flags = fake_set_flags
if "second-replace" in failure:
    original_replace = module._replace_from_snapshot
    calls = 0
    def fail_second(*args, **kwargs):
        global calls
        calls += 1
        if calls == 2:
            raise OSError("injected second replacement failure")
        return original_replace(*args, **kwargs)
    module._replace_from_snapshot = fail_second
if failure == "force-install-failure":
    def fail_install(*_args, **_kwargs):
        raise OSError("injected canonical install failure")
    module._install_stored_pair = fail_install
if failure == "kill-after-freeze":
    original_freeze = module._freeze
    def kill_after_freeze(*args, **kwargs):
        original_freeze(*args, **kwargs)
        os._exit(88)
    module._freeze = kill_after_freeze
if failure == "kill-after-prepared":
    def kill_before_freeze(*_args, **_kwargs):
        os._exit(87)
    module._freeze = kill_before_freeze
if failure == "kill-after-first-replace":
    original_replace_for_kill = module._replace_from_snapshot
    replace_calls = 0
    def kill_after_first_replace(*args, **kwargs):
        global replace_calls
        result = original_replace_for_kill(*args, **kwargs)
        replace_calls += 1
        if replace_calls == 1:
            os._exit(89)
        return result
    module._replace_from_snapshot = kill_after_first_replace
if failure == "kill-after-commit":
    original_write_journal = module._write_journal
    def kill_after_commit(record, identity, opened=None):
        original_write_journal(record, identity, opened)
        if record.get("phase") == "committed":
            os._exit(90)
    module._write_journal = kill_after_commit
if failure == "kill-after-visible":
    original_clear_secondary = module._clear_secondary_journal
    def kill_before_secondary_clear(*args, **kwargs):
        if os.stat(config_dir).st_mode & 0o7777 == 0o2770:
            os._exit(91)
        return original_clear_secondary(*args, **kwargs)
    module._clear_secondary_journal = kill_before_secondary_clear
if failure == "clear-after-visible-fails":
    original_clear_secondary_for_failure = module._clear_secondary_journal
    def fail_visible_secondary_clear(*args, **kwargs):
        if os.stat(config_dir).st_mode & 0o7777 == 0o2770:
            raise OSError("injected visible cleanup failure")
        return original_clear_secondary_for_failure(*args, **kwargs)
    module._clear_secondary_journal = fail_visible_secondary_clear
if failure == "second-replace-kill-rollback-visible":
    original_clear_secondary_after_rollback = module._clear_secondary_journal
    def kill_after_rollback_handoff(*args, **kwargs):
        if os.stat(config_dir).st_mode & 0o7777 == 0o2770:
            os._exit(112)
        return original_clear_secondary_after_rollback(*args, **kwargs)
    module._clear_secondary_journal = kill_after_rollback_handoff
if failure == "plant-journal-before-freeze":
    original_freeze_for_plant = module._freeze
    def plant_before_freeze(*args, **kwargs):
        planted = os.path.join(config_dir, module.PERSISTENT_JOURNAL_NAME)
        try:
            os.symlink(os.path.join(os.path.dirname(config_dir), "outside"), planted)
        except FileExistsError:
            pass
        return original_freeze_for_plant(*args, **kwargs)
    module._freeze = plant_before_freeze
if failure == "hold-mutex":
    original_open_config = module._open_config
    def hold_after_mutex(path):
        with open(os.environ["NEMOCLAW_TEST_READY_FILE"], "w", encoding="utf-8") as stream:
            stream.write("ready\n")
        time.sleep(4)
        return original_open_config(path)
    module._open_config = hold_after_mutex
if failure in {"kill-seal-after-freeze-parent", "kill-seal-after-freeze-config"}:
    target_name = "_freeze_parent" if failure.endswith("parent") else "_freeze_config"
    original_freeze_step = getattr(module, target_name)
    exit_code = 102 if failure.endswith("parent") else 103
    def kill_after_freeze_step(*args, **kwargs):
        original_freeze_step(*args, **kwargs)
        os._exit(exit_code)
    setattr(module, target_name, kill_after_freeze_step)
if failure in {
    "kill-seal-after-prepared",
    "kill-seal-after-applying",
    "kill-seal-after-sealed-journal",
    "kill-unseal-after-journal",
    "kill-unseal-after-committed",
}:
    original_restart_write_journal = module._write_journal
    phase_exit = {
        "kill-seal-after-prepared": ("prepared", 101),
        "kill-seal-after-applying": ("applying", 104),
        "kill-seal-after-sealed-journal": ("sealed", 106),
        "kill-unseal-after-journal": ("unsealing", 108),
        "kill-unseal-after-committed": ("unseal-committed", 110),
    }
    wanted_phase, restart_exit = phase_exit[failure]
    def kill_after_restart_journal(record, identity, opened=None):
        original_restart_write_journal(record, identity, opened)
        if record.get("action") == "restart-seal" and record.get("phase") == wanted_phase:
            os._exit(restart_exit)
    module._write_journal = kill_after_restart_journal
if failure in {"kill-seal-after-first-replace", "kill-unseal-after-first-replace"}:
    original_restart_replace = module._replace_from_snapshot
    restart_replace_calls = 0
    restart_replace_exit = 105 if failure.startswith("kill-seal") else 109
    def kill_after_restart_replace(*args, **kwargs):
        global restart_replace_calls
        result = original_restart_replace(*args, **kwargs)
        restart_replace_calls += 1
        if restart_replace_calls == 1:
            os._exit(restart_replace_exit)
        return result
    module._replace_from_snapshot = kill_after_restart_replace
if failure == "kill-seal-after-visible":
    original_commit_locked = module._commit_locked_dirs
    def kill_after_sealed_visible(*args, **kwargs):
        original_commit_locked(*args, **kwargs)
        os._exit(107)
    module._commit_locked_dirs = kill_after_sealed_visible
if failure == "kill-unseal-after-visible":
    original_commit_mutable = module._commit_mutable_dirs
    def kill_after_unseal_visible(*args, **kwargs):
        original_commit_mutable(*args, **kwargs)
        os._exit(111)
    module._commit_mutable_dirs = kill_after_unseal_visible
arguments = [action, "--config-dir", config_dir]
if expected_sha256:
    arguments.extend(["--expected-config-sha256", expected_sha256])
if failure == "startup-owner":
    arguments.append("--startup-owner")
raise SystemExit(module.main(arguments))
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
  recovery?: string;
  originalLocked?: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function trustedNodePath(configDir: string): string {
  return path.join(path.dirname(configDir), ".nemoclaw-test-node");
}

function fixture() {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-config-guard-"));
  const root = fs.realpathSync(created);
  fixtures.push(root);
  const configDir = path.join(root, ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  const hashPath = path.join(configDir, ".config-hash");
  const nodePath = trustedNodePath(configDir);
  const configBytes = Buffer.from('{"gateway":{"port":18789}}\n');
  fs.mkdirSync(configDir);
  fs.writeFileSync(nodePath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, {
    mode: 0o500,
  });
  fs.writeFileSync(configPath, configBytes, { mode: 0o660 });
  fs.writeFileSync(
    hashPath,
    `${createHash("sha256").update(configBytes).digest("hex")}  openclaw.json\n`,
    { mode: 0o660 },
  );
  fs.chmodSync(configPath, 0o660);
  fs.chmodSync(hashPath, 0o660);
  fs.chmodSync(configDir, 0o2770);
  fs.chmodSync(root, 0o755);
  return { root, configDir, configPath, hashPath };
}

type GuardAction =
  | "preflight"
  | "preflight-restart"
  | "lock"
  | "unlock"
  | "seal-restart"
  | "unseal-restart"
  | "revoke-startup-ready"
  | "publish-startup-ready"
  | "write-config"
  | "recover";

function runGuard(
  action: GuardAction,
  configDir: string,
  failure = "none",
  env: NodeJS.ProcessEnv = {},
  expectedSha256 = "",
  input?: string | Buffer,
) {
  const result = spawnSync(
    "python3",
    ["-c", RUN_AS_CURRENT_USER, GUARD_PATH, action, configDir, failure, expectedSha256],
    {
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        NEMOCLAW_TEST_NODE_PATH: trustedNodePath(configDir),
        NEMOCLAW_TEST_JSON5_PATH: path.resolve("nemoclaw/node_modules/json5"),
        ...env,
      },
      input,
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
        for (const name of ["openclaw.json", ".config-hash"]) {
          const filePath = path.join(existingConfigDir, name);
          for (const existingFilePath of fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()
            ? [filePath]
            : []) {
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

describe("openclaw-config-guard fail-closed lock", () => {
  it("preserves openclaw.json and rebuilds the sealed pair when only .config-hash is missing on lock (#7382)", () => {
    const { configDir, configPath, hashPath } = fixture();
    const originalBytes = fs.readFileSync(configPath);
    fs.rmSync(hashPath);

    const drifted = runGuard("lock", configDir);
    expect(drifted.status, JSON.stringify(drifted.lines)).not.toBe(0);
    expect(drifted.lines).toContainEqual(
      expect.objectContaining({ type: "issue", code: "stat-failed" }),
    );
    expect(fs.readFileSync(configPath)).toEqual(originalBytes);
    const digest = createHash("sha256").update(originalBytes).digest("hex");
    expect(fs.readFileSync(hashPath, "ascii")).toBe(`${digest}  openclaw.json\n`);
    expect(
      fs.readdirSync(configDir).filter((name) => name.startsWith(".nemoclaw-rejected-")),
    ).toEqual([]);
    expect(mode(configPath)).toBe(0o444);
    expect(mode(hashPath)).toBe(0o444);

    const retry = runGuard("lock", configDir);
    expect(retry.status, JSON.stringify(retry.lines)).toBe(0);
    expect(fs.readFileSync(configPath)).toEqual(originalBytes);
  });

  it("still severs both canonical paths on lock when openclaw.json itself is untrustworthy (#7382)", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    fs.rmSync(configPath);
    fs.symlinkSync(path.join(root, "outside-target"), configPath);

    const severed = runGuard("lock", configDir);
    expect(severed.status, JSON.stringify(severed.lines)).not.toBe(0);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(hashPath)).toBe(false);
    expect(
      fs.readdirSync(configDir).filter((name) => name.startsWith(".nemoclaw-rejected-")).length,
    ).toBeGreaterThan(0);
  });
});
