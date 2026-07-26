// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
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

function setUserXattr(filePath: string, value: string): boolean {
  return (
    spawnSync(
      "python3",
      [
        "-c",
        "import os,sys; os.setxattr(sys.argv[1], 'user.nemoclaw-test', sys.argv[2].encode())",
        filePath,
        value,
      ],
      { encoding: "utf-8" },
    ).status === 0
  );
}

function getUserXattr(filePath: string): string {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import os,sys; print(os.getxattr(sys.argv[1], 'user.nemoclaw-test').decode())",
      filePath,
    ],
    { encoding: "utf-8" },
  );
  expect(result.status).toBe(0);
  return result.stdout.trim();
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

describe("openclaw-config-guard", () => {
  it("keeps an exact locked parent and pair unchanged across idempotent relock", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const first = runGuard("lock", configDir);
    expect(first.status, JSON.stringify(first.lines)).toBe(0);
    const configInode = fs.statSync(configPath).ino;
    const hashInode = fs.statSync(hashPath).ino;
    const configBytes = fs.readFileSync(configPath);
    const hashBytes = fs.readFileSync(hashPath);
    expect(mode(root)).toBe(0o1775);

    const second = runGuard("lock", configDir);
    expect(second.status, JSON.stringify(second.lines)).toBe(0);
    expect(mode(root)).toBe(0o1775);
    expect(mode(configDir)).toBe(0o755);
    expect(mode(configPath)).toBe(0o444);
    expect(mode(hashPath)).toBe(0o444);
    expect(fs.statSync(configPath).ino).toBe(configInode);
    expect(fs.statSync(hashPath).ino).toBe(hashInode);
    expect(fs.readFileSync(configPath)).toEqual(configBytes);
    expect(fs.readFileSync(hashPath)).toEqual(hashBytes);
  });

  it("fresh-replaces both files on lock and unlock while preserving bytes, times, and xattrs", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const preservedTime = new Date("2025-01-02T03:04:05.000Z");
    fs.utimesSync(configPath, preservedTime, preservedTime);
    fs.utimesSync(hashPath, preservedTime, preservedTime);
    const hasXattrs = setUserXattr(configPath, "trusted-metadata");
    const initialConfig = fs.readFileSync(configPath);
    const initialHash = fs.readFileSync(hashPath);
    const initialConfigStat = fs.statSync(configPath);
    const initialHashStat = fs.statSync(hashPath);
    const staleConfigFd = fs.openSync(configPath, "r+");
    const staleHashFd = fs.openSync(hashPath, "r+");

    try {
      const locked = runGuard("lock", configDir);
      expect(locked.status).toBe(0);
      expect(locked.lines.at(-1)).toMatchObject({
        type: "result",
        action: "lock",
        status: "ok",
        chattrApplied: false,
      });
      expect(mode(root)).toBe(0o1775);
      expect(mode(configDir)).toBe(0o755);
      expect(mode(configPath)).toBe(0o444);
      expect(mode(hashPath)).toBe(0o444);
      expect(fs.statSync(configPath).ino).not.toBe(initialConfigStat.ino);
      expect(fs.statSync(hashPath).ino).not.toBe(initialHashStat.ino);
      expect(fs.statSync(configPath).mtimeMs).toBe(initialConfigStat.mtimeMs);
      expect(fs.statSync(hashPath).mtimeMs).toBe(initialHashStat.mtimeMs);
      for (const expectedXattr of hasXattrs ? ["trusted-metadata"] : []) {
        expect(getUserXattr(configPath)).toBe(expectedXattr);
      }

      fs.writeSync(staleConfigFd, Buffer.from("MUTATED"), 0, 7, 0);
      fs.writeSync(staleHashFd, Buffer.from("MUTATED"), 0, 7, 0);
      fs.fsyncSync(staleConfigFd);
      fs.fsyncSync(staleHashFd);
      expect(fs.readFileSync(configPath)).toEqual(initialConfig);
      expect(fs.readFileSync(hashPath)).toEqual(initialHash);

      const lockedConfigInode = fs.statSync(configPath).ino;
      const lockedHashInode = fs.statSync(hashPath).ino;
      const unlocked = runGuard("unlock", configDir);
      expect(unlocked.status).toBe(0);
      expect(mode(root)).toBe(0o755);
      expect(mode(configDir)).toBe(0o2770);
      expect(mode(configPath)).toBe(0o660);
      expect(mode(hashPath)).toBe(0o660);
      expect(fs.statSync(configPath).ino).not.toBe(lockedConfigInode);
      expect(fs.statSync(hashPath).ino).not.toBe(lockedHashInode);
      expect(fs.readFileSync(configPath)).toEqual(initialConfig);
      expect(fs.readFileSync(hashPath)).toEqual(initialHash);
      for (const expectedXattr of hasXattrs ? ["trusted-metadata"] : []) {
        expect(getUserXattr(configPath)).toBe(expectedXattr);
      }
    } finally {
      fs.closeSync(staleConfigFd);
      fs.closeSync(staleHashFd);
    }
  });

  it("rejects external symlink, hardlink, and special-file substitutions", () => {
    for (const attack of ["symlink", "hardlink", "fifo"] as const) {
      const { root, configDir, configPath, hashPath } = fixture();
      const external = path.join(root, "external.json");
      fs.writeFileSync(external, "outside\n");
      fs.rmSync(configPath);
      const arrangeAttack = {
        symlink: () => fs.symlinkSync(external, configPath),
        hardlink: () => fs.linkSync(external, configPath),
        fifo: () => expect(spawnSync("mkfifo", [configPath]).status).toBe(0),
      } satisfies Record<typeof attack, () => void>;
      arrangeAttack[attack]();

      const beforeHash = fs.readFileSync(hashPath);
      const result = runGuard("preflight", configDir);

      expect(result.status).toBe(1);
      expect(result.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "issue",
            code: attack === "hardlink" ? "hardlinked-config-file" : "unsafe-config-file",
            path: configPath,
          }),
        ]),
      );
      expect(fs.readFileSync(external, "utf-8")).toBe("outside\n");
      expect(fs.readFileSync(hashPath)).toEqual(beforeHash);
    }
  });

  it("fail-closes a rename-swapped config namespace and leaves the external tree untouched", () => {
    const { root, configDir } = fixture();
    const realConfig = path.join(root, "real-openclaw");
    fs.renameSync(configDir, realConfig);
    fs.symlinkSync(realConfig, configDir);
    const externalConfig = path.join(realConfig, "openclaw.json");
    const before = fs.readFileSync(externalConfig);

    const result = runGuard("lock", configDir);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(externalConfig)).toEqual(before);
    expect(fs.lstatSync(configDir).isDirectory()).toBe(true);
    expect(mode(configDir)).toBe(0o755);
    expect(mode(path.join(configDir, "openclaw.json"))).toBe(0o444);
  });

  it("canonicalizes a stale mutable hash while strict preflight rejects a bad record path", () => {
    const mismatch = fixture();
    const mismatchBytes = fs.readFileSync(mismatch.configPath);
    fs.writeFileSync(mismatch.hashPath, `${"0".repeat(64)}  openclaw.json\n`, { mode: 0o660 });

    const mismatched = runGuard("lock", mismatch.configDir);

    expect(mismatched.status).toBe(0);
    expect(fs.readFileSync(mismatch.hashPath, "utf-8")).toBe(
      `${createHash("sha256").update(mismatchBytes).digest("hex")}  openclaw.json\n`,
    );
    expect(fs.readFileSync(mismatch.configPath)).toEqual(mismatchBytes);
    expect(mode(mismatch.configDir)).toBe(0o755);

    const wrongPath = fixture();
    const digest = createHash("sha256").update(fs.readFileSync(wrongPath.configPath)).digest("hex");
    fs.writeFileSync(wrongPath.hashPath, `${digest}  ../openclaw.json\n`);
    const nonCanonical = runGuard("preflight", wrongPath.configDir);
    expect(nonCanonical.status).toBe(1);
    expect(nonCanonical.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "invalid-config-hash-path" }),
      ]),
    );

    const absolute = fixture();
    const absoluteDigest = createHash("sha256")
      .update(fs.readFileSync(absolute.configPath))
      .digest("hex");
    fs.writeFileSync(absolute.hashPath, `${absoluteDigest}  ${absolute.configPath}\n`, {
      mode: 0o660,
    });
    expect(runGuard("preflight", absolute.configDir).status).toBe(0);
  });

  it("retries config and hash as one pair when a writer interleaves their capture", () => {
    const { configDir, configPath, hashPath } = fixture();

    const result = runGuard("lock", configDir, "pair-race");

    expect(result.status).toBe(0);
    const updated = Buffer.from('{"gateway":{"port":19001}}\n');
    expect(fs.readFileSync(configPath)).toEqual(updated);
    expect(fs.readFileSync(hashPath, "utf-8")).toBe(
      `${createHash("sha256").update(updated).digest("hex")}  openclaw.json\n`,
    );
    expect(mode(configPath)).toBe(0o444);
    expect(mode(hashPath)).toBe(0o444);
  });

  it("restart preflight accepts a stable parseable config with a stale mutable hash", () => {
    const { configDir, hashPath } = fixture();
    fs.writeFileSync(hashPath, `${"0".repeat(64)}  openclaw.json\n`);
    fs.chmodSync(hashPath, 0o660);

    expect(runGuard("preflight-restart", configDir).status).toBe(0);
    const strict = runGuard("preflight", configDir);
    expect(strict.status).toBe(1);
    expect(strict.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "config-hash-mismatch" }),
      ]),
    );
  });

  it("rolls a failed unlock back to the complete locked parent, config, and file posture", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const configBytes = fs.readFileSync(configPath);
    const hashBytes = fs.readFileSync(hashPath);
    expect(runGuard("lock", configDir).status).toBe(0);

    const result = runGuard("unlock", configDir, "second-replace");

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "transition-failed" }),
      ]),
    );
    expect(mode(root)).toBe(0o1775);
    expect(mode(configDir)).toBe(0o755);
    expect(mode(configPath)).toBe(0o444);
    expect(mode(hashPath)).toBe(0o444);
    expect(fs.readFileSync(configPath)).toEqual(configBytes);
    expect(fs.readFileSync(hashPath)).toEqual(hashBytes);
  });

  it("clears descriptor-bound immutable flags for replacement and restores them on rollback", () => {
    const { root, configDir } = fixture();
    const flagLog = path.join(root, "inode-flags.log");
    fs.writeFileSync(flagLog, "");

    const locked = runGuard("lock", configDir, "immutable", {
      NEMOCLAW_TEST_FLAG_LOG: flagLog,
    });
    expect(locked.status).toBe(0);
    expect(fs.readFileSync(flagLog, "utf-8").trim().split("\n")).toContain("0");

    fs.writeFileSync(flagLog, "");
    const failedUnlock = runGuard("unlock", configDir, "immutable-second-replace", {
      NEMOCLAW_TEST_FLAG_LOG: flagLog,
    });
    expect(failedUnlock.status).toBe(1);
    const appliedFlags = fs.readFileSync(flagLog, "utf-8").trim().split("\n").map(Number);
    expect(appliedFlags).toContain(0);
    expect(appliedFlags).toContain(0x10);
    expect(mode(configDir)).toBe(0o755);
  });

  it("enforces the exact production path and bounded config artifact sizes", () => {
    const { configDir, hashPath } = fixture();
    const noPathOverride = RUN_AS_CURRENT_USER.replace(
      "module.PRODUCTION_CONFIG_DIR = config_dir\n",
      "",
    );
    const wrongPath = spawnSync(
      "python3",
      ["-c", noPathOverride, GUARD_PATH, "preflight", configDir, "none", ""],
      { encoding: "utf-8", timeout: 15_000 },
    );
    expect(wrongPath.status).toBe(1);
    expect(wrongPath.stdout).toContain('"code": "invalid-config-path"');

    fs.writeFileSync(hashPath, Buffer.alloc(64 * 1024 + 1, 0x61));
    const oversized = runGuard("preflight", configDir);
    expect(oversized.status).toBe(1);
    expect(oversized.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "config-file-too-large",
          path: hashPath,
        }),
      ]),
    );
  });

  it("CAS-writes a fresh mutable config/hash pair and revokes stale descriptors", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const oldConfig = fs.readFileSync(configPath);
    const expected = createHash("sha256").update(oldConfig).digest("hex");
    const replacement = Buffer.from(
      `${JSON.stringify({ gateway: { port: 19001 }, agents: { defaults: { model: "nvidia/test" } } }, null, 2)}\n`,
    );
    const replacementDigest = createHash("sha256").update(replacement).digest("hex");
    const oldConfigInode = fs.statSync(configPath).ino;
    const oldHashInode = fs.statSync(hashPath).ino;
    const staleConfigFd = fs.openSync(configPath, "r+");
    const staleHashFd = fs.openSync(hashPath, "r+");

    try {
      const result = runGuard("write-config", configDir, "none", {}, expected, replacement);

      expect(result.status, JSON.stringify(result.lines)).toBe(0);
      expect(result.lines.at(-1)).toMatchObject({
        type: "result",
        action: "write-config",
        status: "ok",
        chattrApplied: false,
        configSha256: replacementDigest,
      });
      expect(mode(root)).toBe(0o755);
      expect(mode(configDir)).toBe(0o2770);
      expect(mode(configPath)).toBe(0o660);
      expect(mode(hashPath)).toBe(0o660);
      expect(fs.statSync(configPath).ino).not.toBe(oldConfigInode);
      expect(fs.statSync(hashPath).ino).not.toBe(oldHashInode);
      expect(fs.readFileSync(configPath)).toEqual(replacement);
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(`${replacementDigest}  openclaw.json\n`);

      fs.writeSync(staleConfigFd, Buffer.from("STALE!!"), 0, 7, 0);
      fs.writeSync(staleHashFd, Buffer.from("STALE!!"), 0, 7, 0);
      fs.fsyncSync(staleConfigFd);
      fs.fsyncSync(staleHashFd);
      expect(fs.readFileSync(configPath)).toEqual(replacement);
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(`${replacementDigest}  openclaw.json\n`);
    } finally {
      fs.closeSync(staleConfigFd);
      fs.closeSync(staleHashFd);
    }
  });

  it("safely replaces a sandbox-precreated persistent journal symlink", () => {
    const { root, configDir, configPath } = fixture();
    const original = fs.readFileSync(configPath);
    const expected = createHash("sha256").update(original).digest("hex");
    const outside = path.join(root, "outside-journal-target");
    const persistentJournal = path.join(configDir, ".nemoclaw-config-transaction.json");
    fs.writeFileSync(outside, "do-not-touch\n");
    fs.symlinkSync(outside, persistentJournal);

    const result = runGuard(
      "write-config",
      configDir,
      "none",
      {},
      expected,
      Buffer.from('{"gateway":{"port":19001}}\n'),
    );

    expect(result.status).toBe(0);
    expect(fs.readFileSync(outside, "utf-8")).toBe("do-not-touch\n");
    expect(fs.existsSync(persistentJournal)).toBe(false);
  });

  it("refuses stale CAS and locked posture without changing either file", () => {
    const staleCas = fixture();
    const beforeConfig = fs.readFileSync(staleCas.configPath);
    const beforeHash = fs.readFileSync(staleCas.hashPath);
    const replacement = Buffer.from('{"gateway":{"port":19001}}\n');

    const stale = runGuard(
      "write-config",
      staleCas.configDir,
      "none",
      {},
      "0".repeat(64),
      replacement,
    );

    expect(stale.status).toBe(1);
    expect(stale.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "config-cas-mismatch" }),
      ]),
    );
    expect(fs.readFileSync(staleCas.configPath)).toEqual(beforeConfig);
    expect(fs.readFileSync(staleCas.hashPath)).toEqual(beforeHash);

    const locked = fixture();
    expect(runGuard("lock", locked.configDir).status).toBe(0);
    const lockedConfig = fs.readFileSync(locked.configPath);
    const lockedHash = fs.readFileSync(locked.hashPath);
    const lockedDigest = createHash("sha256").update(lockedConfig).digest("hex");
    const refused = runGuard(
      "write-config",
      locked.configDir,
      "none",
      {},
      lockedDigest,
      replacement,
    );
    expect(refused.status).toBe(1);
    expect(refused.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "config-not-mutable" }),
      ]),
    );
    expect(fs.readFileSync(locked.configPath)).toEqual(lockedConfig);
    expect(fs.readFileSync(locked.hashPath)).toEqual(lockedHash);
    expect(mode(locked.configPath)).toBe(0o444);
  });

  it("rolls back both mutable files when the second write-config replacement fails", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const beforeConfig = fs.readFileSync(configPath);
    const beforeHash = fs.readFileSync(hashPath);
    const expected = createHash("sha256").update(beforeConfig).digest("hex");
    const replacement = Buffer.from('{"gateway":{"port":19001}}\n');

    const result = runGuard("write-config", configDir, "second-replace", {}, expected, replacement);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "write-config-failed" }),
      ]),
    );
    expect(fs.readFileSync(configPath)).toEqual(beforeConfig);
    expect(fs.readFileSync(hashPath)).toEqual(beforeHash);
    expect(mode(root)).toBe(0o755);
    expect(mode(configDir)).toBe(0o2770);
    expect(mode(configPath)).toBe(0o660);
    expect(mode(hashPath)).toBe(0o660);
  });

  it.each([
    ["kill-after-freeze", 88, "orphan-freeze-restored", false],
    ["kill-after-first-replace", 89, "ambiguous-replay-locked", true],
  ] as const)("recovers or fail-closes after %s", (failure, exitCode, recovery, locked) => {
    const { root, configDir, configPath, hashPath } = fixture();
    const originalConfig = fs.readFileSync(configPath);
    const originalHash = fs.readFileSync(hashPath);
    const expected = createHash("sha256").update(originalConfig).digest("hex");
    const replacement = Buffer.from('{"gateway":{"port":19001}}\n');
    const journalPath = path.join(root, ".nemoclaw-test", "transaction.json");

    const interrupted = runGuard("write-config", configDir, failure, {}, expected, replacement);

    expect(interrupted.status).toBe(exitCode);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(mode(configDir)).toBe(0o700);
    // Simulate container recreation: /etc-style secondary state is gone while
    // the persistent /sandbox tree and its root-frozen discriminator survive.
    fs.rmSync(journalPath, { force: true });
    for (const _ambiguousReplacement of failure === "kill-after-first-replace" ? [true] : []) {
      const refused = runGuard("preflight", configDir);
      expect(refused.status).toBe(1);
      expect(refused.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "issue", code: "recovery-required" }),
        ]),
      );
    }

    const recovered = runGuard("recover", configDir);
    expect(recovered.status).toBe(0);
    expect(recovered.lines.at(-1)).toMatchObject({
      type: "result",
      action: "recover",
      status: "ok",
      recovery,
    });
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.readFileSync(configPath)).toEqual(locked ? replacement : originalConfig);
    const replacementDigest = createHash("sha256").update(replacement).digest("hex");
    const expectedHash = locked
      ? Buffer.from(`${replacementDigest}  openclaw.json\n`)
      : originalHash;
    expect(fs.readFileSync(hashPath)).toEqual(expectedHash);
    expect(mode(root)).toBe(locked ? 0o1775 : 0o755);
    expect(mode(configDir)).toBe(locked ? 0o755 : 0o2770);
    expect(mode(configPath)).toBe(locked ? 0o444 : 0o660);
    expect(mode(hashPath)).toBe(locked ? 0o444 : 0o660);
  });

  it("preserves later gateway bytes and a stale hash from the prepared phase", () => {
    const { configDir, configPath, hashPath } = fixture();
    const original = fs.readFileSync(configPath);
    const originalHash = fs.readFileSync(hashPath);
    const expected = createHash("sha256").update(original).digest("hex");
    const intended = Buffer.from('{"gateway":{"port":19001}}\n');

    const interrupted = runGuard(
      "write-config",
      configDir,
      "kill-after-prepared",
      {},
      expected,
      intended,
    );
    expect(interrupted.status).toBe(87);
    expect(mode(configDir)).toBe(0o2770);

    const gatewayBytes = Buffer.from('{"gateway":{"port":19002},"runtime":true}\n');
    fs.writeFileSync(configPath, gatewayBytes);
    fs.chmodSync(configPath, 0o660);
    // Deliberately leave .config-hash stale; mutable gateway writes are allowed
    // to refresh that non-anchor later in startup.
    const recovered = runGuard("recover", configDir);
    expect(recovered.status).toBe(0);
    expect(recovered.lines.at(-1)).toMatchObject({
      recovery: "prepared-preserved",
      configSha256: createHash("sha256").update(gatewayBytes).digest("hex"),
    });
    expect(fs.readFileSync(configPath)).toEqual(gatewayBytes);
    expect(fs.readFileSync(hashPath)).toEqual(originalHash);
  });

  it("uses the frozen posture discriminator when both journals are lost and hash is stale", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const original = fs.readFileSync(configPath);
    const expected = createHash("sha256").update(original).digest("hex");
    const staleHash = Buffer.from(`${"0".repeat(64)}  openclaw.json\n`);
    fs.writeFileSync(hashPath, staleHash);
    fs.chmodSync(hashPath, 0o660);

    const interrupted = runGuard(
      "write-config",
      configDir,
      "kill-after-freeze",
      {},
      expected,
      Buffer.from('{"gateway":{"port":19001}}\n'),
    );
    expect(interrupted.status).toBe(88);
    fs.rmSync(path.join(root, ".nemoclaw-test", "transaction.json"), { force: true });
    fs.rmSync(path.join(configDir, ".nemoclaw-config-transaction.json"), { force: true });

    const recovered = runGuard("recover", configDir);
    expect(recovered.status).toBe(0);
    expect(recovered.lines.at(-1)).toMatchObject({ recovery: "orphan-freeze-restored" });
    expect(fs.readFileSync(configPath)).toEqual(original);
    expect(fs.readFileSync(hashPath)).toEqual(staleHash);
    expect(mode(configDir)).toBe(0o2770);
  });

  it("finishes the committed replacement after interruption before mutable-directory commit", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const originalConfig = fs.readFileSync(configPath);
    const expected = createHash("sha256").update(originalConfig).digest("hex");
    const replacement = Buffer.from('{"gateway":{"port":19001}}\n');
    const replacementDigest = createHash("sha256").update(replacement).digest("hex");
    const journalPath = path.join(root, ".nemoclaw-test", "transaction.json");

    const interrupted = runGuard(
      "write-config",
      configDir,
      "kill-after-commit",
      {},
      expected,
      replacement,
    );
    expect(interrupted.status, JSON.stringify(interrupted.lines)).toBe(90);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(mode(configDir)).toBe(0o700);
    fs.rmSync(journalPath, { force: true });

    const recovered = runGuard("recover", configDir);
    expect(recovered.status).toBe(0);
    expect(recovered.lines.at(-1)).toMatchObject({
      type: "result",
      action: "recover",
      status: "ok",
      recovery: "ambiguous-replay-locked",
      configSha256: replacementDigest,
    });
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.readFileSync(configPath)).toEqual(replacement);
    expect(fs.readFileSync(hashPath, "utf-8")).toBe(`${replacementDigest}  openclaw.json\n`);
    expect(mode(root)).toBe(0o1775);
    expect(mode(configDir)).toBe(0o755);
  });

  it("preserves a later gateway write with stale hash when committed cleanup was interrupted", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const original = fs.readFileSync(configPath);
    const expected = createHash("sha256").update(original).digest("hex");
    const replacement = Buffer.from('{"gateway":{"port":19001}}\n');
    const secondaryJournal = path.join(root, ".nemoclaw-test", "transaction.json");

    const interrupted = runGuard(
      "write-config",
      configDir,
      "kill-after-visible",
      {},
      expected,
      replacement,
    );
    expect(interrupted.status).toBe(91);
    expect(mode(configDir)).toBe(0o2770);

    const gatewayBytes = Buffer.from('{"gateway":{"port":19002},"runtime":true}\n');
    const gatewayDigest = createHash("sha256").update(gatewayBytes).digest("hex");
    const staleHash = fs.readFileSync(hashPath);
    fs.writeFileSync(configPath, gatewayBytes, { mode: 0o660 });
    fs.chmodSync(configPath, 0o660);
    fs.rmSync(secondaryJournal, { force: true });

    const recovered = runGuard("recover", configDir);
    expect(recovered.status).toBe(0);
    expect(recovered.lines.at(-1)).toMatchObject({
      type: "result",
      action: "recover",
      status: "ok",
      recovery: "none",
      originalLocked: false,
    });
    expect(fs.readFileSync(configPath)).toEqual(gatewayBytes);
    expect(fs.readFileSync(hashPath)).toEqual(staleHash);
  });

  it("bounds write-config stdin and deliberately rejects JSON5-only syntax", () => {
    const oversized = fixture();
    const oversizedConfig = fs.readFileSync(oversized.configPath);
    const expected = createHash("sha256").update(oversizedConfig).digest("hex");
    const tooLarge = runGuard(
      "write-config",
      oversized.configDir,
      "none",
      {},
      expected,
      Buffer.alloc(16 * 1024 * 1024 + 1, 0x20),
    );
    expect(tooLarge.status).toBe(1);
    expect(tooLarge.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "config-file-too-large" }),
      ]),
    );
    expect(fs.readFileSync(oversized.configPath)).toEqual(oversizedConfig);

    const json5 = fixture();
    const json5Config = fs.readFileSync(json5.configPath);
    const json5Expected = createHash("sha256").update(json5Config).digest("hex");
    const invalid = runGuard(
      "write-config",
      json5.configDir,
      "none",
      {},
      json5Expected,
      "{ // JSON5 comment\n gateway: { port: 19001 },\n}\n",
    );
    expect(invalid.status).toBe(1);
    expect(invalid.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "invalid-config-json",
          detail: expect.stringContaining("strict JSON"),
        }),
      ]),
    );
    expect(fs.readFileSync(json5.configPath)).toEqual(json5Config);
  });

  it("seals and unseals mutable restart config with stale hash and stale descriptors", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const config = fs.readFileSync(configPath);
    const digest = createHash("sha256").update(config).digest("hex");
    fs.writeFileSync(hashPath, `${"0".repeat(64)}  openclaw.json\n`, { mode: 0o660 });
    const oldConfigInode = fs.statSync(configPath).ino;
    const oldHashInode = fs.statSync(hashPath).ino;
    const staleConfig = fs.openSync(configPath, "r+");
    const staleHash = fs.openSync(hashPath, "r+");

    try {
      const sealed = runGuard("seal-restart", configDir);
      expect(sealed.status, JSON.stringify(sealed.lines)).toBe(0);
      expect(sealed.lines.at(-1)).toMatchObject({
        action: "seal-restart",
        originalLocked: false,
        configSha256: digest,
      });
      expect(mode(root)).toBe(0o1775);
      expect(mode(configDir)).toBe(0o755);
      expect(mode(configPath)).toBe(0o444);
      expect(mode(hashPath)).toBe(0o444);
      expect(fs.statSync(configPath).ino).not.toBe(oldConfigInode);
      expect(fs.statSync(hashPath).ino).not.toBe(oldHashInode);
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(`${digest}  openclaw.json\n`);

      fs.writeSync(staleConfig, Buffer.from("STALE!!"), 0, 7, 0);
      fs.writeSync(staleHash, Buffer.from("STALE!!"), 0, 7, 0);
      expect(fs.readFileSync(configPath)).toEqual(config);
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(`${digest}  openclaw.json\n`);

      const sealedConfigInode = fs.statSync(configPath).ino;
      const sealedHashInode = fs.statSync(hashPath).ino;
      const unsealed = runGuard("unseal-restart", configDir);
      expect(unsealed.status, JSON.stringify(unsealed.lines)).toBe(0);
      expect(unsealed.lines.at(-1)).toMatchObject({
        action: "unseal-restart",
        originalLocked: false,
      });
      expect(mode(root)).toBe(0o755);
      expect(mode(configDir)).toBe(0o2770);
      expect(mode(configPath)).toBe(0o660);
      expect(mode(hashPath)).toBe(0o660);
      expect(fs.statSync(configPath).ino).not.toBe(sealedConfigInode);
      expect(fs.statSync(hashPath).ino).not.toBe(sealedHashInode);
      expect(fs.existsSync(path.join(configDir, ".nemoclaw-config-transaction.json"))).toBe(false);
    } finally {
      fs.closeSync(staleConfig);
      fs.closeSync(staleHash);
    }
  });

  it("records shields-locked restart state without replacing or weakening the host seal", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    expect(runGuard("lock", configDir).status).toBe(0);
    const configInode = fs.statSync(configPath).ino;
    const hashInode = fs.statSync(hashPath).ino;

    const sealed = runGuard("seal-restart", configDir);
    expect(sealed.status).toBe(0);
    expect(sealed.lines.at(-1)).toMatchObject({ originalLocked: true });
    expect(fs.statSync(configPath).ino).toBe(configInode);
    expect(fs.statSync(hashPath).ino).toBe(hashInode);
    expect(mode(root)).toBe(0o1775);
    expect(mode(configDir)).toBe(0o755);

    const unsealed = runGuard("unseal-restart", configDir);
    expect(unsealed.status).toBe(0);
    expect(unsealed.lines.at(-1)).toMatchObject({ originalLocked: true });
    expect(fs.statSync(configPath).ino).toBe(configInode);
    expect(fs.statSync(hashPath).ino).toBe(hashInode);
    expect(mode(configPath)).toBe(0o444);
  });

  it("uses JSON5 validation for restart while locked posture still enforces hash coherence", () => {
    const json5 = fixture();
    const bytes = Buffer.from("{\n  // comment\n  gateway: { port: 18789, },\n}\n");
    fs.writeFileSync(json5.configPath, bytes, { mode: 0o660 });
    fs.writeFileSync(json5.hashPath, `${"0".repeat(64)}  openclaw.json\n`, { mode: 0o660 });
    expect(runGuard("preflight-restart", json5.configDir).status).toBe(0);
    expect(runGuard("seal-restart", json5.configDir).status).toBe(0);
    expect(runGuard("unseal-restart", json5.configDir).status).toBe(0);

    const locked = fixture();
    expect(runGuard("lock", locked.configDir).status).toBe(0);
    fs.chmodSync(locked.hashPath, 0o644);
    fs.writeFileSync(locked.hashPath, `${"0".repeat(64)}  openclaw.json\n`);
    fs.chmodSync(locked.hashPath, 0o444);
    const rejected = runGuard("preflight-restart", locked.configDir);
    expect(rejected.status).toBe(1);
    expect(rejected.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "config-hash-mismatch" }),
      ]),
    );
  });

  it.each([
    ["kill-seal-after-prepared", 101],
    ["kill-seal-after-freeze-parent", 102],
    ["kill-seal-after-freeze-config", 103],
    ["kill-seal-after-applying", 104],
    ["kill-seal-after-first-replace", 105],
    ["kill-seal-after-sealed-journal", 106],
    ["kill-seal-after-visible", 107],
  ] as const)("recovers an interrupted restart seal at %s", (failure, exitCode) => {
    const { root, configDir, configPath, hashPath } = fixture();
    const original = fs.readFileSync(configPath);
    const interrupted = runGuard("seal-restart", configDir, failure);
    expect(interrupted.status).toBe(exitCode);

    fs.rmSync(path.join(root, ".nemoclaw-test", "transaction.json"), { force: true });
    const recovered = runGuard("recover", configDir);
    expect(recovered.status, `${failure}: ${JSON.stringify(recovered.lines)}`).toBe(0);
    expect(fs.readFileSync(configPath)).toEqual(original);
    const recoveredMode = mode(configDir);
    expect([0o2770, 0o755]).toContain(recoveredMode);
    const recoveredLocked = recoveredMode === 0o755;
    expect(mode(configPath)).toBe(recoveredLocked ? 0o444 : 0o660);
    expect(mode(hashPath)).toBe(recoveredLocked ? 0o444 : 0o660);
    expect(recovered.lines.at(-1)).toMatchObject({ originalLocked: recoveredLocked });
  });

  it.each([
    ["kill-unseal-after-journal", 108],
    ["kill-unseal-after-first-replace", 109],
    ["kill-unseal-after-committed", 110],
    ["kill-unseal-after-visible", 111],
  ] as const)("recovers an interrupted restart unseal at %s", (failure, exitCode) => {
    const { root, configDir, configPath, hashPath } = fixture();
    const original = fs.readFileSync(configPath);
    expect(runGuard("seal-restart", configDir).status).toBe(0);
    const interrupted = runGuard("unseal-restart", configDir, failure);
    expect(interrupted.status).toBe(exitCode);

    fs.rmSync(path.join(root, ".nemoclaw-test", "transaction.json"), { force: true });
    const recovered = runGuard("recover", configDir);
    expect(recovered.status, `${failure}: ${JSON.stringify(recovered.lines)}`).toBe(0);
    expect(fs.readFileSync(configPath)).toEqual(original);
    const recoveredMode = mode(configDir);
    expect([0o2770, 0o755]).toContain(recoveredMode);
    const recoveredLocked = recoveredMode === 0o755;
    expect(mode(configPath)).toBe(recoveredLocked ? 0o444 : 0o660);
    expect(mode(hashPath)).toBe(recoveredLocked ? 0o444 : 0o660);
    expect(recovered.lines.at(-1)).toMatchObject({ originalLocked: recoveredLocked });
  });

  it("quarantines planted journal entry types and a last-moment swap without vetoing lock", () => {
    for (const attack of ["symlink", "file", "directory"] as const) {
      const current = fixture();
      const reserved = path.join(current.configDir, ".nemoclaw-config-transaction.json");
      const outside = path.join(current.root, `outside-${attack}`);
      fs.writeFileSync(outside, "outside\n");
      const plantJournal = {
        symlink: () => fs.symlinkSync(outside, reserved),
        file: () => fs.writeFileSync(reserved, "planted\n", { mode: 0o644 }),
        directory: () => fs.mkdirSync(reserved),
      } satisfies Record<typeof attack, () => void>;
      plantJournal[attack]();
      expect(runGuard("lock", current.configDir).status).toBe(0);
      expect(fs.readFileSync(outside, "utf-8")).toBe("outside\n");
      expect(mode(current.configPath)).toBe(0o444);

      for (const _directoryAttack of attack === "directory" ? [true] : []) {
        expect(runGuard("unlock", current.configDir).status).toBe(0);
        const retained = fs
          .readdirSync(current.configDir)
          .find((name) => name.startsWith(".nemoclaw-untrusted-journal-"));
        expect(retained).toBeDefined();
        fs.renameSync(path.join(current.configDir, retained!), reserved);
        expect(runGuard("lock", current.configDir).status).toBe(0);
      }
    }

    const swapped = fixture();
    fs.writeFileSync(path.join(swapped.root, "outside"), "outside\n");
    expect(runGuard("lock", swapped.configDir, "plant-journal-before-freeze").status).toBe(0);
    expect(mode(swapped.configPath)).toBe(0o444);
  });

  it("fresh-severs stale descriptors even when canonical install raises", () => {
    const { configDir, configPath, hashPath } = fixture();
    const config = fs.readFileSync(configPath);
    const digest = createHash("sha256").update(config).digest("hex");
    const configFd = fs.openSync(configPath, "r+");
    const hashFd = fs.openSync(hashPath, "r+");
    try {
      const result = runGuard("lock", configDir, "force-install-failure");
      expect(result.status).toBe(1);
      expect(mode(configPath)).toBe(0o444);
      expect(mode(hashPath)).toBe(0o444);
      fs.writeSync(configFd, Buffer.from("STALE!!"), 0, 7, 0);
      fs.writeSync(hashFd, Buffer.from("STALE!!"), 0, 7, 0);
      expect(fs.readFileSync(configPath)).toEqual(config);
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(`${digest}  openclaw.json\n`);
    } finally {
      fs.closeSync(configFd);
      fs.closeSync(hashFd);
    }
  });

  it("does not roll back after mutable handoff when journal cleanup fails", () => {
    const { root, configDir, configPath } = fixture();
    const original = fs.readFileSync(configPath);
    const expected = createHash("sha256").update(original).digest("hex");
    const replacement = Buffer.from('{"gateway":{"port":19001}}\n');
    const result = runGuard(
      "write-config",
      configDir,
      "clear-after-visible-fails",
      {},
      expected,
      replacement,
    );
    expect(result.status).toBe(0);
    expect(fs.readFileSync(configPath)).toEqual(replacement);
    expect(mode(configDir)).toBe(0o2770);
    expect(fs.existsSync(path.join(configDir, ".nemoclaw-config-transaction.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".nemoclaw-test", "transaction.json"))).toBe(true);
    expect(runGuard("recover", configDir).status).toBe(0);
    expect(fs.readFileSync(configPath)).toEqual(replacement);
  });

  it("preserves gateway writes after a crash in failed-write rollback handoff", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const original = fs.readFileSync(configPath);
    const originalHash = fs.readFileSync(hashPath);
    const expected = createHash("sha256").update(original).digest("hex");
    const intended = Buffer.from('{"gateway":{"port":19001}}\n');

    const interrupted = runGuard(
      "write-config",
      configDir,
      "second-replace-kill-rollback-visible",
      {},
      expected,
      intended,
    );
    expect(interrupted.status).toBe(112);
    expect(fs.readFileSync(configPath)).toEqual(original);
    expect(fs.readFileSync(hashPath)).toEqual(originalHash);
    expect(mode(configDir)).toBe(0o2770);
    expect(fs.existsSync(path.join(configDir, ".nemoclaw-config-transaction.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".nemoclaw-test", "transaction.json"))).toBe(true);

    const gatewayBytes = Buffer.from('{"gateway":{"port":19002},"runtime":true}\n');
    fs.writeFileSync(configPath, gatewayBytes, { mode: 0o660 });
    fs.chmodSync(configPath, 0o660);
    // The gateway is allowed to leave the mutable non-anchor hash stale.
    const recovered = runGuard("recover", configDir);
    expect(recovered.status, JSON.stringify(recovered.lines)).toBe(0);
    expect(recovered.lines.at(-1)).toMatchObject({
      recovery: "prepared-preserved",
      configSha256: createHash("sha256").update(gatewayBytes).digest("hex"),
      originalLocked: false,
    });
    expect(fs.readFileSync(configPath)).toEqual(gatewayBytes);
    expect(fs.readFileSync(hashPath)).toEqual(originalHash);
    expect(mode(configDir)).toBe(0o2770);
    expect(fs.existsSync(path.join(root, ".nemoclaw-test", "transaction.json"))).toBe(false);
  });

  it("serializes mutations, rejects a live owner, and reclaims a stale owner record", () => {
    const { root, configDir, configPath } = fixture();
    const ready = path.join(root, "mutex-ready");
    const child = spawn(
      "python3",
      ["-c", RUN_AS_CURRENT_USER, GUARD_PATH, "recover", configDir, "hold-mutex", ""],
      {
        env: {
          ...process.env,
          NEMOCLAW_TEST_NODE_PATH: trustedNodePath(configDir),
          NEMOCLAW_TEST_JSON5_PATH: path.resolve("nemoclaw/node_modules/json5"),
          NEMOCLAW_TEST_READY_FILE: ready,
        },
        stdio: "ignore",
      },
    );
    try {
      for (let attempt = 0; attempt < 80 && !fs.existsSync(ready); attempt += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      expect(fs.existsSync(ready)).toBe(true);
      const blocked = runGuard("lock", configDir);
      expect(blocked.status).toBe(1);
      expect(blocked.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "issue", code: "mutation-in-progress" }),
        ]),
      );
    } finally {
      child.kill("SIGKILL");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    const recoveredOwner = runGuard("lock", configDir);
    expect(recoveredOwner.status, JSON.stringify(recoveredOwner.lines)).toBe(0);
    expect(mode(configPath)).toBe(0o444);
  });

  it("enforces the installed-helper startup lease while retaining explicit old-image fallback", () => {
    const foreignPid1 = fixture();
    const foreignBlocked = runGuard("lock", foreignPid1.configDir, "installed-foreign-pid1");
    expect(foreignBlocked.status).toBe(1);
    expect(foreignBlocked.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "startup-not-ready" }),
      ]),
    );

    const beforeRevoke = fixture();
    const blocked = runGuard("lock", beforeRevoke.configDir, "installed-not-ready");
    expect(blocked.status).toBe(1);
    expect(blocked.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "startup-not-ready" }),
      ]),
    );

    const oldImage = fixture();
    expect(runGuard("lock", oldImage.configDir, "old-image-no-cap").status).toBe(0);

    const current = fixture();
    const revoked = runGuard("revoke-startup-ready", current.configDir, "startup-owner");
    expect(revoked.status, JSON.stringify(revoked.lines)).toBe(0);
    expect(runGuard("lock", current.configDir, "installed-current").status).toBe(1);
    expect(runGuard("publish-startup-ready", current.configDir, "startup-owner").status).toBe(0);
    expect(runGuard("lock", current.configDir, "installed-current").status).toBe(0);
    expect(runGuard("lock", current.configDir, "installed-remapped").status).toBe(0);

    const readyPath = path.join(current.root, ".nemoclaw-test", "ready.json");
    fs.writeFileSync(
      readyPath,
      `${JSON.stringify({
        pid: 1,
        pidNamespaceInode: 525252,
        pidStartTime: "525252",
        version: 2,
      })}\n`,
    );
    fs.chmodSync(readyPath, 0o600);
    const splitLease = runGuard("lock", current.configDir, "installed-remapped-any-live");
    expect(splitLease.status).toBe(1);
    expect(splitLease.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "startup-not-ready" }),
      ]),
    );
  });

  it("allows only authenticated no-capability non-root startup postures", () => {
    const degraded = fixture();
    expect(runGuard("lock", degraded.configDir, "installed-nonroot-no-cap").status).toBe(0);

    const optedIn = fixture();
    const revoked = runGuard("revoke-startup-ready", optedIn.configDir, "startup-owner");
    expect(revoked.status, JSON.stringify(revoked.lines)).toBe(0);
    const blocked = runGuard("lock", optedIn.configDir, "installed-nonroot-not-ready");
    expect(blocked.status).toBe(1);
    expect(blocked.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "startup-not-ready" }),
      ]),
    );

    const supervised = fixture();
    expect(runGuard("lock", supervised.configDir, "installed-openshell-supervised").status).toBe(0);

    const staleMarker = fixture();
    const staleBlocked = runGuard(
      "lock",
      staleMarker.configDir,
      "installed-openshell-stale-marker",
    );
    expect(staleBlocked.status).toBe(1);
    expect(staleBlocked.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "startup-not-ready" }),
      ]),
    );
  });

  it("keeps restart journal bounded near the maximum config size", () => {
    const { root, configDir, configPath, hashPath } = fixture();
    const max = 16 * 1024 * 1024;
    const prefix = Buffer.from('{"padding":"');
    const suffix = Buffer.from('"}\n');
    const large = Buffer.concat([
      prefix,
      Buffer.alloc(max - prefix.length - suffix.length, 0x61),
      suffix,
    ]);
    const digest = createHash("sha256").update(large).digest("hex");
    fs.writeFileSync(configPath, large, { mode: 0o660 });
    fs.writeFileSync(hashPath, `${digest}  openclaw.json\n`, { mode: 0o660 });

    const sealed = runGuard("seal-restart", configDir);
    expect(sealed.status, JSON.stringify(sealed.lines)).toBe(0);
    const persistent = path.join(configDir, ".nemoclaw-config-transaction.json");
    expect(fs.statSync(persistent).size).toBeLessThan(48 * 1024 * 1024);
    expect(fs.statSync(path.join(root, ".nemoclaw-test", "transaction.json")).size).toBeLessThan(
      48 * 1024 * 1024,
    );
    expect(runGuard("unseal-restart", configDir).status).toBe(0);
  }, 20_000);

  it("runs from source injected through python stdin", () => {
    const { root, configDir } = fixture();
    const maliciousCwd = path.join(root, "attacker-cwd");
    const importMarker = path.join(root, "attacker-secrets-imported");
    fs.mkdirSync(maliciousCwd);
    fs.writeFileSync(
      path.join(maliciousCwd, "secrets.py"),
      `from pathlib import Path\nPath(${JSON.stringify(importMarker)}).write_text("imported")\nraise RuntimeError("attacker module imported")\n`,
    );
    const source = fs
      .readFileSync(GUARD_PATH, "utf-8")
      .replace(/\nif __name__ == "__main__":\n    raise SystemExit\(main\(\)\)\s*$/, "");
    const injected =
      `${source}\n` +
      String.raw`
os.geteuid = lambda: 0
PRODUCTION_CONFIG_DIR = ${JSON.stringify("__CONFIG_DIR__")}
JOURNAL_PATH = ${JSON.stringify("__JOURNAL_PATH__")}
MUTEX_PATH = ${JSON.stringify("__MUTEX_PATH__")}
NODE_BINARY_PATH = ${JSON.stringify(trustedNodePath(configDir))}
JSON5_MODULE_PATH = ${JSON.stringify(path.resolve("nemoclaw/node_modules/json5"))}
_production_identity = lambda: Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=os.getgid(),
)
raise SystemExit(main())
`
        .replace("__CONFIG_DIR__", configDir)
        .replace(
          "__JOURNAL_PATH__",
          path.join(path.dirname(configDir), ".injected-journal", "transaction.json"),
        )
        .replace(
          "__MUTEX_PATH__",
          path.join(path.dirname(configDir), ".injected-journal", "mutation.lock"),
        );

    const result = spawnSync("python3", ["-I", "-", "preflight", "--config-dir", configDir], {
      input: injected,
      encoding: "utf-8",
      timeout: 15_000,
      cwd: maliciousCwd,
      env: { ...process.env, PYTHONPATH: maliciousCwd },
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(importMarker)).toBe(false);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      type: "result",
      action: "preflight",
      status: "ok",
    });
  });
});
