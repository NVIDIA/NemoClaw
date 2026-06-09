// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side shields management: down, up, status.
//
// Config starts mutable (the default state). Shields provide opt-in
// lockdown: `shields up` locks config + applies a restrictive network
// policy, `shields down` returns to the default (mutable) state.
// Time-bounded shields-down has automatic restore via a detached timer.
// The sandbox cannot lower or raise its own shields — all mutations are
// host-initiated (security invariant).

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { randomBytes } = require("crypto");
const { run, runCapture, validateName } = require("../runner");
const { dockerExecFileSync } = require("../adapters/docker/exec");
const {
  privilegedSandboxExecArgv,
}: typeof import("../sandbox/privileged-exec") = require("../sandbox/privileged-exec");
const {
  buildPolicyGetCommand,
  buildPolicySetCommand,
  parseCurrentPolicy,
  resolvePermissivePolicyPath,
} = require("../policy");
const {
  parseDuration,
  MAX_SECONDS,
  DEFAULT_SECONDS,
} = require("../domain/duration");
const {
  timerMarkerPath,
  readTimerMarker,
  clearTimerMarker,
  isProcessAlive,
  verifyTimerMarkerIdentity,
  killTimer,
} = require("./timer-control");
const { resolveNemoclawStateDir } = require("../state/paths");
const { appendAuditEntry } = require("./audit");
const { resolveAgentConfig } = require("../sandbox/config");
const {
  buildRuntimePermissivePolicy,
}: typeof import("./permissive-runtime") = require("./permissive-runtime");
const { cleanupTempDir } = require("../onboard/temp-files");
const {
  verifyShieldsLockState,
}: typeof import("./verify-lock") = require("./verify-lock");
const {
  parseSha256Output,
  isHashVerificationIssue,
  isSha256Hex,
}: typeof import("./seal") = require("./seal");
const {
  applyStateDirLockMode,
  preflightStateDirLock,
}: typeof import("./state-dir-lock") = require("./state-dir-lock");
const {
  inspectMutableConfigPerms: inspectMutableConfigPermsCore,
  repairMutableConfigPerms: repairMutableConfigPermsCore,
}: typeof import("./mutable-config-perms") = require("./mutable-config-perms");
type MutableConfigPermsInspection =
  import("./mutable-config-perms").MutableConfigPermsInspection;
type MutableConfigRepairResult =
  import("./mutable-config-perms").MutableConfigRepairResult;

const STATE_DIR = resolveNemoclawStateDir();

// ---------------------------------------------------------------------------
// privileged sandbox exec — bypasses the sandbox's Landlock context
//
// openshell sandbox exec runs commands INSIDE the Landlock domain, so it
// can't modify read_only paths or change chattr flags. We delegate the
// argv shape to the central registry-scoped helper in
// src/lib/sandbox/privileged-exec.ts, which fails closed when no matching
// sandbox container is running.
// ---------------------------------------------------------------------------

function privilegedSandboxExec(sandboxName: string, cmd: string[]): void {
  dockerExecFileSync(privilegedSandboxExecArgv(sandboxName, cmd), {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

function privilegedSandboxExecCapture(
  sandboxName: string,
  cmd: string[],
): string {
  return dockerExecFileSync(privilegedSandboxExecArgv(sandboxName, cmd), {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  }).trim();
}

// Re-export for tests and external consumers
const MAX_TIMEOUT_SECONDS = MAX_SECONDS;
const DEFAULT_TIMEOUT_SECONDS = DEFAULT_SECONDS;

// ---------------------------------------------------------------------------
// State helpers — read/write shields state per sandbox
// ---------------------------------------------------------------------------

function stateFilePath(sandboxName: string): string {
  return path.join(STATE_DIR, `shields-${sandboxName}.json`);
}

// Three-state shields model:
//   "mutable_default" — fresh sandbox, shields never configured (the default)
//   "locked"          — shields up has been run and verified
//   "temporarily_unlocked" — shields down after a prior shields up
type ShieldsMode = "mutable_default" | "locked" | "temporarily_unlocked";
type ShieldsPostureMode = ShieldsMode | "error";

interface ShieldsState {
  shieldsDown?: boolean;
  shieldsDownAt?: string | null;
  shieldsDownTimeout?: number | null;
  shieldsDownReason?: string | null;
  shieldsDownPolicy?: string | null;
  shieldsPolicySnapshotPath?: string | null;
  chattrApplied?: boolean;
  // SHA-256 seal of each locked file, captured by `shields up` after the
  // lock verification passes. `shields status` re-hashes the same files
  // inside the sandbox and flags drift on any mismatch. This catches the
  // host-root tamper pattern that defeats perm-only checks: chmod to
  // mutable -> write -> chmod back to 444 leaves mode/owner identical to
  // the locked baseline but produces a new content hash. Absent on state
  // files captured before the seal landed; on those legacy lockdowns
  // `shields up` refuses to seal an unverified baseline by default and
  // asks the operator to rebuild the sandbox, or to opt in via
  // `NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE=1`.
  fileHashes?: { [path: string]: string };
  updatedAt?: string;
}

type LoadedShieldsState = ShieldsState & {
  _hasStateFile: boolean;
  _isCorrupt?: boolean;
  _corruptError?: string;
};

interface ShieldsPosture {
  mode: ShieldsPostureMode;
  detail: string;
  statusText: string;
  locked: boolean;
  mutable: boolean;
  state: LoadedShieldsState;
}

type AgentConfigTarget = {
  agentName?: string;
  configPath: string;
  configDir: string;
  sensitiveFiles?: string[];
};

function failShieldsCommand(message: string, shouldThrow?: boolean): never {
  if (shouldThrow) throw new Error(message);
  process.exit(1);
}

/**
 * Derive the effective shields mode from persisted state.
 *
 * NC-2227-02: A fresh sandbox with no state file must report as
 * "mutable_default", NOT as "locked". Only report locked after
 * shields up has actually been run (shieldsDown === false AND
 * the state file exists with an updatedAt timestamp).
 */
function deriveShieldsMode(
  state: ShieldsState,
  hasStateFile: boolean,
): ShieldsMode {
  if (!hasStateFile) return "mutable_default";
  if (state.shieldsDown === true) return "temporarily_unlocked";
  if (state.shieldsDown === false) return "locked";
  // State file exists but shieldsDown is undefined — treat as mutable default
  return "mutable_default";
}

function describeShieldsMode(mode: ShieldsPostureMode): Omit<ShieldsPosture, "state"> {
  switch (mode) {
    case "mutable_default":
      return {
        mode,
        detail: "not configured (default mutable state)",
        statusText: "NOT CONFIGURED (default mutable state)",
        locked: false,
        mutable: true,
      };
    case "locked":
      return {
        mode,
        detail: "up (lockdown active)",
        statusText: "UP (lockdown active)",
        locked: true,
        mutable: false,
      };
    case "temporarily_unlocked":
      return {
        mode,
        detail: "down (temporarily unlocked)",
        statusText: "DOWN (temporarily unlocked)",
        locked: false,
        mutable: true,
      };
    case "error":
      return {
        mode,
        detail: "error (state file is corrupt)",
        statusText: "ERROR (state file is corrupt)",
        locked: false,
        mutable: true,
      };
  }
}

function loadShieldsState(sandboxName: string): LoadedShieldsState {
  const filePath = stateFilePath(sandboxName);
  if (!fs.existsSync(filePath)) return { _hasStateFile: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!isShieldsState(parsed)) {
      return {
        _hasStateFile: true,
        _isCorrupt: true,
        _corruptError: "invalid shields state shape",
      };
    }
    const state: ShieldsState = parsed;
    return { ...state, _hasStateFile: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      _hasStateFile: true,
      _isCorrupt: true,
      _corruptError: message,
    };
  }
}

function getShieldsPosture(
  sandboxName: string,
  allowInlineRecovery = false,
): ShieldsPosture {
  const state = recoverExpiredAutoRestoreGate(sandboxName, allowInlineRecovery);
  const mode = state._isCorrupt
    ? "error"
    : deriveShieldsMode(state, state._hasStateFile);
  return { ...describeShieldsMode(mode), state };
}

function saveShieldsState(
  sandboxName: string,
  patch: ShieldsState,
): ShieldsState {
  const current = loadShieldsState(sandboxName);
  // Strip runtime-only markers before persisting.
  const {
    _hasStateFile: _hasStateFile,
    _isCorrupt: _isCorrupt,
    _corruptError: _corruptError,
    ...currentClean
  } = current;
  const updated: ShieldsState = {
    ...currentClean,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    stateFilePath(sandboxName),
    JSON.stringify(updated, null, 2),
    { mode: 0o600 },
  );
  return updated;
}

type UnknownRecord = { [key: string]: unknown };

function isObjectRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNullableString(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNullableNumber(
  value: unknown,
): value is number | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

// SHA-256 hex strings are 64 lowercase or uppercase hex chars. The seal
// helper normalises to lowercase before persisting; accept either case
// here so manually edited state files and legacy uppercase entries still
// load, and reject anything that cannot be a real digest. Uses the same
// `isSha256Hex` predicate as the verifier so the persisted-state and
// runtime contracts stay aligned.
function isOptionalHashMap(
  value: unknown,
): value is { [path: string]: string } | undefined {
  if (value === undefined) return true;
  if (!isObjectRecord(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== "string" || !isSha256Hex(v)) return false;
  }
  return true;
}

function isShieldsState(value: unknown): value is ShieldsState {
  return (
    isObjectRecord(value) &&
    isOptionalBoolean(value.shieldsDown) &&
    isOptionalNullableString(value.shieldsDownAt) &&
    isOptionalNullableNumber(value.shieldsDownTimeout) &&
    isOptionalNullableString(value.shieldsDownReason) &&
    isOptionalNullableString(value.shieldsDownPolicy) &&
    isOptionalNullableString(value.shieldsPolicySnapshotPath) &&
    isOptionalBoolean(value.chattrApplied) &&
    isOptionalHashMap(value.fileHashes) &&
    isOptionalString(value.updatedAt)
  );
}

// ---------------------------------------------------------------------------
// State-dir lock — adapter between this module's privileged-exec helpers and
// the lock pipeline in ./state-dir-lock. The inventory of locked dirs, the
// preflight/mutation/verification logic, and the `agents/*/sessions`
// carve-out live in that sibling module so this file stays focused on
// shields state transitions.
// ---------------------------------------------------------------------------

function stateDirLockExec(sandboxName: string) {
  return {
    exec: (cmd: string[]) => privilegedSandboxExec(sandboxName, cmd),
    capture: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
  };
}

const CONFIG_UNLOCK_NOFOLLOW_SCRIPT = String.raw`
import errno
import fcntl
import grp
import os
import pwd
import stat
import struct
import sys

FS_IMMUTABLE_FL = 0x00000010
FS_IOC_GETFLAGS = 0x80086601
FS_IOC_SETFLAGS = 0x40086602

def die(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(1)

def resolve_user_group(owner):
    user, group = owner.split(":", 1)
    uid = int(user) if user.isdigit() else pwd.getpwnam(user).pw_uid
    gid = int(group) if group.isdigit() else grp.getgrnam(group).gr_gid
    return uid, gid

def open_checked(path, want_dir, dir_fd=None):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if want_dir:
        flags |= getattr(os, "O_DIRECTORY", 0)
    else:
        flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags, dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            die("refusing symlink path: " + path)
        die("open failed for %s: %s" % (path, exc))
    mode = os.fstat(fd).st_mode
    if want_dir and not stat.S_ISDIR(mode):
        os.close(fd)
        die("not a directory: " + path)
    if not want_dir and not stat.S_ISREG(mode):
        os.close(fd)
        die("not a regular file: " + path)
    return fd

def clear_immutable(fd):
    try:
        buf = bytearray(4)
        fcntl.ioctl(fd, FS_IOC_GETFLAGS, buf, True)
        flags = struct.unpack("I", buf)[0]
        if flags & FS_IMMUTABLE_FL:
            fcntl.ioctl(fd, FS_IOC_SETFLAGS, struct.pack("I", flags & ~FS_IMMUTABLE_FL))
    except OSError:
        # Best effort: fchown/fchmod and later lsattr verification surface failures.
        pass

def config_child_name(config_dir, path):
    normalized_dir = os.path.normpath(config_dir)
    normalized_path = os.path.normpath(path)
    if os.path.dirname(normalized_path) != normalized_dir:
        die("refusing config path outside config dir: " + path)
    name = os.path.basename(normalized_path)
    if name in ("", ".", ".."):
        die("refusing invalid config path: " + path)
    return name

file_mode = int(sys.argv[1], 8)
dir_mode = int(sys.argv[2], 8)
uid, gid = resolve_user_group(sys.argv[3])
config_dir = os.path.normpath(sys.argv[4])
files = sys.argv[5:]

parent_dir = os.path.dirname(config_dir)
config_name = os.path.basename(config_dir)
if parent_dir == "" or config_name in ("", ".", ".."):
    die("refusing invalid config dir: " + config_dir)

parent_fd = open_checked(parent_dir, True)
parent_stat = os.fstat(parent_fd)
dir_fd = None
dir_stat = None
unlock_ok = False
body_error = None
restore_errors = []
try:
    # Freeze the parent first. /sandbox is normally sandbox-owned, so otherwise
    # the agent could rename the config directory itself between fd operations.
    clear_immutable(parent_fd)
    os.fchown(parent_fd, 0, 0)
    os.fchmod(parent_fd, 0o755)

    dir_fd = open_checked(config_name, True, dir_fd=parent_fd)
    dir_stat = os.fstat(dir_fd)
    clear_immutable(dir_fd)
    os.fchown(dir_fd, 0, 0)
    os.fchmod(dir_fd, 0o700)

    for path in files:
        name = config_child_name(config_dir, path)
        fd = open_checked(name, False, dir_fd=dir_fd)
        try:
            clear_immutable(fd)
            os.fchown(fd, uid, gid)
            os.fchmod(fd, file_mode)
        finally:
            os.close(fd)

    # Verify before reopening the directory for sandbox writes.
    for path in files:
        name = config_child_name(config_dir, path)
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode):
            die("refusing symlink path after unlock: " + path)
        if not stat.S_ISREG(st.st_mode):
            die("not a regular file after unlock: " + path)
        if stat.S_IMODE(st.st_mode) != file_mode:
            die("mode mismatch after unlock for %s: %o" % (path, stat.S_IMODE(st.st_mode)))
        if st.st_uid != uid or st.st_gid != gid:
            die("owner mismatch after unlock for " + path)
    unlock_ok = True
except BaseException as exc:
    body_error = exc
finally:
    if dir_fd is not None:
        try:
            if unlock_ok:
                os.fchown(dir_fd, uid, gid)
                os.fchmod(dir_fd, dir_mode)
            elif dir_stat is not None:
                os.fchown(dir_fd, dir_stat.st_uid, dir_stat.st_gid)
                os.fchmod(dir_fd, stat.S_IMODE(dir_stat.st_mode))
        except OSError as exc:
            restore_errors.append(str(exc))
        os.close(dir_fd)
    try:
        os.fchown(parent_fd, parent_stat.st_uid, parent_stat.st_gid)
        os.fchmod(parent_fd, stat.S_IMODE(parent_stat.st_mode))
    except OSError as exc:
        restore_errors.append(str(exc))
    os.close(parent_fd)

if restore_errors:
    die("config path restore failed: " + "; ".join(restore_errors))
if body_error is not None:
    raise body_error
`;

function unlockConfigPathsNoSymlinkFollow(
  sandboxName: string,
  target: AgentConfigTarget,
  fileMode: string,
  dirMode: string,
  filesToUnlock: string[],
): void {
  privilegedSandboxExec(sandboxName, [
    "python3",
    "-c",
    CONFIG_UNLOCK_NOFOLLOW_SCRIPT,
    fileMode,
    dirMode,
    "sandbox:sandbox",
    target.configDir,
    ...filesToUnlock,
  ]);
}

function legacyDataDirFor(configDir: string): string {
  return `${configDir}-data`;
}

function assertNoLegacyStateLayout(
  sandboxName: string,
  configDir: string,
): void {
  const dataDir = legacyDataDirFor(configDir);
  const script =
    'set -u; config_dir="$1"; data_dir="$2"; data_real="$(readlink -f "$data_dir" 2>/dev/null || printf "%s" "$data_dir")"; if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then echo "legacy data dir exists: $data_dir"; exit 1; fi; for entry in "$config_dir"/*; do [ -L "$entry" ] || continue; target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"; case "$target" in "$data_real"/*|"$data_dir"/*) echo "legacy symlink remains: $entry -> $target"; exit 1;; esac; done';
  try {
    privilegedSandboxExecCapture(sandboxName, [
      "sh",
      "-c",
      script,
      "sh",
      configDir,
      dataDir,
    ]);
  } catch (err) {
    const execErr = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
    };
    const captured = [execErr.stdout, execErr.stderr]
      .map((value) => (value ? String(value).trim() : ""))
      .filter(Boolean)
      .join("\n");
    const message =
      captured || (err instanceof Error ? err.message : String(err));
    throw new Error(`legacy state layout still present: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Config unlock — returns config to the default (mutable) state
//
// Sets OpenClaw permissions to sandbox:sandbox 0660/2770 so both the sandbox
// user and the gateway UID can write the mutable config tree. Hermes keeps its
// tighter single-user layout.
//
// Note on chattr: best-effort — it may silently fail if kubectl exec
// lacks CAP_LINUX_IMMUTABLE or if the file was never immutable. That's fine:
// the file becomes writable through the permissive policy (disables Landlock
// read_only) + chown/chmod below.
// ---------------------------------------------------------------------------

function unlockAgentConfig(
  sandboxName: string,
  target: AgentConfigTarget,
): void {
  const errors: string[] = [];
  const filesToUnlock = [target.configPath, ...(target.sensitiveFiles || [])];
  // Mutable-default mode for OpenClaw: group-writable + setgid on the
  // config dir so the gateway UID (a member of the sandbox group via
  // Dockerfile.base) can write to OpenClaw config files. Without this,
  // control-UI mutations (Enable Dreaming, account toggles) EACCES
  // against sandbox:sandbox 600 even after shields-down
  // (#2681 supersedes #2693).
  // Hermes keeps config files non-group-writable, but its root entrypoint runs
  // the gateway as a separate UID in the sandbox group. The config root stays
  // group-writable + sticky so Hermes can create top-level runtime state while
  // the gateway UID cannot remove sandbox-owned config files.
  const fileMode = target.agentName === "hermes" ? "640" : "660";
  const dirMode = target.agentName === "hermes" ? "3770" : "2770";
  unlockConfigPathsNoSymlinkFollow(
    sandboxName,
    target,
    fileMode,
    dirMode,
    filesToUnlock,
  );

  // NC-2227-05: Restore sandbox ownership on locked state directories.
  // Use chown -R to restore the full tree (files within may have been
  // locked to root:root by a prior shields-up). Surface fan-out issues
  // so `shields down` cannot report success while a state dir is still
  // root-owned or read-only.
  const stateDirUnlockIssues = applyStateDirLockMode(
    stateDirLockExec(sandboxName),
    target.configDir,
    "sandbox:sandbox",
    false,
  );
  for (const issue of stateDirUnlockIssues) {
    errors.push(`state dir unlock: ${issue}`);
  }

  if (errors.length > 0) {
    console.error(
      `  Warning: Some unlock operations failed: ${errors.join(", ")}. Config may remain read-only.`,
    );
  }

  const issues: string[] = [];
  for (const f of filesToUnlock) {
    try {
      const perms = privilegedSandboxExecCapture(sandboxName, [
        "stat",
        "-c",
        "%a %U:%G",
        f,
      ]);
      const [mode, owner] = perms.split(" ");
      if (mode !== fileMode)
        issues.push(`${f} mode=${mode} (expected ${fileMode})`);
      if (owner !== "sandbox:sandbox")
        issues.push(`${f} owner=${owner} (expected sandbox:sandbox)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`${f} stat failed: ${msg}`);
    }
    try {
      const attrs = privilegedSandboxExecCapture(sandboxName, [
        "lsattr",
        "-d",
        f,
      ]);
      const [flags] = attrs.trim().split(/\s+/, 1);
      if (flags.includes("i")) issues.push(`${f} immutable bit still set`);
    } catch {
      // lsattr may not be available on all images — skip
    }
  }

  try {
    const dirPerms = privilegedSandboxExecCapture(sandboxName, [
      "stat",
      "-c",
      "%a %U:%G",
      target.configDir,
    ]);
    const [mode, owner] = dirPerms.split(" ");
    if (mode !== dirMode)
      issues.push(`config dir mode=${mode} (expected ${dirMode})`);
    if (owner !== "sandbox:sandbox") {
      issues.push(`config dir owner=${owner} (expected sandbox:sandbox)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(`config dir stat failed: ${msg}`);
  }

  if (issues.length > 0) {
    throw new Error(`Config not unlocked: ${issues.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Mutable-config permission repair / diagnostics (#4538)
//
// Sandbox-bound wrappers around the pure contract logic in
// ./mutable-config-perms.ts. See that module for the full rationale: in short,
// `openclaw doctor --fix` tightens NemoClaw's mutable config tree (setgid +
// group-writable 2770/660) back to single-user 700/600, which blocks the
// gateway UID from persisting config edits. These detect the drift and restore
// the contract without weakening an active shields-up lock.
// ---------------------------------------------------------------------------

function inspectMutableConfigPerms(
  sandboxName: string,
): MutableConfigPermsInspection {
  validateName(sandboxName, "sandbox name");
  const target = resolveAgentConfig(sandboxName);
  return inspectMutableConfigPermsCore(
    target,
    getShieldsPosture(sandboxName, true).mode,
    (p) => privilegedSandboxExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", p]),
  );
}

function repairMutableConfigPerms(
  sandboxName: string,
): MutableConfigRepairResult {
  validateName(sandboxName, "sandbox name");
  const target = resolveAgentConfig(sandboxName);
  return repairMutableConfigPermsCore(
    target,
    getShieldsPosture(sandboxName, true).mode,
    () => unlockAgentConfig(sandboxName, target),
  );
}

// ---------------------------------------------------------------------------
// Config lock — used by shields-up (opt-in lockdown), auto-restore timer,
// and rollback
//
// Each operation runs independently so a single failure does not skip the
// rest. After all attempts, we verify the actual on-disk state and throw
// if the config is not properly locked.
//
// The config file's protection comes from three layers:
//   1. Landlock read_only path — kernel-level, restored by policy snapshot
//   2. UNIX permissions — 444 root:root (mandatory, verified here)
//   3. chattr +i immutable bit — defense-in-depth (best-effort)
//
// Layer 3 is best-effort because kubectl exec may lack
// CAP_LINUX_IMMUTABLE. Layers 1+2 are sufficient. We still attempt it
// in case the runtime environment supports it.
// ---------------------------------------------------------------------------

function captureSealHashes(
  sandboxName: string,
  filesToHash: string[],
): { [path: string]: string } {
  const hashes: { [path: string]: string } = {};
  for (const f of filesToHash) {
    let raw: string;
    try {
      raw = privilegedSandboxExecCapture(sandboxName, ["sha256sum", f]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`sha256sum ${f} failed: ${msg}`);
    }
    const hex = parseSha256Output(raw);
    if (!hex) {
      throw new Error(`sha256sum ${f} returned unparsable output: ${raw}`);
    }
    hashes[f] = hex;
  }
  return hashes;
}

function lockAgentConfig(
  sandboxName: string,
  target: AgentConfigTarget,
): { chattrApplied: boolean; fileHashes: { [path: string]: string } } {
  const errors: string[] = [];
  const filesToLock = [target.configPath, ...(target.sensitiveFiles || [])];

  // Symlink preflight runs before any file or directory mutation: if a
  // pre-lockdown agent swapped e.g. `extensions/` for a symlink to /etc,
  // we abort before the privileged chmod/chown touches anything, so the
  // tree is never half-mutated against an attacker-controlled host path.
  const preflightIssues = preflightStateDirLock(
    stateDirLockExec(sandboxName),
    target.configDir,
  );
  if (preflightIssues.length > 0) {
    throw new Error(`Config not locked: ${preflightIssues.join(", ")}`);
  }

  for (const f of filesToLock) {
    try {
      privilegedSandboxExec(sandboxName, ["chmod", "444", f]);
    } catch {
      errors.push(`chmod 444 ${f}`);
    }
    try {
      privilegedSandboxExec(sandboxName, ["chown", "root:root", f]);
    } catch {
      errors.push(`chown root:root ${f}`);
    }
  }

  try {
    privilegedSandboxExec(sandboxName, ["chmod", "755", target.configDir]);
  } catch {
    errors.push("chmod 755 config dir");
  }

  try {
    privilegedSandboxExec(sandboxName, [
      "chown",
      "root:root",
      target.configDir,
    ]);
  } catch {
    errors.push("chown root:root config dir");
  }

  // Best-effort: kubectl exec may lack CAP_LINUX_IMMUTABLE. Track the
  // result so verification doesn't require something that was never there.
  let chattrSucceeded = true;
  for (const f of filesToLock) {
    try {
      privilegedSandboxExec(sandboxName, ["chattr", "+i", f]);
    } catch {
      chattrSucceeded = false;
    }
  }

  // Lock state directories. High-risk dirs use `root:sandbox` ownership so
  // the gateway (in the sandbox group) can still read plugin/agent code while
  // the sandbox user is denied write through `chmod -R go-w`. Secret-bearing
  // dirs (CONFIDENTIALITY_STATE_DIRS in ./state-dir-lock) go to `root:root`
  // 700/go-rwX so neither the sandbox user nor the gateway can read them
  // while shields are up. Top-level configDir stays root:root.
  const stateDirLockIssues = applyStateDirLockMode(
    stateDirLockExec(sandboxName),
    target.configDir,
    "root:sandbox",
    true,
  );
  if (stateDirLockIssues.length > 0) {
    // Symlinked state-dir roots are a security-relevant violation:
    // continuing would let shields-up report "locked" while a state
    // dir still points at a writable host path. Refuse the lock.
    throw new Error(`Config not locked: ${stateDirLockIssues.join(", ")}`);
  }

  // OpenClaw's mutable-default config root is setgid (#2681). Clear setgid
  // after descendant locking so shields-up verifies the root config dir as
  // plain 755, not 2755.
  try {
    privilegedSandboxExec(sandboxName, ["chmod", "g-s", target.configDir]);
  } catch {
    errors.push("chmod g-s config dir");
  }
  try {
    privilegedSandboxExec(sandboxName, ["chmod", "755", target.configDir]);
  } catch {
    errors.push("chmod 755 config dir");
  }

  if (errors.length > 0) {
    console.error(`  Some lock operations failed: ${errors.join(", ")}`);
  }

  // Verify the lock actually took effect.
  // Mode + ownership are mandatory (layers 1+2 depend on them).
  // Immutable bit is only verified if chattr succeeded above.
  const { issues } = verifyShieldsLockState(sandboxName, target, {
    verifyChattr: chattrSucceeded,
    exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
    assertLegacyLayout: assertNoLegacyStateLayout,
  });

  if (issues.length > 0) {
    throw new Error(`Config not locked: ${issues.join(", ")}`);
  }

  // Mode + ownership are clean; capture the SHA-256 seal of each locked
  // file so `shields status` can detect content drift even when an
  // attacker restores the mode/owner after writing.
  const fileHashes = captureSealHashes(sandboxName, filesToLock);

  return { chattrApplied: chattrSucceeded, fileHashes };
}

function rollbackShieldsDown(
  sandboxName: string,
  target: AgentConfigTarget,
  snapshotPath: string,
): void {
  console.error("  Rolling back — restoring policy from snapshot...");
  const rollbackResult = run(buildPolicySetCommand(snapshotPath, sandboxName), {
    ignoreError: true,
  });
  let rollbackChattrApplied: boolean | null = null;
  let rollbackFileHashes: { [path: string]: string } | null = null;
  if (rollbackResult.status === 0) {
    try {
      const lockResult = lockAgentConfig(sandboxName, target);
      rollbackChattrApplied = lockResult.chattrApplied;
      rollbackFileHashes = lockResult.fileHashes;
    } catch {
      console.error(
        "  Warning: Rollback re-lock could not be verified. Check config manually.",
      );
    }
  } else {
    console.error("  Warning: Policy restore failed during rollback.");
  }
  if (rollbackChattrApplied !== null && rollbackFileHashes !== null) {
    saveShieldsState(sandboxName, {
      shieldsDown: false,
      shieldsDownAt: null,
      shieldsDownTimeout: null,
      shieldsDownReason: null,
      shieldsDownPolicy: null,
      chattrApplied: rollbackChattrApplied,
      fileHashes: rollbackFileHashes,
    });
    console.error("  Lockdown restored. Config was never left unguarded.");
  } else {
    console.error("  Config remains unlocked — manual intervention required.");
    console.error(
      `  Re-lock manually via kubectl exec, then run: nemoclaw ${sandboxName} shields up`,
    );
  }
}

interface LockdownActivationResult {
  ok: boolean;
  error?: string;
  chattrApplied?: boolean;
  fileHashes?: { [path: string]: string };
}

function activateLockdownFromSnapshot(
  sandboxName: string,
  snapshotPath: string,
): LockdownActivationResult {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return { ok: false, error: "saved snapshot is missing" };
  }

  const restoreResult = run(buildPolicySetCommand(snapshotPath, sandboxName), {
    ignoreError: true,
  });
  const restoreStatus =
    typeof restoreResult.status === "number" ? restoreResult.status : 1;
  if (restoreStatus !== 0) {
    return {
      ok: false,
      error: `policy restore exited with status ${String(restoreStatus)}`,
    };
  }

  const target = resolveAgentConfig(sandboxName);
  try {
    const lockResult = lockAgentConfig(sandboxName, target);
    return {
      ok: true,
      chattrApplied: lockResult.chattrApplied,
      fileHashes: lockResult.fileHashes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function recoverExpiredAutoRestoreInline(
  sandboxName: string,
  state: ShieldsState & { _isCorrupt?: boolean; _corruptError?: string },
): { attempted: boolean; restored: boolean } {
  if (state._isCorrupt) return { attempted: false, restored: false };
  if (state.shieldsDown !== true) return { attempted: false, restored: false };

  const marker = readTimerMarker(sandboxName);
  if (!marker) return { attempted: false, restored: false };

  const restoreAtMs = new Date(marker.restoreAt).getTime();
  if (!Number.isFinite(restoreAtMs) || restoreAtMs > Date.now()) {
    return { attempted: false, restored: false };
  }

  // PID liveness alone is unsafe: after a reboot/OOM the original timer's PID
  // can be reassigned to an unrelated live process, which would otherwise block
  // recovery forever and reproduce the #3112 fail-open. Treat a live PID as
  // "our timer" only if cmdline + sandbox + processToken match.
  if (
    isProcessAlive(marker.pid) &&
    verifyTimerMarkerIdentity(marker).verified
  ) {
    return { attempted: false, restored: false };
  }

  console.error(
    "  Warning: auto-restore timer marker is expired and the timer process is not the recorded shields timer; attempting inline restore.",
  );

  const activation = activateLockdownFromSnapshot(
    sandboxName,
    marker.snapshotPath,
  );
  const nowIso = new Date().toISOString();
  if (!activation.ok) {
    appendAuditEntry({
      action: "shields_up_failed",
      sandbox: sandboxName,
      timestamp: nowIso,
      restored_by: "auto_timer",
      policy_snapshot: marker.snapshotPath,
      error: `Inline auto-restore failed: ${activation.error ?? "unknown error"}`,
    });
    console.error(
      "  Recovery warning: inline auto-restore failed; shields remain DOWN.",
    );
    console.error(
      `  Recovery warning: run \`nemoclaw ${sandboxName} shields up\` manually.`,
    );
    return { attempted: true, restored: false };
  }

  saveShieldsState(sandboxName, {
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    ...(activation.fileHashes && typeof activation.chattrApplied === "boolean"
      ? {
          chattrApplied: activation.chattrApplied,
          fileHashes: activation.fileHashes,
        }
      : {}),
  });
  clearTimerMarker(sandboxName);
  appendAuditEntry({
    action: "shields_auto_restore",
    sandbox: sandboxName,
    timestamp: nowIso,
    restored_by: "auto_timer",
    policy_snapshot: marker.snapshotPath,
    restored_at: nowIso,
  });
  return { attempted: true, restored: true };
}

function recoverExpiredAutoRestoreGate(
  sandboxName: string,
  allowInlineRecovery = true,
): LoadedShieldsState {
  const state = loadShieldsState(sandboxName);
  if (!allowInlineRecovery) return state;
  if (
    deriveShieldsMode(state, state._hasStateFile) !== "temporarily_unlocked"
  ) {
    return state;
  }

  const recovery = recoverExpiredAutoRestoreInline(sandboxName, state);
  if (!recovery.restored) return state;
  return loadShieldsState(sandboxName);
}

// ---------------------------------------------------------------------------
// shields down — return to default (mutable) state
//
// Unlocks config + applies permissive network policy. This is the default
// operating mode; shields-down undoes a previous shields-up lockdown.
// ---------------------------------------------------------------------------

interface ShieldsDownOpts {
  timeout?: string | null;
  reason?: string | null;
  policy?: string;
  skipTimer?: boolean;
  throwOnError?: boolean;
}

function shieldsDown(sandboxName: string, opts: ShieldsDownOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  if (state.shieldsDown) {
    console.error(
      `  Config is already unlocked for ${sandboxName} (since ${state.shieldsDownAt}).`,
    );
    console.error(
      "  Run `nemoclaw shields up` first, or use --extend (not yet implemented).",
    );
    return failShieldsCommand(`Config is already unlocked for ${sandboxName}`, opts.throwOnError);
  }

  // Kill stale auto-restore markers only when this command will actually
  // transition into shields-down. A repeated shields-down must not cancel the
  // active timer and leave the sandbox unlocked indefinitely.
  killTimer(sandboxName);

  const timeoutSeconds = parseDuration(
    opts.timeout || `${DEFAULT_TIMEOUT_SECONDS}`,
  );
  const reason = opts.reason || null;
  const policyName = opts.policy || "permissive";

  // 1. Capture current policy snapshot
  console.log("  Capturing current policy snapshot...");
  let rawPolicy: string;
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), {
      ignoreError: true,
    });
  } catch {
    rawPolicy = "";
  }

  const policyYaml = parseCurrentPolicy(rawPolicy);
  if (!policyYaml) {
    console.error("  Cannot capture current policy. Is the sandbox running?");
    return failShieldsCommand("Cannot capture current policy", opts.throwOnError);
  }

  const ts = Date.now();
  const snapshotPath = path.join(STATE_DIR, `policy-snapshot-${ts}.yaml`);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(snapshotPath, policyYaml, { mode: 0o600 });
  console.log(`  Saved: ${snapshotPath}`);

  // 2. Determine and apply relaxed policy
  let policyFile: string;
  let policyFileIsTemp = false;
  if (policyName === "permissive") {
    const basePath = resolvePermissivePolicyPath(sandboxName);
    // Union the live sandbox's filesystem_policy.read_only/read_write into
    // the static permissive baseline. OpenShell rejects removal of those
    // paths on a live sandbox, and runtime-injected entries (/proc on
    // GPU, /opt/hermes on Hermes, /home/linuxbrew on post-#3913 OpenClaw,
    // etc.) are not present in the static YAML. See #3942, #3957, #3168.
    // policyYaml is the pre-parsed body we already captured for the
    // snapshot above — reuse it instead of re-fetching.
    policyFile = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: policyYaml,
      readBasePolicy: () => fs.readFileSync(basePath, "utf-8"),
    });
    policyFileIsTemp = policyFile !== basePath;
  } else if (fs.existsSync(policyName)) {
    policyFile = path.resolve(policyName);
  } else {
    console.error(
      `  Unknown policy "${policyName}". Use "permissive" or a path to a YAML file.`,
    );
    return failShieldsCommand(`Unknown policy "${policyName}"`, opts.throwOnError);
  }

  console.log(`  Applying ${policyName} policy...`);
  try {
    run(buildPolicySetCommand(policyFile, sandboxName));
  } finally {
    if (policyFileIsTemp) {
      cleanupTempDir(policyFile, "nemoclaw-permissive-runtime");
    }
  }

  // 2b. Return config to default mutable state.
  //     OpenClaw uses sandbox:sandbox 0660/2770 here so the gateway UID, which
  //     is a member of the sandbox group, can mutate runtime config.
  const target = resolveAgentConfig(sandboxName);
  console.log(
    `  Unlocking ${target.agentName} config (${target.configPath})...`,
  );
  try {
    unlockAgentConfig(sandboxName, target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rollbackShieldsDown(sandboxName, target, snapshotPath);
    console.error(`  ERROR: ${message}`);
    console.error(
      "  Config did not reach the mutable-default state; refusing to save shields-down state.",
    );
    console.error(
      `  Re-run \`nemoclaw ${sandboxName} shields down\` after correcting file ownership.`,
    );
    return failShieldsCommand(message, opts.throwOnError);
  }

  // 3. Update state
  const now = new Date().toISOString();
  saveShieldsState(sandboxName, {
    shieldsDown: true,
    shieldsDownAt: now,
    shieldsDownTimeout: timeoutSeconds,
    shieldsDownReason: reason,
    shieldsDownPolicy: policyName,
    shieldsPolicySnapshotPath: snapshotPath,
  });

  // 4. Start auto-restore timer (detached child process), unless skipped.
  //    Pass the absolute restore time, not a relative timeout. Steps 1-2b
  //    can take minutes (policy apply + kubectl chmod), so a relative timeout
  //    passed at fork time would fire too early.
  if (!opts.skipTimer) {
    const restoreAt = new Date(Date.now() + timeoutSeconds * 1000);
    const processToken = randomBytes(16).toString("hex");
    const timerScript = path.join(__dirname, "timer.ts");
    const timerScriptJs = timerScript.replace(/\.ts$/, ".js");
    const actualScript = fs.existsSync(timerScriptJs)
      ? timerScriptJs
      : timerScript;

    try {
      const child = fork(
        actualScript,
        [
          sandboxName,
          snapshotPath,
          restoreAt.toISOString(),
          target.configPath,
          target.configDir,
          processToken,
        ],
        {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      child.disconnect();
      child.unref();

      // Write timer marker
      const markerPath = timerMarkerPath(sandboxName);
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          pid: child.pid,
          sandboxName,
          snapshotPath,
          restoreAt: restoreAt.toISOString(),
          processToken,
        }),
        { mode: 0o600 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Cannot start auto-restore timer: ${message}`);
      rollbackShieldsDown(sandboxName, target, snapshotPath);
      return failShieldsCommand(
        `Cannot start auto-restore timer: ${message}`,
        opts.throwOnError,
      );
    }
  }

  // 5. Audit log
  appendAuditEntry({
    action: "shields_down",
    sandbox: sandboxName,
    timestamp: now,
    timeout_seconds: timeoutSeconds,
    reason: reason ?? undefined,
    policy_applied: policyName,
    policy_snapshot: snapshotPath,
  });

  // 6. Output
  if (opts.skipTimer) {
    console.log(
      `  Config unlocked for ${sandboxName} (no auto-lockdown timer; caller will re-lock).`,
    );
  } else {
    const mins = Math.floor(timeoutSeconds / 60);
    const secs = timeoutSeconds % 60;
    console.log(
      `  Config unlocked for ${sandboxName} (auto-lockdown in: ${mins}m${secs ? ` ${secs}s` : ""})`,
    );
    console.log("");
    console.log("  Sandbox is in default (mutable) state.");
    console.log(
      `  Run \`nemoclaw ${sandboxName} shields up\` to opt into lockdown.`,
    );
  }
}

// ---------------------------------------------------------------------------
// shields up — opt into lockdown
//
// Locks config + applies restrictive network policy. This is an opt-in
// hardening step that restricts the sandbox beyond its default state.
// ---------------------------------------------------------------------------

function shieldsUp(sandboxName: string, opts: { throwOnError?: boolean } = {}): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  // shieldsDown === false means explicitly locked by a previous shields-up.
  // undefined (no state file) means fresh sandbox — mutable default, allow shields-up.
  if (state.shieldsDown === false) {
    // Verify the sandbox filesystem still matches the locked posture. If a
    // host-root tamper has reverted protected perms or rewritten file
    // content (even when the mode/owner is restored), re-apply the lock
    // so the recovery hint surfaced by `shields status` actually works.
    const target = resolveAgentConfig(sandboxName);
    const { issues } = verifyShieldsLockState(sandboxName, target, {
      verifyChattr: state.chattrApplied === true,
      exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
      assertLegacyLayout: assertNoLegacyStateLayout,
      expectedHashes: state.fileHashes,
    });
    // Classify the verifier output. "no seal recorded" entries mean the
    // verifier wanted a hash for a file that has no recorded baseline —
    // this happens both for legacy lockdowns (no fileHashes at all) and
    // for partial lockdowns whose seal predates a newly added sensitive
    // file. Everything else under `isHashVerificationIssue` is a real
    // content-trust failure (drift, sha256sum failure, unparsable
    // output) and never launderable.
    const hashIssues = issues.filter(isHashVerificationIssue);
    const realHashDrift = hashIssues.filter(
      (entry) => !entry.includes("no seal recorded"),
    );
    if (realHashDrift.length > 0) {
      console.error("  ERROR: locked file seal cannot be trusted:");
      for (const entry of realHashDrift) {
        console.error(`    - ${entry}`);
      }
      console.error(
        "  Refusing to re-seal a tampered baseline. Restore the file or rebuild the sandbox, then re-run shields up.",
      );
      return failShieldsCommand(
        `Locked file seal cannot be trusted: ${realHashDrift.join("; ")}`,
        opts.throwOnError,
      );
    }

    // Legacy lockdown (no fileHashes at all) or partial lockdown (some
    // sealed, some missing because the locked-file set grew between
    // releases). Both cases would seal the *current* bytes as the new
    // trusted baseline, which perm-only verification cannot prove are
    // untampered. Require explicit operator opt-in via the env var.
    const hasMissingSeals = hashIssues.length > realHashDrift.length;
    const requiresLegacyOptIn = !state.fileHashes || hasMissingSeals;
    if (
      requiresLegacyOptIn &&
      process.env.NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE !== "1"
    ) {
      console.error(
        state.fileHashes
          ? "  ERROR: locked sandbox seal is missing entries (locked file set grew after the existing seal was captured)."
          : "  ERROR: locked sandbox has no content seal (state predates the seal).",
      );
      console.error(
        "  Perm-only verification cannot prove the unsealed files have not already been tampered with.",
      );
      console.error(
        `  Recovery: rebuild the sandbox for a known-good baseline, then run \`nemoclaw ${sandboxName} shields up\`.`,
      );
      console.error(
        `  Or accept the current bytes as the trusted baseline by setting NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE=1 and rerunning.`,
      );
      return failShieldsCommand(
        state.fileHashes
          ? "Locked sandbox seal is incomplete; refusing to seal the missing entries without explicit operator acknowledgement"
          : "Locked sandbox has no content seal; refusing to seal a legacy baseline without explicit operator acknowledgement",
        opts.throwOnError,
      );
    }

    if (issues.length === 0) {
      // Verifier saw a clean lock. If the legacy-baseline opt-in was
      // required (no fileHashes), capture the seal now so future
      // `shields status` runs can detect content drift.
      if (!state.fileHashes) {
        try {
          const filesToHash = [
            target.configPath,
            ...(target.sensitiveFiles || []),
          ];
          const newHashes = captureSealHashes(sandboxName, filesToHash);
          saveShieldsState(sandboxName, { fileHashes: newHashes });
          console.log(
            "  Captured SHA-256 content seal for existing lockdown (current bytes accepted as baseline).",
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  ERROR: ${message}`);
          console.error(
            "  Could not capture content seal — sandbox filesystem may be unreachable.",
          );
          return failShieldsCommand(message, opts.throwOnError);
        }
      }
      clearTimerMarker(sandboxName);
      console.log("  Lockdown is already active.");
      return;
    }
    // At this point the verifier still flagged something: perm drift, or
    // missing-seal entries that the operator has just opted in to. In
    // both cases re-applying the lock rewrites perms and captures a
    // fresh, complete seal.
    console.log(
      `  Lockdown drifted — re-applying lock for ${sandboxName}...`,
    );
    let lockResult: { chattrApplied: boolean; fileHashes: { [path: string]: string } };
    try {
      lockResult = lockAgentConfig(sandboxName, target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${message}`);
      console.error(
        "  Config remains drifted — manual intervention required.",
      );
      return failShieldsCommand(message, opts.throwOnError);
    }
    saveShieldsState(sandboxName, {
      shieldsDown: false,
      chattrApplied: lockResult.chattrApplied,
      fileHashes: lockResult.fileHashes,
    });
    clearTimerMarker(sandboxName);
    appendAuditEntry({
      action: "shields_up",
      sandbox: sandboxName,
      timestamp: new Date().toISOString(),
      restored_by: "operator",
      reason: "drift remediation",
    });
    console.log(`  Lockdown re-applied for ${sandboxName}`);
    return;
  }

  // 1. Kill auto-restore timer if running
  killTimer(sandboxName);

  // 2. If coming from shields-down, restore the saved policy snapshot.
  //    If first shields-up on a fresh sandbox (no prior shields-down),
  //    the current policy is already the restrictive baseline — skip restore.
  const snapshotPath = state.shieldsDown
    ? state.shieldsPolicySnapshotPath
    : undefined;
  if (state.shieldsDown && (!snapshotPath || !fs.existsSync(snapshotPath))) {
    console.error(
      "  Cannot restore restrictive policy: saved snapshot is missing.",
    );
    console.error(
      "  Sandbox remains unlocked; recapture shields-down state before running shields up.",
    );
    return failShieldsCommand("Saved policy snapshot is missing", opts.throwOnError);
  }
  let snapshotLockResult:
    | { chattrApplied: boolean; fileHashes: { [path: string]: string } }
    | null = null;
  if (snapshotPath) {
    console.log("  Restoring restrictive policy from snapshot...");
    const activation = activateLockdownFromSnapshot(sandboxName, snapshotPath);
    if (!activation.ok) {
      console.error(`  ERROR: ${activation.error ?? "unknown restore error"}`);
      console.error(
        "  Config remains unlocked — manual intervention required.",
      );
      console.error(
        `  Re-lock manually via kubectl exec, then run: nemoclaw ${sandboxName} shields up`,
      );
      return failShieldsCommand(activation.error ?? "unknown restore error", opts.throwOnError);
    }
    if (activation.fileHashes && typeof activation.chattrApplied === "boolean") {
      snapshotLockResult = {
        chattrApplied: activation.chattrApplied,
        fileHashes: activation.fileHashes,
      };
    }
  } else {
    // 2b. Lock config file to read-only.
    //     Uses kubectl exec to bypass Landlock (same as shields down).
    //     Each operation runs independently and the result is verified.
    //     If verification fails, config remains unlocked — we do not lie about state.
    const target = resolveAgentConfig(sandboxName);
    console.log(
      `  Locking ${target.agentName} config (${target.configPath})...`,
    );
    let lockResult: { chattrApplied: boolean; fileHashes: { [path: string]: string } };
    try {
      lockResult = lockAgentConfig(sandboxName, target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${message}`);
      console.error(
        "  Config remains unlocked — manual intervention required.",
      );
      console.error(
        `  Re-lock manually via kubectl exec, then run: nemoclaw ${sandboxName} shields up`,
      );
      return failShieldsCommand(message, opts.throwOnError);
    }
    saveShieldsState(sandboxName, {
      chattrApplied: lockResult.chattrApplied,
      fileHashes: lockResult.fileHashes,
    });
  }

  // 3. Calculate duration
  const downAt = state.shieldsDownAt
    ? new Date(state.shieldsDownAt)
    : new Date();
  const now = new Date();
  const durationSeconds = Math.floor((now.getTime() - downAt.getTime()) / 1000);

  // 4. Update state. When the snapshot-restore branch ran, fold its
  //    captured chattrApplied + fileHashes into the persisted state so
  //    drift detection on the next `shields status` has a seal to compare
  //    against. The non-snapshot branch already persisted those above.
  saveShieldsState(sandboxName, {
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    ...(snapshotLockResult
      ? {
          chattrApplied: snapshotLockResult.chattrApplied,
          fileHashes: snapshotLockResult.fileHashes,
        }
      : {}),
  });
  clearTimerMarker(sandboxName);

  // 5. Audit log
  appendAuditEntry({
    action: "shields_up",
    sandbox: sandboxName,
    timestamp: now.toISOString(),
    restored_by: "operator",
    duration_seconds: durationSeconds,
    policy_snapshot: snapshotPath,
    reason: state.shieldsDownReason ?? undefined,
  });

  // 6. Output
  const mins = Math.floor(durationSeconds / 60);
  const secs = durationSeconds % 60;
  console.log(`  Lockdown active for ${sandboxName}`);
  console.log(
    `  Duration unlocked: ${mins}m ${secs}s | Reason: ${state.shieldsDownReason ?? "not specified"}`,
  );
}

// ---------------------------------------------------------------------------
// shields status
// ---------------------------------------------------------------------------

type ShieldsStatusDeps = {
  verifyLockState?: typeof verifyShieldsLockState;
  resolveConfig?: typeof resolveAgentConfig;
};

function shieldsStatus(
  sandboxName: string,
  allowInlineRecovery = true,
  deps: ShieldsStatusDeps = {},
): void {
  validateName(sandboxName, "sandbox name");

  const verify = deps.verifyLockState ?? verifyShieldsLockState;
  const resolveConfig = deps.resolveConfig ?? resolveAgentConfig;

  const posture = getShieldsPosture(sandboxName, allowInlineRecovery);
  const { state } = posture;
  if (state._isCorrupt) {
    console.error("  Shields: ERROR (state file is corrupt)");
    console.error(
      `  ${stateFilePath(sandboxName)} could not be parsed: ${state._corruptError ?? "unknown error"}`,
    );
    console.error(
      `  Recovery warning: run \`nemoclaw ${sandboxName} shields up\` to restore a known-good state.`,
    );
    process.exit(1);
  }

  switch (posture.mode) {
    case "mutable_default":
      // NC-2227-02: Fresh sandbox with no shields history — do NOT claim locked
      console.log(`  Shields: ${posture.statusText}`);
      console.log(
        "  Config is mutable. Run `nemoclaw <sandbox> shields up` to opt into lockdown.",
      );
      return;

    case "locked": {
      // Cross-check the sandbox filesystem so a host-root tamper that reverts
      // protected perms back to a sandbox-writable state is surfaced as drift
      // instead of reported as a clean lockdown.
      let driftIssues: string[] = [];
      try {
        const target = resolveConfig(sandboxName);
        driftIssues = verify(sandboxName, target, {
          verifyChattr: state.chattrApplied === true,
          exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
          assertLegacyLayout: assertNoLegacyStateLayout,
          expectedHashes: state.fileHashes,
        }).issues;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        driftIssues = [`unable to resolve agent config target: ${msg}`];
      }
      const policyLine = `  Policy:  restrictive${state.shieldsPolicySnapshotPath ? " (snapshot preserved)" : ""}`;
      if (driftIssues.length > 0) {
        console.error(
          "  Shields: UP (DRIFTED — declared locked but sandbox filesystem differs)",
        );
        console.error(policyLine);
        if (state.shieldsDownAt) {
          console.error(`  Last unlocked: ${state.shieldsDownAt}`);
        }
        console.error("  Drift:");
        for (const issue of driftIssues) {
          console.error(`    - ${issue}`);
        }
        // Hash-trust failures cannot be repaired by re-locking — re-up
        // would just seal the tampered or unverifiable content. Perm
        // drift (mode/owner/chattr/legacy-layout) is launderable by
        // re-up. Surface the right recovery for the failure mode.
        const hasHashTrouble = driftIssues.some(isHashVerificationIssue);
        if (hasHashTrouble) {
          console.error(
            `  Recovery: restore the original file content from a trusted source, or rebuild the sandbox, then run \`nemoclaw ${sandboxName} shields up\` to re-seal.`,
          );
        } else {
          console.error(
            `  Recovery: nemoclaw ${sandboxName} shields up   # re-lock and re-verify`,
          );
        }
        process.exit(2);
      }
      if (!state.fileHashes) {
        // Legacy state file pre-dates the content seal. Perm-only
        // verification cannot prove the locked bytes were not already
        // tampered before the upgrade, so we cannot honestly call this
        // a clean lockdown. Surface integrity-unknown and exit with
        // status 2 (same code as drifted) so scripts treat it as a
        // failure until the operator seals an explicit baseline.
        console.error(
          "  Shields: UP (UNSEALED — content integrity unknown for legacy lockdown)",
        );
        console.error(policyLine);
        if (state.shieldsDownAt) {
          console.error(`  Last unlocked: ${state.shieldsDownAt}`);
        }
        console.error(
          "  Recovery: rebuild the sandbox for a known-good baseline,",
        );
        console.error(
          `  or set NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE=1 and re-run \`nemoclaw ${sandboxName} shields up\` to seal the current bytes.`,
        );
        process.exit(2);
      }
      console.log(`  Shields: ${posture.statusText}`);
      console.log(policyLine);
      if (state.shieldsDownAt) {
        console.log(`  Last unlocked: ${state.shieldsDownAt}`);
      }
      return;
    }

    case "temporarily_unlocked": {
      const downSince = state.shieldsDownAt
        ? new Date(state.shieldsDownAt)
        : null;
      const elapsed = downSince
        ? Math.floor((Date.now() - downSince.getTime()) / 1000)
        : 0;
      const remaining =
        state.shieldsDownTimeout != null
          ? Math.max(0, state.shieldsDownTimeout - elapsed)
          : null;

      console.log(`  Shields: ${posture.statusText}`);
      console.log(`  Since:   ${state.shieldsDownAt ?? "unknown"}`);
      if (remaining !== null) {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        console.log(`  Auto-lockdown in: ${mins}m ${secs}s`);
      }
      console.log(`  Reason:  ${state.shieldsDownReason ?? "not specified"}`);
      console.log(`  Policy:  ${state.shieldsDownPolicy ?? "permissive"}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Query — check whether shields are currently down
// ---------------------------------------------------------------------------

/**
 * Legacy mutability predicate. Fresh sandboxes and temporarily unlocked
 * sandboxes both return true because their config is mutable; user-facing
 * callers should use getShieldsPosture() so fresh state is labeled as
 * "not configured" instead of "down".
 */
function isShieldsDown(sandboxName: string, allowInlineRecovery = false): boolean {
  const state = recoverExpiredAutoRestoreGate(sandboxName, allowInlineRecovery);
  if (state._isCorrupt) return false;
  const mode = deriveShieldsMode(state, state._hasStateFile);
  return mode !== "locked";
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  DEFAULT_TIMEOUT_SECONDS,
  deriveShieldsMode,
  getShieldsPosture,
  inspectMutableConfigPerms,
  isShieldsDown,
  killTimer,
  lockAgentConfig,
  MAX_TIMEOUT_SECONDS,
  parseDuration,
  repairMutableConfigPerms,
  shieldsDown,
  shieldsStatus,
  shieldsUp,
  unlockAgentConfig,
};
