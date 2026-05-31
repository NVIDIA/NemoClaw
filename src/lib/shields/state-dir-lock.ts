// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// State-dir lock fan-out for shields up/down. Owns the inventory of
// high-risk and secret-bearing state directories, the preflight + mutation
// + verification pipeline, and the runtime-subpath carve-out for
// `agents/*/sessions`. The shields entrypoint (`src/lib/shields/index.ts`)
// stays focused on shields state transitions and delegates the chown/chmod
// fan-out to this module.

export interface PrivilegedExec {
  exec(cmd: string[]): void;
  capture(cmd: string[]): string;
}

// ---------------------------------------------------------------------------
// State directories locked by shields-up.
//
// During shields-up, these must be locked so the sandbox user cannot create
// new entries or modify existing ones. This covers both executable state
// (skills, hooks, cron jobs, extensions, plugins, agent definitions) and
// writable agent state entry points such as workspace and memory, so a stale
// symlink bridge cannot bypass the lockdown.
//
// Lock ownership for HIGH_RISK_STATE_DIRS is `root:sandbox` (not
// `root:root`): the OpenClaw gateway runs as `gateway`, which is a member of
// the sandbox group via `Dockerfile.base`. Owning these dirs as
// `root:sandbox` preserves the sandbox group's `r-x` access to descendant
// files (after `chmod -R go-w`), so plugin discovery can still scan
// `extensions/<plugin>/` while the sandbox user is denied write through the
// stripped group/other write bits.
//
// CONFIDENTIALITY_STATE_DIRS holds secret-bearing trees (auth tokens, host
// device pairing material). These get a stricter posture under shields-up:
// `root:root 700` with `chmod -R go-rwX`, so neither the sandbox user nor
// the gateway can read them while shields are up. The mutable-default
// posture is restored on shields-down.
//
// The list is a superset: directories that don't exist in a given agent's
// config dir are silently skipped.
//
// Coverage tracks the union of state_dirs declared by every shipped agent
// manifest (agents/openclaw/manifest.yaml, agents/hermes/manifest.yaml).
// Runtime-mutable subtrees that must keep being writable while shields are
// up are intentionally omitted:
//   - `sessions` (Hermes top-level) and `agents/*/sessions` (OpenClaw) — the
//     latter is restored via WRITABLE_RUNTIME_SUBPATHS after the lock loop.
//   - `memories`, `logs`, `cache`, `plans` (Hermes) — runtime mutables.
//   - `openclaw-weixin` is regenerated from envs at image-build time
//     (see src/lib/actions/sandbox/rebuild.ts) and is not a manifest state_dir.
// Any new agent state_dir that holds executable code or credentials must be
// added to one of these sets in lockstep with its manifest entry.
// ---------------------------------------------------------------------------

export const HIGH_RISK_STATE_DIRS = [
  "skills",
  "hooks",
  "cron",
  "agents",
  "extensions",
  "plugins", // Hermes equivalent of extensions
  "workspace",
  "memory",
  "devices",
  "canvas",
  "telegram",
  "wechat", // OpenClaw runtime channel state
  "whatsapp", // OpenClaw + Hermes channel state (Hermes also nests under platforms/)
  "platforms", // Hermes channel-bridge auth state (whatsapp/, etc.)
  "weixin", // Hermes iLink WeChat per-account context tokens
  "profiles", // Hermes saved profiles
  "skins", // Hermes UI/personality bundles (code-like)
];

export const CONFIDENTIALITY_STATE_DIRS = [
  "credentials",
  "identity",
  "pairing", // Hermes device-pairing material (auth tokens)
];

// Runtime-data subpaths the agent must keep writing to under shields-up.
// Each entry is a shell glob relative to the agent config dir; after the
// main lock loop the matching directories are restored to
// `sandbox:sandbox 2770` so they remain writable inside an otherwise-locked
// tree.
//
// Removal condition: when the OpenClaw runtime moves session state out of
// the locked config tree (e.g. into `/sandbox/.openclaw-runtime/`), this
// carve-out can be deleted and lockAgentConfig can leave the tree fully
// owned by `root:sandbox` with no writable holes.
export const WRITABLE_RUNTIME_SUBPATHS = ["agents/*/sessions"];

interface StateDirLockScript {
  script: string;
  args: string[];
}

interface StateDirLockScriptResult {
  symlinkedRoots: string[];
  mutationFailures: Array<{ op: string; path: string }>;
}

interface PreflightResult {
  symlinkedRoots: string[];
  // Non-null when the preflight exec itself failed. Fail-closed: the
  // caller must treat a non-null `error` as "do not lock" so a kubectl
  // exec hiccup cannot let shields-up advance while a symlinked root
  // remains unobserved.
  error: string | null;
}

// Apply lock or unlock mode to every existing high-risk and confidentiality
// state directory under `configDir`. Returns a list of issues; an empty
// list means the fan-out completed cleanly.
export function applyStateDirLockMode(
  privileged: PrivilegedExec,
  configDir: string,
  highRiskOwner: string,
  isLocking: boolean,
): string[] {
  const allStateDirs = [...HIGH_RISK_STATE_DIRS, ...CONFIDENTIALITY_STATE_DIRS];

  // Preflight: before any chown/chmod runs, scan every state-dir root and
  // every workspace-* dir for symlinked roots. A pre-lockdown agent that
  // swapped e.g. `extensions/` for a symlink to /etc could otherwise
  // redirect the privileged `chown -R`/`chmod -R` at an attacker-controlled
  // host path.
  const preflight = preflightSymlinkedRoots(privileged, configDir, allStateDirs);
  if (isLocking && preflight.error !== null) {
    return [`Symlink preflight failed; refusing to lock: ${preflight.error}`];
  }
  if (isLocking && preflight.symlinkedRoots.length > 0) {
    return preflight.symlinkedRoots.map(
      (path) => `state dir root is a symlink: ${path} (refusing to lock)`,
    );
  }

  // Locking (shields-up) strips group + world write for HIGH_RISK dirs.
  // Unlocking (shields-down) restores the same group-readable/writable +
  // o-rwx mutable-default contract as startup, plus setgid so the gateway
  // UID — now in the sandbox group via Dockerfile.base — can write to
  // OpenClaw's mutable config tree (#2681). The unlock variant uses
  // `g+rwX,o-rwx` because a prior lock can strip group access from
  // descendants.
  const highRiskRecursiveMode = isLocking ? "go-w" : "g+rwX,o-rwx";
  const highRiskDirMode = isLocking ? "755" : "2770";
  const clearSetgid = isLocking ? "1" : "0";

  const mainPassResult = runStateDirLockScript(privileged, {
    script: STATE_DIR_LOCK_SCRIPT_BY_LIST,
    args: [
      configDir,
      highRiskOwner,
      highRiskRecursiveMode,
      highRiskDirMode,
      clearSetgid,
      ...HIGH_RISK_STATE_DIRS,
    ],
  });

  // Multi-agent OpenClaw workspaces are named workspace-<agent>. Glob is
  // expanded by the shell because the list is configured by openclaw.json.
  const workspacePassResult = runStateDirLockScript(privileged, {
    script: STATE_DIR_LOCK_SCRIPT_WORKSPACE_GLOB,
    args: [configDir, highRiskOwner, highRiskRecursiveMode, highRiskDirMode, clearSetgid],
  });

  // Secret-bearing dirs: stricter posture. Locked = `root:root 700` with
  // `go-rwX` so neither sandbox user nor gateway can read them while
  // shields are up. Unlocked = sandbox:sandbox 2770 / g+rwX.
  const confidentialityOwner = isLocking ? "root:root" : highRiskOwner;
  const confidentialityRecursiveMode = isLocking ? "go-rwX" : "g+rwX,o-rwx";
  const confidentialityDirMode = isLocking ? "700" : "2770";
  const confidentialityPassResult = runStateDirLockScript(privileged, {
    script: STATE_DIR_LOCK_SCRIPT_BY_LIST,
    args: [
      configDir,
      confidentialityOwner,
      confidentialityRecursiveMode,
      confidentialityDirMode,
      clearSetgid,
      ...CONFIDENTIALITY_STATE_DIRS,
    ],
  });

  const issues: string[] = [];
  const allResults = [mainPassResult, workspacePassResult, confidentialityPassResult];
  for (const result of allResults) {
    for (const path of result.symlinkedRoots) {
      issues.push(`state dir root is a symlink: ${path} (refusing to lock)`);
    }
    for (const failure of result.mutationFailures) {
      issues.push(`state dir mutation failed (${failure.op}): ${failure.path}`);
    }
  }

  if (isLocking) {
    issues.push(
      ...verifyStateDirsLocked(privileged, configDir, {
        highRiskOwner,
        highRiskDirMode,
        confidentialityOwner,
        confidentialityDirMode,
      }),
    );
  }

  // Restoration of runtime-writable subpaths runs only when the lock
  // fan-out reported no issues. If preflight, mutation, or verification
  // surfaced anything, the tree is in a known-bad state and re-opening
  // `agents/*/sessions` for the sandbox user would widen the blast radius
  // of whatever broke.
  if (isLocking && issues.length === 0) {
    const restoreError = restoreWritableRuntimeSubpaths(privileged, configDir);
    if (restoreError !== null) {
      issues.push(`runtime-writable subpath restore failed: ${restoreError}`);
    }
  }
  return issues;
}

const STATE_DIR_LOCK_SCRIPT_BY_LIST = `
set -u
config_dir="$1"
owner="$2"
recursive_mode="$3"
dir_mode="$4"
clear_setgid="$5"
shift 5
for dir in "$@"; do
  path="$config_dir/$dir"
  if [ -L "$path" ]; then
    printf 'symlinked-root\\t%s\\n' "$path"
    continue
  fi
  [ -d "$path" ] || continue
  if ! chown -R "$owner" "$path" 2>/dev/null; then
    printf 'mutation-failed\\tchown\\t%s\\n' "$path"
  fi
  if ! chmod "$dir_mode" "$path" 2>/dev/null; then
    printf 'mutation-failed\\tchmod-dir\\t%s\\n' "$path"
  fi
  if [ "$clear_setgid" = "1" ]; then
    chmod g-s "$path" 2>/dev/null || true
  fi
  if ! chmod -R "$recursive_mode" "$path" 2>/dev/null; then
    printf 'mutation-failed\\tchmod-recursive\\t%s\\n' "$path"
  fi
done
`;

const STATE_DIR_LOCK_SCRIPT_WORKSPACE_GLOB = `
set -u
config_dir="$1"
owner="$2"
recursive_mode="$3"
dir_mode="$4"
clear_setgid="$5"
for dir in "$config_dir"/workspace-*; do
  if [ -L "$dir" ]; then
    printf 'symlinked-root\\t%s\\n' "$dir"
    continue
  fi
  [ -d "$dir" ] || continue
  if ! chown -R "$owner" "$dir" 2>/dev/null; then
    printf 'mutation-failed\\tchown\\t%s\\n' "$dir"
  fi
  if ! chmod "$dir_mode" "$dir" 2>/dev/null; then
    printf 'mutation-failed\\tchmod-dir\\t%s\\n' "$dir"
  fi
  if [ "$clear_setgid" = "1" ]; then
    chmod g-s "$dir" 2>/dev/null || true
  fi
  if ! chmod -R "$recursive_mode" "$dir" 2>/dev/null; then
    printf 'mutation-failed\\tchmod-recursive\\t%s\\n' "$dir"
  fi
done
`;

interface VerifyExpectations {
  highRiskOwner: string;
  highRiskDirMode: string;
  confidentialityOwner: string;
  confidentialityDirMode: string;
}

function verifyStateDirsLocked(
  privileged: PrivilegedExec,
  configDir: string,
  expected: VerifyExpectations,
): string[] {
  const issues: string[] = [];
  issues.push(
    ...verifyStateDirGroup(privileged, configDir, HIGH_RISK_STATE_DIRS, {
      owner: expected.highRiskOwner,
      dirMode: expected.highRiskDirMode,
      includeWorkspaceGlob: true,
    }),
  );
  issues.push(
    ...verifyStateDirGroup(privileged, configDir, CONFIDENTIALITY_STATE_DIRS, {
      owner: expected.confidentialityOwner,
      dirMode: expected.confidentialityDirMode,
      includeWorkspaceGlob: false,
    }),
  );
  return issues;
}

function verifyStateDirGroup(
  privileged: PrivilegedExec,
  configDir: string,
  dirs: readonly string[],
  expected: { owner: string; dirMode: string; includeWorkspaceGlob: boolean },
): string[] {
  let stdout = "";
  try {
    stdout = privileged.capture([
      "sh",
      "-c",
      `
set -u
config_dir="$1"
expected_owner="$2"
expected_mode="$3"
include_workspace="$4"
shift 4
check() {
  path="$1"
  [ -L "$path" ] && { printf 'verify-symlink\\t%s\\n' "$path"; return; }
  [ -d "$path" ] || return
  perms="$(stat -c '%a %U:%G' "$path" 2>/dev/null)" || {
    printf 'verify-stat-failed\\t%s\\n' "$path"
    return
  }
  mode="\${perms%% *}"
  owner="\${perms#* }"
  [ "$mode" = "$expected_mode" ] || printf 'verify-mode\\t%s\\t%s\\t%s\\n' "$path" "$mode" "$expected_mode"
  [ "$owner" = "$expected_owner" ] || printf 'verify-owner\\t%s\\t%s\\t%s\\n' "$path" "$owner" "$expected_owner"
}
for dir in "$@"; do
  check "$config_dir/$dir"
done
if [ "$include_workspace" = "1" ]; then
  for dir in "$config_dir"/workspace-*; do
    case "$dir" in *"*"*) continue ;; esac
    check "$dir"
  done
fi
`,
      "sh",
      configDir,
      expected.owner,
      expected.dirMode,
      expected.includeWorkspaceGlob ? "1" : "0",
      ...dirs,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`state dir verification exec failed: ${msg}`];
  }
  const issues: string[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts[0] === "verify-symlink" && parts[1]) {
      issues.push(`state dir became a symlink mid-lock: ${parts[1]}`);
    } else if (parts[0] === "verify-stat-failed" && parts[1]) {
      issues.push(`state dir stat failed after lock: ${parts[1]}`);
    } else if (parts[0] === "verify-mode" && parts[1]) {
      issues.push(`state dir mode=${parts[2]} (expected ${parts[3]}): ${parts[1]}`);
    } else if (parts[0] === "verify-owner" && parts[1]) {
      issues.push(`state dir owner=${parts[2]} (expected ${parts[3]}): ${parts[1]}`);
    }
  }
  return issues;
}

function preflightSymlinkedRoots(
  privileged: PrivilegedExec,
  configDir: string,
  allStateDirs: readonly string[],
): PreflightResult {
  let stdout = "";
  try {
    stdout = privileged.capture([
      "sh",
      "-c",
      `
set -u
config_dir="$1"
shift
for dir in "$@"; do
  path="$config_dir/$dir"
  [ -L "$path" ] && printf '%s\\n' "$path"
done
for dir in "$config_dir"/workspace-*; do
  [ -L "$dir" ] && printf '%s\\n' "$dir"
done
`,
      "sh",
      configDir,
      ...allStateDirs,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { symlinkedRoots: [], error: msg };
  }
  return {
    symlinkedRoots: stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    error: null,
  };
}

function runStateDirLockScript(
  privileged: PrivilegedExec,
  script: StateDirLockScript,
): StateDirLockScriptResult {
  let stdout = "";
  try {
    stdout = privileged.capture(["sh", "-c", script.script, "sh", ...script.args]);
  } catch {
    return { symlinkedRoots: [], mutationFailures: [] };
  }
  const result: StateDirLockScriptResult = {
    symlinkedRoots: [],
    mutationFailures: [],
  };
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts[0] === "symlinked-root" && parts[1]) {
      result.symlinkedRoots.push(parts[1]);
    } else if (parts[0] === "mutation-failed" && parts[1] && parts[2]) {
      result.mutationFailures.push({ op: parts[1], path: parts[2] });
    }
  }
  return result;
}

// Restore runtime-writable subpaths after a successful lock fan-out. Returns
// null on success, an error message on failure so the caller can surface
// the failure rather than silently swallowing it.
function restoreWritableRuntimeSubpaths(
  privileged: PrivilegedExec,
  configDir: string,
): string | null {
  try {
    privileged.exec([
      "sh",
      "-c",
      `
set -u
config_dir="$1"
shift
for pattern in "$@"; do
  case "$pattern" in
    */*) prefix="\${pattern%/*}"; leaf="\${pattern##*/}" ;;
    *) prefix=""; leaf="$pattern" ;;
  esac
  if [ -n "$prefix" ]; then
    set -- "$config_dir"/$prefix
  else
    set -- "$config_dir"
  fi
  for parent in "$@"; do
    case "$parent" in
      *"*"*) continue ;;
    esac
    [ -L "$parent" ] && continue
    [ -d "$parent" ] || continue
    target="$parent/$leaf"
    [ -L "$target" ] && continue
    mkdir -p "$target" 2>/dev/null || continue
    chown -R sandbox:sandbox "$target" 2>/dev/null || true
    chmod 2770 "$target" 2>/dev/null || true
    chmod -R g+rwX,o-rwx "$target" 2>/dev/null || true
  done
done
`,
      "sh",
      configDir,
      ...WRITABLE_RUNTIME_SUBPATHS,
    ]);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}
