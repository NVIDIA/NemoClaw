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
const { run, runCapture, validateName, shellQuote } = require("./runner");
const { dockerExecFileSync } = require("./adapters/docker/exec");
const {
  buildPolicyGetCommand,
  buildPolicySetCommand,
  parseCurrentPolicy,
  PERMISSIVE_POLICY_PATH,
} = require("./policies");
const { parseDuration, MAX_SECONDS, DEFAULT_SECONDS } = require("./domain/duration");
const { appendAuditEntry } = require("./shields-audit");
const { resolveAgentConfig } = require("./sandbox-config");

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "state");

// ---------------------------------------------------------------------------
// kubectl exec — bypasses the sandbox's Landlock context
//
// openshell sandbox exec runs commands INSIDE the Landlock domain, so it
// can't modify read_only paths or change chattr flags. kubectl exec starts
// a new process in the pod that does NOT inherit the Landlock ruleset.
// We reach kubectl via the K3s container: docker exec <k3s> kubectl exec ...
// ---------------------------------------------------------------------------

const K3S_CONTAINER = "openshell-cluster-nemoclaw";

function kubectlExecArgv(sandboxName: string, cmd: string[]): string[] {
  return [
    "exec",
    K3S_CONTAINER,
    "kubectl",
    "exec",
    "-n",
    "openshell",
    sandboxName,
    "-c",
    "agent",
    "--",
    ...cmd,
  ];
}

function kubectlExec(sandboxName: string, cmd: string[]): void {
  dockerExecFileSync(kubectlExecArgv(sandboxName, cmd), {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

function kubectlExecCapture(sandboxName: string, cmd: string[]): string {
  return dockerExecFileSync(kubectlExecArgv(sandboxName, cmd), {
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

interface ShieldsState {
  shieldsDown?: boolean;
  shieldsDownAt?: string | null;
  shieldsDownTimeout?: number | null;
  shieldsDownReason?: string | null;
  shieldsDownPolicy?: string | null;
  shieldsPolicySnapshotPath?: string | null;
  updatedAt?: string;
}

/**
 * Derive the effective shields mode from persisted state.
 *
 * NC-2227-02: A fresh sandbox with no state file must report as
 * "mutable_default", NOT as "locked". Only report locked after
 * shields up has actually been run (shieldsDown === false AND
 * the state file exists with an updatedAt timestamp).
 */
function deriveShieldsMode(state: ShieldsState, hasStateFile: boolean): ShieldsMode {
  if (!hasStateFile) return "mutable_default";
  if (state.shieldsDown === true) return "temporarily_unlocked";
  if (state.shieldsDown === false) return "locked";
  // State file exists but shieldsDown is undefined — treat as mutable default
  return "mutable_default";
}

function loadShieldsState(sandboxName: string): ShieldsState & { _hasStateFile: boolean } {
  const filePath = stateFilePath(sandboxName);
  if (!fs.existsSync(filePath)) return { _hasStateFile: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const state: ShieldsState = isShieldsState(parsed) ? parsed : {};
    return { ...state, _hasStateFile: true };
  } catch {
    return { _hasStateFile: false };
  }
}

function saveShieldsState(sandboxName: string, patch: ShieldsState): ShieldsState {
  const current = loadShieldsState(sandboxName);
  // Strip the internal _hasStateFile flag before persisting — it is a
  // runtime-only marker and must not leak into the JSON state file.
  const { _hasStateFile: _, ...currentClean } = current;
  const updated: ShieldsState = { ...currentClean, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFilePath(sandboxName), JSON.stringify(updated, null, 2), { mode: 0o600 });
  return updated;
}

// ---------------------------------------------------------------------------
// Timer marker — tracks the detached auto-restore process
// ---------------------------------------------------------------------------

interface TimerMarker {
  pid: number;
  sandboxName: string;
  snapshotPath: string;
  restoreAt: string;
}

type UnknownRecord = { [key: string]: unknown };

function isObjectRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNullableNumber(value: unknown): value is number | null | undefined {
  return (
    value === undefined || value === null || (typeof value === "number" && Number.isFinite(value))
  );
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
    isOptionalString(value.updatedAt)
  );
}

function isTimerMarker(value: unknown): value is TimerMarker {
  return (
    isObjectRecord(value) &&
    typeof value.pid === "number" &&
    typeof value.sandboxName === "string" &&
    typeof value.snapshotPath === "string" &&
    typeof value.restoreAt === "string"
  );
}

function timerMarkerPath(sandboxName: string): string {
  return path.join(STATE_DIR, `shields-timer-${sandboxName}.json`);
}

function readTimerMarker(sandboxName: string): TimerMarker | null {
  const p = timerMarkerPath(sandboxName);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return isTimerMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function killTimer(sandboxName: string): void {
  const marker = readTimerMarker(sandboxName);
  if (!marker) return;
  try {
    process.kill(marker.pid, "SIGTERM");
  } catch {
    // Process already exited — fine
  }
  try {
    fs.unlinkSync(timerMarkerPath(sandboxName));
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// NC-2227-05: State directories locked by shields-up.
//
// During shields-up, these must be locked (root:root 755) so the sandbox
// user cannot create new entries or modify existing ones. This covers both
// executable state (skills, hooks, cron jobs, extensions, plugins, agent
// definitions) and writable agent state entry points such as workspace and
// memory, so a stale symlink bridge cannot bypass the lockdown.
//
// The list is a superset: directories that don't exist in a given agent's
// config dir are silently skipped.
// ---------------------------------------------------------------------------

const HIGH_RISK_STATE_DIRS = [
  "skills",
  "hooks",
  "cron",
  "agents",
  "extensions",
  "plugins", // Hermes equivalent of extensions
  "workspace",
  "memory",
  "credentials",
  "identity",
  "devices",
  "canvas",
  "telegram",
];

function applyStateDirLockMode(sandboxName: string, configDir: string, owner: string): void {
  // Locking (shields-up) strips group + world write. Unlocking (shields-down)
  // restores the same group-readable/writable + o-rwx mutable-default contract
  // as startup, plus setgid so the gateway UID — now in the sandbox group via
  // Dockerfile.base — can write to OpenClaw's mutable config tree (#2681).
  //
  // The unlock variant uses `g+rwX,o-rwx` because a prior lock can strip group
  // access from descendants. Without re-adding group read/write explicitly,
  // shields-down would leave nested files readable/writable only by owner.
  const isLocking = owner === "root:root";
  const recursiveMode = isLocking ? "go-w" : "g+rwX,o-rwx";
  const dirMode = isLocking ? "755" : "2770";

  for (const dirName of HIGH_RISK_STATE_DIRS) {
    const dirPath = `${configDir}/${dirName}`;
    try {
      kubectlExec(sandboxName, ["chown", "-R", owner, dirPath]);
    } catch {
      // Directory may not exist for this agent — silently skip
    }
    try {
      kubectlExec(sandboxName, ["chmod", dirMode, dirPath]);
    } catch {
      // Silently skip
    }
    if (isLocking) {
      try {
        kubectlExec(sandboxName, ["chmod", "g-s", dirPath]);
      } catch {
        // Best effort; do not skip recursive write stripping.
      }
    }
    try {
      kubectlExec(sandboxName, ["chmod", "-R", recursiveMode, dirPath]);
    } catch {
      // Silently skip
    }
  }

  // Multi-agent OpenClaw workspaces are named workspace-<agent>. They are
  // discovered dynamically because they are configured by openclaw.json.
  const clearSetgid = isLocking ? "1" : "0";
  try {
    kubectlExec(sandboxName, [
      "sh",
      "-c",
      `
set -u
config_dir="$1"
owner="$2"
recursive_mode="$3"
dir_mode="$4"
clear_setgid="$5"
for dir in "$config_dir"/workspace-*; do
  [ -d "$dir" ] || continue
  chown -R "$owner" "$dir" 2>/dev/null || true
  chmod "$dir_mode" "$dir" 2>/dev/null || true
  [ "$clear_setgid" = "1" ] && chmod g-s "$dir" 2>/dev/null || true
  chmod -R "$recursive_mode" "$dir" 2>/dev/null || true
done
`,
      "sh",
      configDir,
      owner,
      recursiveMode,
      dirMode,
      clearSetgid,
    ]);
  } catch {
    // Best effort; verification below catches the primary config lock.
  }
}

function legacyDataDirFor(configDir: string): string {
  return `${configDir}-data`;
}

function assertNoLegacyStateLayout(sandboxName: string, configDir: string): void {
  const dataDir = legacyDataDirFor(configDir);
  const script =
    'set -u; config_dir="$1"; data_dir="$2"; data_real="$(readlink -f "$data_dir" 2>/dev/null || printf "%s" "$data_dir")"; if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then echo "legacy data dir exists: $data_dir"; exit 1; fi; for entry in "$config_dir"/*; do [ -L "$entry" ] || continue; target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"; case "$target" in "$data_real"/*|"$data_dir"/*) echo "legacy symlink remains: $entry -> $target"; exit 1;; esac; done';
  try {
    kubectlExecCapture(sandboxName, ["sh", "-c", script, "sh", configDir, dataDir]);
  } catch (err) {
    const execErr = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const captured = [execErr.stdout, execErr.stderr]
      .map((value) => (value ? String(value).trim() : ""))
      .filter(Boolean)
      .join("\n");
    const message = captured || (err instanceof Error ? err.message : String(err));
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
  target: { agentName?: string; configPath: string; configDir: string; sensitiveFiles?: string[] },
): void {
  const errors: string[] = [];
  const filesToUnlock = [target.configPath, ...(target.sensitiveFiles || [])];
  // Mutable-default mode for OpenClaw: group-writable + setgid on the
  // config dir so the gateway UID (a member of the sandbox group via
  // Dockerfile.base) can write to OpenClaw config files. Without this,
  // control-UI mutations (Enable Dreaming, account toggles) EACCES
  // against sandbox:sandbox 600 even after shields-down
  // (#2681 supersedes #2693).
  // Hermes is unchanged — its sandbox does not run a separate gateway UID,
  // so the shared-group contract does not apply.
  const fileMode = target.agentName === "hermes" ? "640" : "660";
  const dirMode = target.agentName === "hermes" ? "750" : "2770";
  for (const f of filesToUnlock) {
    try {
      kubectlExec(sandboxName, ["chattr", "-i", f]);
    } catch {
      errors.push(`chattr -i ${f}`);
    }
    try {
      kubectlExec(sandboxName, ["chown", "sandbox:sandbox", f]);
    } catch {
      errors.push(`chown ${f}`);
    }
    try {
      kubectlExec(sandboxName, ["chmod", fileMode, f]);
    } catch {
      errors.push(`chmod ${fileMode} ${f}`);
    }
  }
  try {
    kubectlExec(sandboxName, ["chown", "sandbox:sandbox", target.configDir]);
  } catch {
    errors.push("chown config dir");
  }
  try {
    kubectlExec(sandboxName, ["chmod", dirMode, target.configDir]);
  } catch {
    errors.push(`chmod ${dirMode} config dir`);
  }

  // NC-2227-05: Restore sandbox ownership on locked state directories.
  // Use chown -R to restore the full tree (files within may have been
  // locked to root:root by a prior shields-up).
  applyStateDirLockMode(sandboxName, target.configDir, "sandbox:sandbox");

  if (errors.length > 0) {
    console.error(
      `  Warning: Some unlock operations failed: ${errors.join(", ")}. Config may remain read-only.`,
    );
  }

  const issues: string[] = [];
  for (const f of filesToUnlock) {
    try {
      const perms = kubectlExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", f]);
      const [mode, owner] = perms.split(" ");
      if (mode !== fileMode) issues.push(`${f} mode=${mode} (expected ${fileMode})`);
      if (owner !== "sandbox:sandbox") issues.push(`${f} owner=${owner} (expected sandbox:sandbox)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`${f} stat failed: ${msg}`);
    }
    try {
      const attrs = kubectlExecCapture(sandboxName, ["lsattr", "-d", f]);
      const [flags] = attrs.trim().split(/\s+/, 1);
      if (flags.includes("i")) issues.push(`${f} immutable bit still set`);
    } catch {
      // lsattr may not be available on all images — skip
    }
  }

  try {
    const dirPerms = kubectlExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", target.configDir]);
    const [mode, owner] = dirPerms.split(" ");
    if (mode !== dirMode) issues.push(`config dir mode=${mode} (expected ${dirMode})`);
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

function lockAgentConfig(
  sandboxName: string,
  target: { agentName?: string; configPath: string; configDir: string; sensitiveFiles?: string[] },
): void {
  const errors: string[] = [];
  const filesToLock = [target.configPath, ...(target.sensitiveFiles || [])];

  for (const f of filesToLock) {
    try {
      kubectlExec(sandboxName, ["chmod", "444", f]);
    } catch {
      errors.push(`chmod 444 ${f}`);
    }
    try {
      kubectlExec(sandboxName, ["chown", "root:root", f]);
    } catch {
      errors.push(`chown root:root ${f}`);
    }
  }

  try {
    kubectlExec(sandboxName, ["chmod", "755", target.configDir]);
  } catch {
    errors.push("chmod 755 config dir");
  }

  try {
    kubectlExec(sandboxName, ["chown", "root:root", target.configDir]);
  } catch {
    errors.push("chown root:root config dir");
  }

  // Best-effort: kubectl exec may lack CAP_LINUX_IMMUTABLE. Track the
  // result so verification doesn't require something that was never there.
  let chattrSucceeded = true;
  for (const f of filesToLock) {
    try {
      kubectlExec(sandboxName, ["chattr", "+i", f]);
    } catch {
      chattrSucceeded = false;
    }
  }

  // NC-2227-05: Lock state directories. Root-own the directory and set 755 so
  // the sandbox user can read/execute but cannot create new entries or modify
  // existing ones.
  applyStateDirLockMode(sandboxName, target.configDir, "root:root");

  // OpenClaw's mutable-default config root is setgid (#2681). Clear setgid
  // after descendant locking so shields-up verifies the root config dir as
  // plain 755, not 2755.
  try {
    kubectlExec(sandboxName, ["chmod", "g-s", target.configDir]);
  } catch {
    errors.push("chmod g-s config dir");
  }
  try {
    kubectlExec(sandboxName, ["chmod", "755", target.configDir]);
  } catch {
    errors.push("chmod 755 config dir");
  }

  if (errors.length > 0) {
    console.error(`  Some lock operations failed: ${errors.join(", ")}`);
  }

  // Verify the lock actually took effect.
  // Mode + ownership are mandatory (layers 1+2 depend on them).
  // Immutable bit is only verified if chattr succeeded above.
  const issues: string[] = [];
  for (const f of filesToLock) {
    try {
      const perms = kubectlExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", f]);
      const [mode, owner] = perms.split(" ");
      if (!/^4[0-4][0-4]$/.test(mode)) issues.push(`${f} mode=${mode} (expected 444)`);
      if (owner !== "root:root") issues.push(`${f} owner=${owner} (expected root:root)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`${f} stat failed: ${msg}`);
    }
  }

  try {
    const dirPerms = kubectlExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", target.configDir]);
    const [dirMode, dirOwner] = dirPerms.split(" ");
    if (dirMode !== "755") issues.push(`dir mode=${dirMode} (expected 755)`);
    if (dirOwner !== "root:root") issues.push(`dir owner=${dirOwner} (expected root:root)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(`dir stat failed: ${msg}`);
  }

  if (chattrSucceeded) {
    for (const f of filesToLock) {
      try {
        const attrs = kubectlExecCapture(sandboxName, ["lsattr", "-d", f]);
        // lsattr format: "----i---------e----- /path/to/file"
        // First whitespace-delimited token is the flags field.
        const [flags] = attrs.trim().split(/\s+/, 1);
        if (!flags.includes("i")) issues.push(`${f} immutable bit not set`);
      } catch {
        // lsattr may not be available on all images — skip
      }
    }
  }

  try {
    assertNoLegacyStateLayout(sandboxName, target.configDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(msg);
  }

  if (issues.length > 0) {
    throw new Error(`Config not locked: ${issues.join(", ")}`);
  }
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
}

function shieldsDown(sandboxName: string, opts: ShieldsDownOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  if (state.shieldsDown) {
    console.error(
      `  Config is already unlocked for ${sandboxName} (since ${state.shieldsDownAt}).`,
    );
    console.error("  Run `nemoclaw shields up` first, or use --extend (not yet implemented).");
    process.exit(1);
  }

  // Kill stale auto-restore markers only when this command will actually
  // transition into shields-down. A repeated shields-down must not cancel the
  // active timer and leave the sandbox unlocked indefinitely.
  killTimer(sandboxName);

  const timeoutSeconds = parseDuration(opts.timeout || `${DEFAULT_TIMEOUT_SECONDS}`);
  const reason = opts.reason || null;
  const policyName = opts.policy || "permissive";

  // 1. Capture current policy snapshot
  console.log("  Capturing current policy snapshot...");
  let rawPolicy: string;
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {
    rawPolicy = "";
  }

  const policyYaml = parseCurrentPolicy(rawPolicy);
  if (!policyYaml) {
    console.error("  Cannot capture current policy. Is the sandbox running?");
    process.exit(1);
  }

  const ts = Date.now();
  const snapshotPath = path.join(STATE_DIR, `policy-snapshot-${ts}.yaml`);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(snapshotPath, policyYaml, { mode: 0o600 });
  console.log(`  Saved: ${snapshotPath}`);

  // 2. Determine and apply relaxed policy
  let policyFile: string;
  if (policyName === "permissive") {
    policyFile = PERMISSIVE_POLICY_PATH;
  } else if (fs.existsSync(policyName)) {
    policyFile = path.resolve(policyName);
  } else {
    console.error(`  Unknown policy "${policyName}". Use "permissive" or a path to a YAML file.`);
    process.exit(1);
  }

  console.log(`  Applying ${policyName} policy...`);
  run(buildPolicySetCommand(policyFile, sandboxName));

  // 2b. Return config to default mutable state.
  //     OpenClaw uses sandbox:sandbox 0660/2770 here so the gateway UID, which
  //     is a member of the sandbox group, can mutate runtime config.
  const target = resolveAgentConfig(sandboxName);
  console.log(`  Unlocking ${target.agentName} config (${target.configPath})...`);
  try {
    unlockAgentConfig(sandboxName, target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ERROR: ${message}`);
    console.error("  Config did not reach the mutable-default state; refusing to save shields-down state.");
    console.error(`  Re-run \`nemoclaw ${sandboxName} shields down\` after correcting file ownership.`);
    process.exit(1);
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

  // 4. Start auto-restore timer (detached child process)
  //    Pass the absolute restore time, not a relative timeout. Steps 1-2b
  //    can take minutes (policy apply + kubectl chmod), so a relative timeout
  //    passed at fork time would fire too early.
  const restoreAt = new Date(Date.now() + timeoutSeconds * 1000);
  const timerScript = path.join(__dirname, "shields-timer.ts");
  const timerScriptJs = timerScript.replace(/\.ts$/, ".js");
  const actualScript = fs.existsSync(timerScriptJs) ? timerScriptJs : timerScript;

  try {
    const child = fork(
      actualScript,
      [sandboxName, snapshotPath, restoreAt.toISOString(), target.configPath, target.configDir],
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
      }),
      { mode: 0o600 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Cannot start auto-restore timer: ${message}`);
    console.error("  Rolling back — restoring policy from snapshot...");
    const rollbackResult = run(buildPolicySetCommand(snapshotPath, sandboxName), {
      ignoreError: true,
    });
    let rollbackLocked = false;
    if (rollbackResult.status === 0) {
      try {
        lockAgentConfig(sandboxName, target);
        rollbackLocked = true;
      } catch {
        console.error("  Warning: Rollback re-lock could not be verified. Check config manually.");
      }
    } else {
      console.error("  Warning: Policy restore failed during rollback.");
    }
    if (rollbackLocked) {
      saveShieldsState(sandboxName, {
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
      });
      console.error("  Lockdown restored. Config was never left unguarded.");
    } else {
      // Leave state as shieldsDown: true — don't lie about protection level
      console.error("  Config remains unlocked — manual intervention required.");
      console.error(
        `  Re-lock manually via kubectl exec, then run: nemoclaw ${sandboxName} shields up`,
      );
    }
    process.exit(1);
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
  const mins = Math.floor(timeoutSeconds / 60);
  const secs = timeoutSeconds % 60;
  console.log(
    `  Config unlocked for ${sandboxName} (auto-lockdown in: ${mins}m${secs ? ` ${secs}s` : ""})`,
  );
  console.log("");
  console.log("  Sandbox is in default (mutable) state.");
  console.log(`  Run \`nemoclaw ${sandboxName} shields up\` to opt into lockdown.`);
}

// ---------------------------------------------------------------------------
// shields up — opt into lockdown
//
// Locks config + applies restrictive network policy. This is an opt-in
// hardening step that restricts the sandbox beyond its default state.
// ---------------------------------------------------------------------------

function shieldsUp(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  // shieldsDown === false means explicitly locked by a previous shields-up.
  // undefined (no state file) means fresh sandbox — mutable default, allow shields-up.
  if (state.shieldsDown === false) {
    console.log("  Lockdown is already active.");
    return;
  }

  // 1. Kill auto-restore timer if running
  killTimer(sandboxName);

  // 2. If coming from shields-down, restore the saved policy snapshot.
  //    If first shields-up on a fresh sandbox (no prior shields-down),
  //    the current policy is already the restrictive baseline — skip restore.
  const snapshotPath = state.shieldsDown ? state.shieldsPolicySnapshotPath : undefined;
  if (state.shieldsDown && (!snapshotPath || !fs.existsSync(snapshotPath))) {
    console.error("  Cannot restore restrictive policy: saved snapshot is missing.");
    console.error("  Sandbox remains unlocked; recapture shields-down state before running shields up.");
    process.exit(1);
  }
  if (snapshotPath) {
    console.log("  Restoring restrictive policy from snapshot...");
    run(buildPolicySetCommand(snapshotPath, sandboxName));
  }

  // 2b. Lock config file to read-only.
  //     Uses kubectl exec to bypass Landlock (same as shields down).
  //     Each operation runs independently and the result is verified.
  //     If verification fails, config remains unlocked — we do not lie about state.
  const target = resolveAgentConfig(sandboxName);
  console.log(`  Locking ${target.agentName} config (${target.configPath})...`);
  try {
    lockAgentConfig(sandboxName, target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ERROR: ${message}`);
    console.error("  Config remains unlocked — manual intervention required.");
    console.error(
      `  Re-lock manually via kubectl exec, then run: nemoclaw ${sandboxName} shields up`,
    );
    process.exit(1);
  }

  // 3. Calculate duration
  const downAt = state.shieldsDownAt ? new Date(state.shieldsDownAt) : new Date();
  const now = new Date();
  const durationSeconds = Math.floor((now.getTime() - downAt.getTime()) / 1000);

  // 4. Update state
  saveShieldsState(sandboxName, {
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    // Keep snapshotPath for forensics — don't clear it
  });

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

function shieldsStatus(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  const mode = deriveShieldsMode(state, state._hasStateFile);

  switch (mode) {
    case "mutable_default":
      // NC-2227-02: Fresh sandbox with no shields history — do NOT claim locked
      console.log("  Shields: NOT CONFIGURED (default mutable state)");
      console.log("  Config is mutable. Run `nemoclaw <sandbox> shields up` to opt into lockdown.");
      return;

    case "locked":
      console.log("  Shields: UP (lockdown active)");
      console.log(
        `  Policy:  restrictive${state.shieldsPolicySnapshotPath ? " (snapshot preserved)" : ""}`,
      );
      if (state.shieldsDownAt) {
        console.log(`  Last unlocked: ${state.shieldsDownAt}`);
      }
      return;

    case "temporarily_unlocked": {
      const downSince = state.shieldsDownAt ? new Date(state.shieldsDownAt) : null;
      const elapsed = downSince ? Math.floor((Date.now() - downSince.getTime()) / 1000) : 0;
      const remaining =
        state.shieldsDownTimeout != null ? Math.max(0, state.shieldsDownTimeout - elapsed) : null;

      console.log("  Shields: DOWN (temporarily unlocked)");
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
 * Returns true if shields are currently down (temporarily unlocked).
 * NC-2227-02: Fresh sandboxes (no state file, mutable_default) return
 * true since the config IS mutable. Only returns false when shields
 * have been explicitly locked via `shields up`.
 */
function isShieldsDown(sandboxName: string): boolean {
  const state = loadShieldsState(sandboxName);
  const mode = deriveShieldsMode(state, state._hasStateFile);
  return mode !== "locked";
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  shieldsDown,
  shieldsUp,
  shieldsStatus,
  isShieldsDown,
  deriveShieldsMode,
  parseDuration,
  lockAgentConfig,
  unlockAgentConfig,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
};
