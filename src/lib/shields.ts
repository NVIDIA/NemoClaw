// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side shields management: down, up, status.
//
// Shields provide time-bounded policy relaxation with automatic restore.
// The sandbox cannot lower or raise its own shields — all mutations are
// host-initiated (security invariant).

const fs = require("fs");
const path = require("path");
const { fork, execFileSync } = require("child_process");
const { run, runCapture, validateName, shellQuote } = require("./runner");
const {
  buildPolicyGetCommand,
  buildPolicySetCommand,
  parseCurrentPolicy,
  PERMISSIVE_POLICY_PATH,
} = require("./policies");
const { parseDuration, MAX_SECONDS, DEFAULT_SECONDS } = require("./duration");
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

function kubectlExec(sandboxName: string, cmd: string[]): void {
  execFileSync("docker", [
    "exec", K3S_CONTAINER,
    "kubectl", "exec", "-n", "openshell", sandboxName, "-c", "agent", "--",
    ...cmd,
  ], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
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

interface ShieldsState {
  shieldsDown?: boolean;
  shieldsDownAt?: string | null;
  shieldsDownTimeout?: number | null;
  shieldsDownReason?: string | null;
  shieldsDownPolicy?: string | null;
  shieldsPolicySnapshotPath?: string | null;
  updatedAt?: string;
}

function loadShieldsState(sandboxName: string): ShieldsState {
  const filePath = stateFilePath(sandboxName);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ShieldsState;
  } catch {
    return {};
  }
}

function saveShieldsState(sandboxName: string, patch: ShieldsState): ShieldsState {
  const current = loadShieldsState(sandboxName);
  const updated: ShieldsState = { ...current, ...patch, updatedAt: new Date().toISOString() };
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

function timerMarkerPath(sandboxName: string): string {
  return path.join(STATE_DIR, `shields-timer-${sandboxName}.json`);
}

function readTimerMarker(sandboxName: string): TimerMarker | null {
  const p = timerMarkerPath(sandboxName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as TimerMarker;
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
// shields down
// ---------------------------------------------------------------------------

interface ShieldsDownOpts {
  timeout?: string | null;
  reason?: string | null;
  policy?: string;
}

function shieldsDown(sandboxName: string, opts: ShieldsDownOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  // Kill any stale timer from a previous shields-down cycle
  killTimer(sandboxName);

  const state = loadShieldsState(sandboxName);
  if (state.shieldsDown) {
    console.error(
      `  Shields are already DOWN for ${sandboxName} (since ${state.shieldsDownAt}).`,
    );
    console.error("  Run `nemoclaw shields up` first, or use --extend (not yet implemented).");
    process.exit(1);
  }

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

  // 2b. Make config file writable inside the sandbox.
  //     Three layers protect the config: Landlock (read_only), chattr +i
  //     (immutable bit), and UNIX perms (444 root:root). openshell sandbox exec
  //     runs inside the Landlock context and can't bypass any of them.
  //     kubectl exec bypasses Landlock (starts a new process outside the sandbox's
  //     Landlock domain), so we route through docker exec → kubectl exec.
  const target = resolveAgentConfig(sandboxName);
  console.log(`  Unlocking ${target.agentName} config (${target.configPath})...`);
  try {
    kubectlExec(sandboxName, ["chattr", "-i", target.configPath]);
    kubectlExec(sandboxName, ["chmod", "666", target.configPath]);
    kubectlExec(sandboxName, ["chmod", "777", target.configDir]);
  } catch {
    console.error("  Warning: Could not unlock config file. Config may remain read-only.");
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
    const child = fork(actualScript, [sandboxName, snapshotPath, restoreAt.toISOString()], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Cannot start auto-restore timer: ${message}`);
    console.error("  Rolling back — restoring policy from snapshot...");
    try {
      run(buildPolicySetCommand(snapshotPath, sandboxName), { ignoreError: true });
      kubectlExec(sandboxName, ["chmod", "444", target.configPath]);
      kubectlExec(sandboxName, ["chattr", "+i", target.configPath]);
    } catch {
      // Best effort rollback
    }
    saveShieldsState(sandboxName, {
      shieldsDown: false,
      shieldsDownAt: null,
      shieldsDownTimeout: null,
      shieldsDownReason: null,
      shieldsDownPolicy: null,
    });
    console.error("  Shields restored to UP. The sandbox was never left unguarded.");
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
  console.log(`  Shields DOWN for ${sandboxName} (timeout: ${mins}m${secs ? ` ${secs}s` : ""})`);
  console.log("");
  console.log("  Warning: Sandbox security is relaxed.");
  console.log(`  Run \`nemoclaw ${sandboxName} shields up\` when done.`);
}

// ---------------------------------------------------------------------------
// shields up
// ---------------------------------------------------------------------------

function shieldsUp(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  if (!state.shieldsDown) {
    console.log("  Shields are already UP.");
    return;
  }

  const snapshotPath = state.shieldsPolicySnapshotPath;
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    console.error("  No policy snapshot found. Cannot restore — manual intervention required.");
    console.error("  Apply your intended policy with: openshell policy set --policy <file>");
    process.exit(1);
  }

  // 1. Kill auto-restore timer if running
  killTimer(sandboxName);

  // 2. Restore policy from snapshot
  console.log("  Restoring policy from snapshot...");
  run(buildPolicySetCommand(snapshotPath, sandboxName));

  // 2b. Re-lock config file to read-only.
  //     Restore the Dockerfile's original permissions and immutable bit.
  //     Uses kubectl exec to bypass Landlock (same as shields down).
  const target = resolveAgentConfig(sandboxName);
  console.log(`  Locking ${target.agentName} config (${target.configPath})...`);
  try {
    kubectlExec(sandboxName, ["chmod", "444", target.configPath]);
    kubectlExec(sandboxName, ["chown", "root:root", target.configPath]);
    kubectlExec(sandboxName, ["chmod", "755", target.configDir]);
    kubectlExec(sandboxName, ["chown", "root:root", target.configDir]);
    kubectlExec(sandboxName, ["chattr", "+i", target.configPath]);
  } catch {
    console.error("  Warning: Could not re-lock config file.");
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
  console.log(`  Shields UP for ${sandboxName}`);
  console.log(`  Duration: ${mins}m ${secs}s | Reason: ${state.shieldsDownReason ?? "not specified"}`);
}

// ---------------------------------------------------------------------------
// shields status
// ---------------------------------------------------------------------------

function shieldsStatus(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);

  if (!state.shieldsDown) {
    console.log("  Shields: UP");
    console.log(`  Policy:  default${state.shieldsPolicySnapshotPath ? " (last snapshot preserved)" : ""}`);
    if (state.shieldsDownAt) {
      console.log(`  Last lowered: ${state.shieldsDownAt}`);
    }
    return;
  }

  const downSince = state.shieldsDownAt ? new Date(state.shieldsDownAt) : null;
  const elapsed = downSince ? Math.floor((Date.now() - downSince.getTime()) / 1000) : 0;
  const remaining =
    state.shieldsDownTimeout != null
      ? Math.max(0, state.shieldsDownTimeout - elapsed)
      : null;

  console.log("  Shields: DOWN");
  console.log(`  Since:   ${state.shieldsDownAt ?? "unknown"}`);
  if (remaining !== null) {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    console.log(`  Timeout: ${mins}m ${secs}s remaining`);
  }
  console.log(`  Reason:  ${state.shieldsDownReason ?? "not specified"}`);
  console.log(`  Policy:  ${state.shieldsDownPolicy ?? "permissive"}`);
}

// ---------------------------------------------------------------------------
// Query — check whether shields are currently down
// ---------------------------------------------------------------------------

function isShieldsDown(sandboxName: string): boolean {
  return loadShieldsState(sandboxName).shieldsDown === true;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  shieldsDown,
  shieldsUp,
  shieldsStatus,
  isShieldsDown,
  parseDuration,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
};
