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
//
// This module intentionally remains the host-side transaction coordinator for
// policy snapshots, config posture, timer authority, state commits, rollback,
// and audit ordering. Leaf authority and validation live in the focused lock,
// timer, seal, and config-guard modules imported below; splitting the coordinator
// before one typed transaction can own the complete cross-resource rollback
// would duplicate or weaken the reviewed ordering. New leaf mechanisms belong
// in those modules, and a later decomposition must preserve the transition and
// timer-bound lock tests before this facade can shrink safely.

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { randomBytes } = require("crypto");
const { run, runCapture, validateName } = require("../runner");
const { CLI_NAME }: typeof import("../cli/branding") = require("../cli/branding");
const {
  dockerExecFileSync,
  dockerSpawnSync,
}: typeof import("../adapters/docker/exec") = require("../adapters/docker/exec");
const {
  isDirectSandboxFallbackUnavailableError,
  privilegedSandboxExecArgv,
}: typeof import("../sandbox/privileged-exec") = require("../sandbox/privileged-exec");
const {
  buildPolicyGetCommand,
  buildPolicySetCommand,
  parseCurrentPolicy,
  resolvePermissivePolicyPath,
} = require("../policy");
const { parseDuration, MAX_SECONDS, DEFAULT_SECONDS } = require("../domain/duration");
const {
  timerMarkerPath,
  readTimerMarker,
  clearTimerMarker,
  isProcessAlive,
  readProcessStartIdentity,
  listDescendantProcessIdentities,
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
const { verifyShieldsLockState }: typeof import("./verify-lock") = require("./verify-lock");
const { relockAndReconfirm }: typeof import("./relock-reconfirm") = require("./relock-reconfirm");
const {
  inspectShieldsTransitionLockOwner,
  takeoverShieldsTransitionLock,
  withShieldsTransitionLock,
}: typeof import("./transition-lock") = require("./transition-lock");
const {
  withTimerBoundShieldsMutationLock,
}: typeof import("./timer-bound-lock") = require("./timer-bound-lock");
const {
  parseSha256Output,
  isHashVerificationIssue,
  isSha256Hex,
}: typeof import("./seal") = require("./seal");
const {
  applyStateDirLockMode,
  preflightStateDirLock,
  restoreStateDirLockPosture,
}: typeof import("./state-dir-lock") = require("./state-dir-lock");
const {
  OPENCLAW_CONFIG_DIR,
  OPENCLAW_CONFIG_HASH_PATH,
  OPENCLAW_CONFIG_PATH,
  runOpenClawConfigGuard,
}: typeof import("./openclaw-config-lock") = require("./openclaw-config-lock");
const {
  inspectMutableConfigPerms: inspectMutableConfigPermsCore,
  repairMutableConfigPerms: repairMutableConfigPermsCore,
}: typeof import("./mutable-config-perms") = require("./mutable-config-perms");
const {
  normalizeMutableOpenClawConfig,
}: typeof import("./mutable-config-repair") = require("./mutable-config-repair");
type MutableConfigPermsInspection = import("./mutable-config-perms").MutableConfigPermsInspection;
type MutableConfigRepairResult = import("./mutable-config-perms").MutableConfigRepairResult;
type ProcessIdentity = import("./timer-control").ProcessIdentity;

const STATE_DIR = resolveNemoclawStateDir();
const SHIELDS_TRANSITION_POLL_MS = 50;
const SHIELDS_TRANSITION_HANDOFF_GRACE_MS = 500;
const SHIELDS_TRANSITION_TERMINATE_GRACE_MS = 1000;
const AUTO_RESTORE_COMPLETION_GRACE_MS = 30_000;
const HERMES_RUNTIME_CONFIG_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const HERMES_RESTART_SEAL_STATE = "/run/nemoclaw/hermes-restart-seal.json";
const HERMES_CONFIG_HASH = "/etc/nemoclaw/hermes.config-hash";
const STATE_DIR_GUARD_TIMEOUT_MS = 15 * 60 * 1000;
const OPENCLAW_CONFIG_GUARD_TIMEOUT_MS = 6 * 60 * 1000;
const HERMES_CONFIG_GUARD_TIMEOUT_MS = 11 * 60 * 1000;

type ShieldsDownTransition = {
  version: 1;
  phase: "preparing" | "active";
  ownerPid: number;
  ownerStartIdentity: string;
  processToken: string;
  sandboxName: string;
  snapshotPath: string;
};

const transitionPollBuffer = new Int32Array(new SharedArrayBuffer(4));

function shieldsDownTransitionPath(sandboxName: string, processToken: string): string {
  return path.join(STATE_DIR, `shields-transition-${sandboxName}-${processToken}.json`);
}

function isShieldsDownTransition(value: unknown): value is ShieldsDownTransition {
  if (!isObjectRecord(value)) return false;
  return (
    value.version === 1 &&
    (value.phase === "preparing" || value.phase === "active") &&
    typeof value.ownerPid === "number" &&
    Number.isInteger(value.ownerPid) &&
    value.ownerPid > 0 &&
    typeof value.ownerStartIdentity === "string" &&
    value.ownerStartIdentity.length > 0 &&
    typeof value.processToken === "string" &&
    /^[0-9a-f]{32}$/.test(value.processToken) &&
    typeof value.sandboxName === "string" &&
    typeof value.snapshotPath === "string"
  );
}

function readShieldsDownTransition(
  sandboxName: string,
  processToken: string,
): ShieldsDownTransition | null {
  const transitionPath = shieldsDownTransitionPath(sandboxName, processToken);
  try {
    const value = JSON.parse(fs.readFileSync(transitionPath, "utf-8"));
    if (!isShieldsDownTransition(value)) return null;
    if (value.sandboxName !== sandboxName || value.processToken !== processToken) return null;
    return value;
  } catch {
    return null;
  }
}

function writeShieldsDownTransition(
  transition: ShieldsDownTransition,
  expectedPhase: ShieldsDownTransition["phase"] | null,
): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const transitionPath = shieldsDownTransitionPath(transition.sandboxName, transition.processToken);
  if (expectedPhase !== null) {
    const current = readShieldsDownTransition(transition.sandboxName, transition.processToken);
    if (
      !current ||
      current.phase !== expectedPhase ||
      current.ownerPid !== transition.ownerPid ||
      current.snapshotPath !== transition.snapshotPath
    ) {
      throw new Error("Shields-down recovery ownership changed during the transition");
    }
  }

  const tempPath = `${transitionPath}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(transition), { flag: "wx", mode: 0o600 });
    fs.renameSync(tempPath, transitionPath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort. The authoritative path was either atomically replaced or unchanged.
    }
  }
}

function clearShieldsDownTransition(sandboxName: string, processToken: string): void {
  try {
    fs.rmSync(shieldsDownTransitionPath(sandboxName, processToken), { force: true });
  } catch {
    // Best effort. A stale transition marker never grants mutation authority.
  }
}

function waitForShieldsDownForwardCommit(
  sandboxName: string,
  processToken: string,
): ShieldsDownTransition | null {
  let observed = readShieldsDownTransition(sandboxName, processToken);
  if (!observed) return null;

  const ownerIsCurrent = () =>
    isProcessAlive(observed!.ownerPid) &&
    readProcessStartIdentity(observed!.ownerPid) === observed!.ownerStartIdentity;
  const handoffDeadline = Date.now() + SHIELDS_TRANSITION_HANDOFF_GRACE_MS;
  while (observed.phase === "preparing" && ownerIsCurrent() && Date.now() < handoffDeadline) {
    Atomics.wait(transitionPollBuffer, 0, 0, SHIELDS_TRANSITION_POLL_MS);
    const next = readShieldsDownTransition(sandboxName, processToken);
    if (!next) return null;
    if (
      next.ownerPid !== observed.ownerPid ||
      next.ownerStartIdentity !== observed.ownerStartIdentity ||
      next.snapshotPath !== observed.snapshotPath ||
      next.processToken !== observed.processToken
    ) {
      throw new Error("Shields-down recovery ownership changed while waiting for forward commit");
    }
    observed = next;
  }

  if (observed.phase === "preparing" && ownerIsCurrent()) {
    // The absolute shields-down deadline has expired while the forward owner
    // is still able to weaken policy/config. Preempt that exact process
    // instance, then restore from the captured snapshot. Waiting forever would
    // turn the requested timeout into an unbounded mutable window.
    stopTimedOutShieldsDownTree(observed.ownerPid, observed.ownerStartIdentity);
  }
  return observed;
}

function excludeRecoveryProcessTree(
  descendants: ProcessIdentity[],
  recoveryPid: number,
  recoveryDescendants: ProcessIdentity[],
): ProcessIdentity[] {
  const excludedPids = new Set<number>([recoveryPid, ...recoveryDescendants.map(({ pid }) => pid)]);
  return descendants.filter(({ pid }) => !excludedPids.has(pid));
}

function stopTimedOutShieldsDownTree(ownerPid: number, ownerStartIdentity: string): void {
  const identityIsCurrent = (pid: number, startIdentity: string) =>
    isProcessAlive(pid) && readProcessStartIdentity(pid) === startIdentity;
  const signalExact = (pid: number, startIdentity: string, signal: NodeJS.Signals): void => {
    if (!identityIsCurrent(pid, startIdentity)) return;
    try {
      process.kill(pid, signal);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ESRCH") throw error;
    }
  };
  if (!identityIsCurrent(ownerPid, ownerStartIdentity)) return;

  const recoveryTree = listDescendantProcessIdentities(process.pid);
  if (recoveryTree === null) {
    throw new Error("Cannot identify the auto-restore recovery process tree safely");
  }
  // Stop the exact owner before enumerating its descendants so it cannot launch
  // another weakening subprocess while takeover is being established.
  signalExact(ownerPid, ownerStartIdentity, "SIGSTOP");
  const tracked = new Map<number, { startIdentity: string; depth: number }>();
  for (let pass = 0; pass < 8; pass += 1) {
    const descendants = listDescendantProcessIdentities(ownerPid);
    if (descendants === null) {
      throw new Error("Cannot enumerate timed-out shields-down subprocesses safely");
    }
    let added = false;
    const recoveryIsInsideOwnerTree = descendants.some(
      ({ pid }: { pid: number }) => pid === process.pid,
    );
    for (const descendant of excludeRecoveryProcessTree(
      descendants,
      process.pid,
      recoveryIsInsideOwnerTree ? recoveryTree : [],
    )) {
      if (!tracked.has(descendant.pid)) added = true;
      tracked.set(descendant.pid, {
        startIdentity: descendant.startIdentity,
        depth: descendant.depth,
      });
      signalExact(descendant.pid, descendant.startIdentity, "SIGSTOP");
    }
    if (!added) break;
    Atomics.wait(transitionPollBuffer, 0, 0, SHIELDS_TRANSITION_POLL_MS);
  }

  const deepestFirst = [...tracked.entries()].sort((a, b) => b[1].depth - a[1].depth);
  for (const [pid, identity] of deepestFirst) {
    signalExact(pid, identity.startIdentity, "SIGKILL");
  }
  signalExact(ownerPid, ownerStartIdentity, "SIGKILL");

  const killDeadline = Date.now() + SHIELDS_TRANSITION_TERMINATE_GRACE_MS;
  while (Date.now() < killDeadline) {
    const survivor = deepestFirst.some(([pid, identity]) =>
      identityIsCurrent(pid, identity.startIdentity),
    );
    if (!survivor && !identityIsCurrent(ownerPid, ownerStartIdentity)) return;
    Atomics.wait(transitionPollBuffer, 0, 0, SHIELDS_TRANSITION_POLL_MS);
  }
  throw new Error("Timed-out shields-down process tree could not be stopped safely");
}

// ---------------------------------------------------------------------------
// privileged sandbox exec — bypasses the sandbox's Landlock context
//
// openshell sandbox exec runs commands INSIDE the Landlock domain, so it
// can't modify read_only paths or change chattr flags. We delegate the
// argv shape to the central registry-scoped helper in
// src/lib/sandbox/privileged-exec.ts, which fails closed when no matching
// sandbox container is running.
// ---------------------------------------------------------------------------

/**
 * Print recovery guidance when shields cannot restore lockdown.
 *
 * Keep this driver-neutral because docker and VM sandboxes have no Kubernetes
 * control plane. Rebuild remains an escalation after the sandbox-ready retry
 * rather than an equivalent first step. (#6126)
 *
 * Recovery is: confirm readiness and retry `<cli> <sandbox> shields up`; only
 * then escalate to `<cli> <sandbox> rebuild --yes` if the retry still fails.
 */
function printManualRelockRecoveryHint(sandboxName: string): void {
  console.error(
    `  Recovery: confirm the sandbox is running and ready, then retry \`${CLI_NAME} ${sandboxName} shields up\`.`,
  );
  console.error(
    `  If the retry still fails, rebuild a known-good baseline with \`${CLI_NAME} ${sandboxName} rebuild --yes\`.`,
  );
}

// The guard also uses startup-not-ready for structural PID 1 incompatibility.
// Match the complete transient diagnostic so a different detail or an
// additional issue cannot downgrade an unsafe rollback from CRITICAL.
const OPENCLAW_STARTUP_NOT_READY_DIAGNOSTIC =
  /^(?:top-level config rollback failed: )?Config not locked: OpenClaw config guard lock \[startup-not-ready\] \/run\/nemoclaw\/openclaw-config-ready\.json: OpenClaw startup is not ready for host config mutations$/;

function isOpenClawReadinessFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return (
    isDirectSandboxFallbackUnavailableError(value) ||
    OPENCLAW_STARTUP_NOT_READY_DIAGNOSTIC.test(message)
  );
}

type OpenClawRollbackIssue = {
  message: string;
  readinessFailure: boolean;
};

function openClawRollbackIssue(prefix: string, error: unknown): OpenClawRollbackIssue {
  return {
    message: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    readinessFailure: isOpenClawReadinessFailure(error),
  };
}

function privilegedSandboxExec(sandboxName: string, cmd: string[], timeout = 15000): void {
  dockerExecFileSync(privilegedSandboxExecArgv(sandboxName, cmd, false, true), {
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}

function privilegedSandboxExecCapture(sandboxName: string, cmd: string[], timeout = 15000): string {
  return dockerExecFileSync(privilegedSandboxExecArgv(sandboxName, cmd, false, true), {
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  }).trim();
}

function hermesShieldsGuardArgs(
  action: string,
  target: AgentConfigTarget,
  extra: string[] = [],
  timeout = "10m",
): string[] {
  return [
    "timeout",
    "--signal=TERM",
    "--kill-after=5s",
    timeout,
    HERMES_PYTHON,
    "-I",
    HERMES_RUNTIME_CONFIG_GUARD,
    action,
    "--hermes-dir",
    target.configDir,
    "--state-file",
    HERMES_RESTART_SEAL_STATE,
    ...extra,
  ];
}

type HermesShieldsProtocol = "sealed" | "legacy";

const HERMES_SEALED_SHIELDS_CONTRACT = [
  "begin-shields-transition",
  "run-state-dir-transition",
  "apply-shields-transition",
  "finish-shields-transition",
  "prepare-shields-abort",
  "abort-shields-transition",
  "--rollback-shields-mode",
] as const;
const HERMES_LEGACY_GUARD_CONTRACT = [
  "ensure-api-key",
  "refresh-hashes",
  "provider-placeholders",
] as const;

function inspectHermesShieldsProtocol(
  sandboxName: string,
  target: AgentConfigTarget,
): HermesShieldsProtocol {
  if (target.agentName !== "hermes") return "sealed";
  const help = privilegedSandboxExecCapture(
    sandboxName,
    [
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "10m",
      HERMES_PYTHON,
      "-I",
      HERMES_RUNTIME_CONFIG_GUARD,
      "--help",
    ],
    HERMES_CONFIG_GUARD_TIMEOUT_MS,
  );
  if (HERMES_SEALED_SHIELDS_CONTRACT.every((entry) => help.includes(entry))) {
    return "sealed";
  }
  if (HERMES_LEGACY_GUARD_CONTRACT.every((entry) => help.includes(entry))) {
    return "legacy";
  }
  throw new Error(
    "Hermes runtime guard exposes an incomplete shields transition contract; rebuild the sandbox",
  );
}

function requireHermesShieldsProtocol(
  sandboxName: string,
  target: AgentConfigTarget,
  allowLegacyHermesProtocol: boolean,
): HermesShieldsProtocol {
  const protocol = inspectHermesShieldsProtocol(sandboxName, target);
  if (protocol === "legacy" && !allowLegacyHermesProtocol) {
    throw new Error(
      "This Hermes sandbox image predates sealed shields transitions; rebuild the sandbox before changing shields",
    );
  }
  return protocol;
}

function resolveHermesShieldsProtocol(
  sandboxName: string,
  target: AgentConfigTarget,
  allowLegacyHermesProtocol: boolean,
  cachedProtocol?: HermesShieldsProtocol,
): HermesShieldsProtocol {
  const protocol =
    cachedProtocol ?? requireHermesShieldsProtocol(sandboxName, target, allowLegacyHermesProtocol);
  if (target.agentName === "hermes" && protocol === "legacy" && !allowLegacyHermesProtocol) {
    throw new Error(
      "This Hermes sandbox image predates sealed shields transitions; rebuild the sandbox before changing shields",
    );
  }
  return protocol;
}

function supportsHermesSealedShieldsTransactions(sandboxName: string): boolean {
  validateName(sandboxName, "sandbox name");
  const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
  return inspectHermesShieldsProtocol(sandboxName, target) === "sealed";
}

function beginHermesConfigShields(
  sandboxName: string,
  target: AgentConfigTarget,
  mode: "locked" | "mutable",
  rollbackMode: "locked" | "mutable",
): { token: string; originalLocked: boolean; rollbackLocked: boolean } {
  const output = privilegedSandboxExecCapture(
    sandboxName,
    hermesShieldsGuardArgs("begin-shields-transition", target, [
      "--hash-file",
      HERMES_CONFIG_HASH,
      "--shields-mode",
      mode,
      "--rollback-shields-mode",
      rollbackMode,
    ]),
    HERMES_CONFIG_GUARD_TIMEOUT_MS,
  );
  const match = /^lock_token=([0-9a-f]{64}) original_locked=([01])$/.exec(output);
  if (!match) {
    // A successful guard invocation has already created the root-owned seal.
    // If a future output-contract drift still exposes the token, release that
    // transaction before surfacing the parser error instead of leaking a live
    // mutation lock merely because the host/client versions disagree.
    const recoverableToken = /(?:^|\s)lock_token=([0-9a-f]{64})(?:\s|$)/.exec(output)?.[1];
    if (recoverableToken) {
      try {
        prepareHermesConfigShieldsAbort(sandboxName, target, recoverableToken);
        abortHermesConfigShields(sandboxName, target, recoverableToken);
      } catch (abortError) {
        const message = abortError instanceof Error ? abortError.message : String(abortError);
        throw new Error(
          `Unexpected Hermes shields transaction response: ${output}; rollback failed: ${message}`,
        );
      }
    }
    throw new Error(`Unexpected Hermes shields transaction response: ${output}`);
  }
  return {
    token: match[1],
    originalLocked: match[2] === "1",
    rollbackLocked: rollbackMode === "locked",
  };
}

function applyHermesConfigShields(
  sandboxName: string,
  target: AgentConfigTarget,
  token: string,
): boolean {
  const output = privilegedSandboxExecCapture(
    sandboxName,
    hermesShieldsGuardArgs("apply-shields-transition", target, ["--lock-token", token]),
    HERMES_CONFIG_GUARD_TIMEOUT_MS,
  );
  const match = /^shields_mode=(?:locked|mutable) chattr_applied=([01])$/.exec(output);
  if (!match) throw new Error(`Unexpected Hermes shields apply response: ${output}`);
  return match[1] === "1";
}

function finishHermesConfigShields(
  sandboxName: string,
  target: AgentConfigTarget,
  token: string,
): void {
  privilegedSandboxExec(
    sandboxName,
    hermesShieldsGuardArgs("finish-shields-transition", target, [
      "--hash-file",
      HERMES_CONFIG_HASH,
      "--lock-token",
      token,
    ]),
    HERMES_CONFIG_GUARD_TIMEOUT_MS,
  );
}

function abortHermesConfigShields(
  sandboxName: string,
  target: AgentConfigTarget,
  token: string,
): void {
  privilegedSandboxExec(
    sandboxName,
    hermesShieldsGuardArgs("abort-shields-transition", target, ["--lock-token", token]),
    HERMES_CONFIG_GUARD_TIMEOUT_MS,
  );
}

function prepareHermesConfigShieldsAbort(
  sandboxName: string,
  target: AgentConfigTarget,
  token: string,
): void {
  privilegedSandboxExec(
    sandboxName,
    hermesShieldsGuardArgs("prepare-shields-abort", target, ["--lock-token", token]),
    HERMES_CONFIG_GUARD_TIMEOUT_MS,
  );
}

function runHermesStateDirTransition(
  sandboxName: string,
  target: AgentConfigTarget,
  token: string,
  action: "lock" | "unlock",
): void {
  privilegedSandboxExec(
    sandboxName,
    hermesShieldsGuardArgs(
      "run-state-dir-transition",
      target,
      ["--state-action", action, "--lock-token", token],
      "13m",
    ),
    STATE_DIR_GUARD_TIMEOUT_MS,
  );
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

function configHashPath(configDir: string): string {
  return `${configDir.replace(/\/+$/, "")}/.config-hash`;
}

function ensureConfigHashSensitiveFile<T extends AgentConfigTarget>(target: T): T {
  const hashPath = configHashPath(target.configDir);
  const sensitiveFiles = target.sensitiveFiles || [];
  if (sensitiveFiles.includes(hashPath)) return target;
  return { ...target, sensitiveFiles: [...sensitiveFiles, hashPath] } as T;
}

class DeferredShieldsExit extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "DeferredShieldsExit";
    this.exitCode = exitCode;
  }
}

function failShieldsCommand(message: string, _shouldThrow?: boolean): never {
  // Never terminate while a transition-lock callback is active: process.exit
  // skips finally blocks and would strand the canonical lock. Public command
  // wrappers translate this sentinel only after the lock has been released.
  throw new DeferredShieldsExit(message, 1);
}

function completeDeferredShieldsExit(error: unknown, shouldThrow = false): never {
  if (error instanceof DeferredShieldsExit && !shouldThrow) {
    process.exit(error.exitCode);
  }
  throw error;
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

function getShieldsPostureWithoutHostLock(
  sandboxName: string,
  allowInlineRecovery = false,
): ShieldsPosture {
  const state = recoverExpiredAutoRestoreGate(sandboxName, allowInlineRecovery);
  const mode = state._isCorrupt ? "error" : deriveShieldsMode(state, state._hasStateFile);
  return { ...describeShieldsMode(mode), state };
}

function prepareExpiredAutoRestoreHostLockTakeover(sandboxName: string): void {
  const state = loadShieldsState(sandboxName);
  if (state._isCorrupt || state.shieldsDown !== true) return;
  const marker = readTimerMarker(sandboxName);
  if (!marker?.processToken || !/^[0-9a-f]{32}$/.test(marker.processToken)) return;
  const restoreAtMs = new Date(marker.restoreAt).getTime();
  const now = Date.now();
  if (!Number.isFinite(restoreAtMs) || restoreAtMs > now) return;
  if (
    isProcessAlive(marker.pid) &&
    verifyTimerMarkerIdentity(marker).verified &&
    now <= restoreAtMs + AUTO_RESTORE_COMPLETION_GRACE_MS
  ) {
    return;
  }
  prepareAutoRestoreTransitionTakeover(sandboxName, marker.processToken, marker.snapshotPath);
}

function getShieldsPosture(sandboxName: string, allowInlineRecovery = false): ShieldsPosture {
  if (!allowInlineRecovery) return getShieldsPostureWithoutHostLock(sandboxName, false);
  validateName(sandboxName, "sandbox name");
  prepareExpiredAutoRestoreHostLockTakeover(sandboxName);
  return withTimerBoundShieldsMutationLock(sandboxName, "recover expired shields posture", () =>
    getShieldsPostureWithoutHostLock(sandboxName, true),
  );
}

function saveShieldsState(sandboxName: string, patch: ShieldsState): ShieldsState {
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
  fs.writeFileSync(stateFilePath(sandboxName), JSON.stringify(updated, null, 2), { mode: 0o600 });
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

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNullableNumber(value: unknown): value is number | null | undefined {
  return (
    value === undefined || value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

// SHA-256 hex strings are 64 lowercase or uppercase hex chars. The seal
// helper normalises to lowercase before persisting; accept either case
// here so manually edited state files and legacy uppercase entries still
// load, and reject anything that cannot be a real digest. Uses the same
// `isSha256Hex` predicate as the verifier so the persisted-state and
// runtime contracts stay aligned.
function isOptionalHashMap(value: unknown): value is { [path: string]: string } | undefined {
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
    run: (cmd: string[], input?: string) => {
      const result = dockerSpawnSync(
        privilegedSandboxExecArgv(sandboxName, cmd, input !== undefined, true),
        {
          encoding: "utf-8",
          input,
          timeout: STATE_DIR_GUARD_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return {
        status: result.status,
        signal: result.signal,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        ...(result.error ? { error: result.error.message } : {}),
      };
    },
  };
}

function openClawConfigGuardExec(sandboxName: string) {
  return {
    run: (cmd: string[], input?: string) => {
      const result = dockerSpawnSync(
        privilegedSandboxExecArgv(sandboxName, cmd, input !== undefined, true),
        {
          encoding: "utf-8",
          input,
          timeout: OPENCLAW_CONFIG_GUARD_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      return {
        status: result.status,
        signal: result.signal,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        ...(result.error ? { error: result.error.message } : {}),
      };
    },
  };
}

function assertCanonicalOpenClawConfigTarget(target: AgentConfigTarget): void {
  if (target.agentName !== "openclaw") return;
  const files = [target.configPath, ...(target.sensitiveFiles || [])];
  if (
    target.configDir !== OPENCLAW_CONFIG_DIR ||
    target.configPath !== OPENCLAW_CONFIG_PATH ||
    files.length !== 2 ||
    files[0] !== OPENCLAW_CONFIG_PATH ||
    files[1] !== OPENCLAW_CONFIG_HASH_PATH
  ) {
    throw new Error(
      `OpenClaw shields require the canonical protected-file set under ${OPENCLAW_CONFIG_DIR}`,
    );
  }
}

function transitionOpenClawTopConfig(
  sandboxName: string,
  target: AgentConfigTarget,
  action: "preflight" | "lock" | "unlock",
): boolean {
  assertCanonicalOpenClawConfigTarget(target);
  const result = runOpenClawConfigGuard(openClawConfigGuardExec(sandboxName), action);
  if (result.issues.length > 0) {
    throw new Error(
      `Config not ${action === "unlock" ? "unlocked" : "locked"}: ${result.issues.join(", ")}`,
    );
  }
  return result.chattrApplied;
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

// Compatibility transition for a running Hermes image that predates the
// root-owned transaction helper. This path is reachable only from rebuild.
// It freezes `/sandbox` and `.hermes` through already-open directory FDs,
// validates the root-owned strict hash and in-tree compatibility hash, then
// publishes fresh inodes. Fresh replacement revokes any writable descriptors
// retained by the old gateway before a failed rebuild attempts to re-lock it.
const LEGACY_HERMES_CONFIG_TRANSITION_SCRIPT = String.raw`
import fcntl
import grp
import hashlib
import os
import pwd
import secrets
import stat
import struct
import sys

FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020
FS_IOC_GETFLAGS = 0x80086601
FS_IOC_SETFLAGS = 0x40086602
MAX_CONFIG_BYTES = 16 * 1024 * 1024
MAX_HASH_BYTES = 64 * 1024

def die(message):
    raise RuntimeError(message)

def inode_flags(fd):
    try:
        buf = bytearray(4)
        fcntl.ioctl(fd, FS_IOC_GETFLAGS, buf, True)
        return struct.unpack("I", buf)[0]
    except OSError:
        return 0

def set_inode_flags(fd, flags):
    try:
        fcntl.ioctl(fd, FS_IOC_SETFLAGS, struct.pack("I", flags))
    except OSError:
        if flags:
            raise

def clear_immutable(fd):
    flags = inode_flags(fd)
    mutable = flags & ~(FS_IMMUTABLE_FL | FS_APPEND_FL)
    if mutable != flags:
        set_inode_flags(fd, mutable)
    return flags

def open_directory(path, dir_fd=None):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_DIRECTORY", 0)
    fd = os.open(path, flags, dir_fd=dir_fd)
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        die("not a directory: " + path)
    return fd

def open_child_regular(dir_fd, name, label):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(name, flags, dir_fd=dir_fd)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        os.close(fd)
        die("refusing unsafe legacy Hermes path: " + label)
    return fd, st

def read_fd(fd, limit, label):
    os.lseek(fd, 0, os.SEEK_SET)
    chunks = []
    total = 0
    while True:
        chunk = os.read(fd, min(1024 * 1024, limit + 1 - total))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > limit:
            die("legacy Hermes file exceeds size limit: " + label)
        chunks.append(chunk)

def read_strict_hash(path):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
        if (
            not stat.S_ISREG(st.st_mode)
            or st.st_nlink != 1
            or st.st_uid != 0
            or stat.S_IMODE(st.st_mode) & 0o222
        ):
            die("refusing unsafe strict Hermes hash anchor")
        return read_fd(fd, MAX_HASH_BYTES, path)
    finally:
        os.close(fd)

def metadata(st):
    return {
        "dev": st.st_dev,
        "ino": st.st_ino,
        "uid": st.st_uid,
        "gid": st.st_gid,
        "mode": stat.S_IMODE(st.st_mode),
    }

def same_inode(st, saved):
    return st.st_dev == saved["dev"] and st.st_ino == saved["ino"]

def stage_file(dir_fd, name, data, uid, gid, mode):
    temp = ".%s.nemoclaw.%d.%s" % (name, os.getpid(), secrets.token_hex(8))
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    fd = os.open(temp, flags, 0o600, dir_fd=dir_fd)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                die("short write while staging " + name)
            view = view[written:]
        os.fsync(fd)
    except Exception:
        os.close(fd)
        try:
            os.unlink(temp, dir_fd=dir_fd)
        except OSError:
            pass
        raise
    os.close(fd)
    return temp

def replace_with_bytes(dir_fd, name, data, uid, gid, mode, flags=0):
    current_fd, _current_st = open_child_regular(dir_fd, name, name)
    try:
        clear_immutable(current_fd)
    finally:
        os.close(current_fd)
    temp = stage_file(dir_fd, name, data, uid, gid, mode)
    try:
        os.replace(temp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    finally:
        try:
            os.unlink(temp, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
    replacement_fd, replacement_st = open_child_regular(dir_fd, name, name)
    try:
        if (
            replacement_st.st_uid != uid
            or replacement_st.st_gid != gid
            or stat.S_IMODE(replacement_st.st_mode) != mode
        ):
            die("replacement metadata mismatch for " + name)
        if flags:
            set_inode_flags(replacement_fd, flags)
    finally:
        os.close(replacement_fd)

action = sys.argv[1]
config_dir = os.path.normpath(sys.argv[2])
strict_hash_path = os.path.normpath(sys.argv[3])
file_paths = [os.path.normpath(value) for value in sys.argv[4:]]
if action not in ("lock", "unlock"):
    die("unsupported legacy Hermes transition: " + action)
parent_dir = os.path.dirname(config_dir)
config_name = os.path.basename(config_dir)
if not parent_dir or config_name in ("", ".", ".."):
    die("invalid legacy Hermes config directory")

names = []
for file_path in file_paths:
    if os.path.dirname(file_path) != config_dir:
        die("legacy Hermes file escapes config directory: " + file_path)
    names.append(os.path.basename(file_path))
if set(names) != {"config.yaml", ".env", ".config-hash"} or len(names) != 3:
    die("legacy Hermes transition requires config.yaml, .env, and .config-hash")

sandbox_uid = pwd.getpwnam("sandbox").pw_uid
sandbox_gid = grp.getgrnam("sandbox").gr_gid
parent_fd = open_directory(parent_dir)
parent_initial_st = os.fstat(parent_fd)
parent_initial = metadata(parent_initial_st)
parent_initial_flags = inode_flags(parent_fd)
config_fd = None
config_initial = None
config_initial_flags = 0
opened = {}
staged = {}
file_mutation_started = False
body_error = None
rollback_errors = []
try:
    clear_immutable(parent_fd)
    os.fchown(parent_fd, 0, 0)
    os.fchmod(parent_fd, 0o755)

    config_fd = open_directory(config_name, dir_fd=parent_fd)
    config_initial_st = os.fstat(config_fd)
    config_initial = metadata(config_initial_st)
    config_initial_flags = clear_immutable(config_fd)
    os.fchown(config_fd, 0, 0)
    os.fchmod(config_fd, 0o700)

    for name, file_path in zip(names, file_paths):
        fd, st = open_child_regular(config_fd, name, file_path)
        opened[name] = {
            "fd": fd,
            "meta": metadata(st),
            "flags": inode_flags(fd),
            "data": read_fd(
                fd,
                MAX_HASH_BYTES if name == ".config-hash" else MAX_CONFIG_BYTES,
                file_path,
            ),
        }

    strict_hash = read_strict_hash(strict_hash_path)
    expected_hash = (
        hashlib.sha256(opened["config.yaml"]["data"]).hexdigest()
        + "  " + os.path.join(config_dir, "config.yaml") + "\n"
        + hashlib.sha256(opened[".env"]["data"]).hexdigest()
        + "  " + os.path.join(config_dir, ".env") + "\n"
    ).encode("utf-8")
    if strict_hash != expected_hash:
        die("strict hash verification failed for legacy Hermes shields transition")
    if opened[".config-hash"]["data"] != strict_hash:
        die("compat hash verification failed for legacy Hermes shields transition")

    desired_uid = 0 if action == "lock" else sandbox_uid
    desired_gid = 0 if action == "lock" else sandbox_gid
    desired_mode = 0o444 if action == "lock" else 0o640
    for name in names:
        trusted = strict_hash if name == ".config-hash" else opened[name]["data"]
        staged[name] = stage_file(
            config_fd, name, trusted, desired_uid, desired_gid, desired_mode
        )

    for name in names:
        current = os.stat(name, dir_fd=config_fd, follow_symlinks=False)
        if not same_inode(current, opened[name]["meta"]):
            die("legacy Hermes path changed during transition: " + name)
        file_mutation_started = True
        clear_immutable(opened[name]["fd"])
        os.replace(staged[name], name, src_dir_fd=config_fd, dst_dir_fd=config_fd)
        staged.pop(name, None)
    for temp in staged.values():
        try:
            os.unlink(temp, dir_fd=config_fd)
        except FileNotFoundError:
            pass

    for name in names:
        fd, st = open_child_regular(config_fd, name, name)
        try:
            trusted = strict_hash if name == ".config-hash" else opened[name]["data"]
            if read_fd(
                fd,
                MAX_HASH_BYTES if name == ".config-hash" else MAX_CONFIG_BYTES,
                name,
            ) != trusted:
                die("legacy Hermes replacement content mismatch for " + name)
            if (
                st.st_uid != desired_uid
                or st.st_gid != desired_gid
                or stat.S_IMODE(st.st_mode) != desired_mode
            ):
                die("legacy Hermes replacement metadata mismatch for " + name)
        finally:
            os.close(fd)

    if action == "lock":
        os.fchown(config_fd, 0, 0)
        os.fchmod(config_fd, 0o755)
        os.fchown(parent_fd, 0, sandbox_gid)
        os.fchmod(parent_fd, 0o1775)
    else:
        os.fchown(config_fd, sandbox_uid, sandbox_gid)
        os.fchmod(config_fd, 0o3770)
        os.fchown(parent_fd, sandbox_uid, sandbox_gid)
        os.fchmod(parent_fd, 0o755)
    try:
        os.fsync(config_fd)
    except OSError:
        pass
except BaseException as exc:
    body_error = exc
    if config_fd is not None and file_mutation_started:
        for name, original in opened.items():
            try:
                replace_with_bytes(
                    config_fd,
                    name,
                    original["data"],
                    original["meta"]["uid"],
                    original["meta"]["gid"],
                    original["meta"]["mode"],
                    original["flags"],
                )
            except BaseException as rollback_error:
                rollback_errors.append("%s: %s" % (name, rollback_error))
finally:
    if config_fd is not None:
        for temp in staged.values():
            try:
                os.unlink(temp, dir_fd=config_fd)
            except OSError:
                pass
    for original in opened.values():
        try:
            os.close(original["fd"])
        except OSError:
            pass
    if body_error is not None:
        if config_fd is not None and config_initial is not None:
            try:
                os.fchown(config_fd, config_initial["uid"], config_initial["gid"])
                os.fchmod(config_fd, config_initial["mode"])
                set_inode_flags(config_fd, config_initial_flags)
            except BaseException as rollback_error:
                rollback_errors.append("config dir: %s" % rollback_error)
        try:
            os.fchown(parent_fd, parent_initial["uid"], parent_initial["gid"])
            os.fchmod(parent_fd, parent_initial["mode"])
            set_inode_flags(parent_fd, parent_initial_flags)
        except BaseException as rollback_error:
            rollback_errors.append("parent dir: %s" % rollback_error)
    if config_fd is not None:
        os.close(config_fd)
    os.close(parent_fd)

if body_error is not None:
    message = str(body_error)
    if rollback_errors:
        message += "; rollback failed: " + "; ".join(rollback_errors)
    raise RuntimeError(message)
`;

function transitionLegacyHermesConfig(
  sandboxName: string,
  target: AgentConfigTarget,
  action: "lock" | "unlock",
  files: string[],
): void {
  privilegedSandboxExec(sandboxName, [
    "python3",
    "-I",
    "-c",
    LEGACY_HERMES_CONFIG_TRANSITION_SCRIPT,
    action,
    target.configDir,
    HERMES_CONFIG_HASH,
    ...files,
  ]);
}

function unlockConfigPathsNoSymlinkFollow(
  sandboxName: string,
  target: AgentConfigTarget,
  fileMode: string,
  dirMode: string,
  filesToUnlock: string[],
): void {
  privilegedSandboxExec(sandboxName, [
    "python3",
    "-I",
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

function assertNoLegacyStateLayout(sandboxName: string, configDir: string): void {
  const dataDir = legacyDataDirFor(configDir);
  const script =
    'set -u; config_dir="$1"; data_dir="$2"; data_real="$(readlink -f "$data_dir" 2>/dev/null || printf "%s" "$data_dir")"; if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then echo "legacy data dir exists: $data_dir"; exit 1; fi; for entry in "$config_dir"/*; do [ -L "$entry" ] || continue; target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"; case "$target" in "$data_real"/*|"$data_dir"/*) echo "legacy symlink remains: $entry -> $target"; exit 1;; esac; done';
  try {
    privilegedSandboxExecCapture(sandboxName, ["sh", "-c", script, "sh", configDir, dataDir]);
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
// Note on chattr: best-effort — the privileged sandbox exec may lack
// CAP_LINUX_IMMUTABLE, or the file may never have been immutable. That's fine:
// the file becomes writable through the permissive policy (disables Landlock
// read_only) + chown/chmod below.
// ---------------------------------------------------------------------------

function unlockAgentConfigUnderMutationLock(
  sandboxName: string,
  rawTarget: AgentConfigTarget,
  rollbackLocked: boolean,
  protocol: HermesShieldsProtocol,
): void {
  const target = ensureConfigHashSensitiveFile(rawTarget);
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
  let transaction: {
    token: string;
    originalLocked: boolean;
    rollbackLocked: boolean;
  } | null = null;
  const legacyHermesProtocol = target.agentName === "hermes" && protocol === "legacy";
  const openClawProtocol = target.agentName === "openclaw";
  let openClawMutationStarted = false;
  try {
    if (openClawProtocol) {
      transitionOpenClawTopConfig(sandboxName, target, "preflight");
    }
    if (target.agentName === "hermes" && !legacyHermesProtocol) {
      transaction = beginHermesConfigShields(
        sandboxName,
        target,
        "mutable",
        rollbackLocked ? "locked" : "mutable",
      );
    }
    if (legacyHermesProtocol) {
      transitionLegacyHermesConfig(sandboxName, target, "unlock", filesToUnlock);
    } else if (target.agentName !== "hermes" && !openClawProtocol) {
      unlockConfigPathsNoSymlinkFollow(sandboxName, target, fileMode, dirMode, filesToUnlock);
    }

    // Restore sandbox ownership while Hermes remains sealed and its top-level
    // config directory is root-only. The final mutable inode transition is
    // applied only after the recursive fan-out succeeds.
    if (openClawProtocol) openClawMutationStarted = true;
    if (transaction) {
      // Keep the recursive worker under the same in-container token owner as
      // the fresh-inode Hermes transaction. If the host Docker client dies,
      // a later locked takeover can observe and wait for the exact worker
      // identity instead of racing an orphaned unlock pass.
      runHermesStateDirTransition(sandboxName, target, transaction.token, "unlock");
    } else {
      const stateDirUnlockIssues = applyStateDirLockMode(
        stateDirLockExec(sandboxName),
        target.configDir,
        "sandbox:sandbox",
        false,
      );
      for (const issue of stateDirUnlockIssues) errors.push(`state dir unlock: ${issue}`);
    }
    if (errors.length > 0) {
      throw new Error(`Config not unlocked: ${errors.join(", ")}`);
    }

    if (transaction) {
      applyHermesConfigShields(sandboxName, target, transaction.token);
    } else if (openClawProtocol) {
      // Commit the top-level ownership handoff last. Until this succeeds the
      // root-owned config directory and sticky root-owned /sandbox parent keep
      // the canonical OpenClaw path bound while recursive state is prepared.
      transitionOpenClawTopConfig(sandboxName, target, "unlock");
    }

    const issues: string[] = [];
    for (const f of filesToUnlock) {
      try {
        const perms = privilegedSandboxExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", f]);
        const [mode, owner] = perms.split(" ");
        if (mode !== fileMode) issues.push(`${f} mode=${mode} (expected ${fileMode})`);
        if (owner !== "sandbox:sandbox")
          issues.push(`${f} owner=${owner} (expected sandbox:sandbox)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`${f} stat failed: ${msg}`);
      }
      try {
        const attrs = privilegedSandboxExecCapture(sandboxName, ["lsattr", "-d", f]);
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
      if (mode !== dirMode) issues.push(`config dir mode=${mode} (expected ${dirMode})`);
      if (owner !== "sandbox:sandbox") {
        issues.push(`config dir owner=${owner} (expected sandbox:sandbox)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`config dir stat failed: ${msg}`);
    }

    if (openClawProtocol) {
      try {
        const parentPerms = privilegedSandboxExecCapture(sandboxName, [
          "stat",
          "-c",
          "%a %U:%G",
          "/sandbox",
        ]);
        const [mode, owner] = parentPerms.split(" ");
        if (mode !== "755") issues.push(`parent dir mode=${mode} (expected 755)`);
        if (owner !== "sandbox:sandbox") {
          issues.push(`parent dir owner=${owner} (expected sandbox:sandbox)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`parent dir stat failed: ${msg}`);
      }
    }

    if (issues.length > 0) throw new Error(`Config not unlocked: ${issues.join(", ")}`);
    if (transaction) {
      finishHermesConfigShields(sandboxName, target, transaction.token);
    }
  } catch (error) {
    if (transaction) {
      try {
        prepareHermesConfigShieldsAbort(sandboxName, target, transaction.token);
        runHermesStateDirTransition(
          sandboxName,
          target,
          transaction.token,
          transaction.rollbackLocked ? "lock" : "unlock",
        );
        abortHermesConfigShields(sandboxName, target, transaction.token);
      } catch (abortError) {
        const message = abortError instanceof Error ? abortError.message : String(abortError);
        console.error(
          `  CRITICAL: Hermes shields rollback preparation failed; the root transaction remains sealed. Restore from a trusted backup and recreate the sandbox. ${message}`,
        );
      }
    } else if (legacyHermesProtocol) {
      const rollbackIssues: string[] = [];
      try {
        transitionLegacyHermesConfig(
          sandboxName,
          target,
          rollbackLocked ? "lock" : "unlock",
          filesToUnlock,
        );
      } catch (rollbackError) {
        rollbackIssues.push(
          `top-level config rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      try {
        rollbackIssues.push(
          ...restoreStateDirLockPosture(
            stateDirLockExec(sandboxName),
            target.configDir,
            rollbackLocked,
          ),
        );
      } catch (rollbackError) {
        rollbackIssues.push(
          `state-directory rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      if (rollbackIssues.length > 0) {
        console.error(
          `  CRITICAL: Legacy Hermes unlock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox. ${rollbackIssues.join(", ")}`,
        );
      }
    } else if (openClawProtocol && openClawMutationStarted) {
      const rollbackIssues: string[] = [];
      const restoreTop = (action: "lock" | "unlock") => {
        try {
          transitionOpenClawTopConfig(sandboxName, target, action);
        } catch (rollbackError) {
          rollbackIssues.push(
            `top-level config rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      };
      const restoreState = () => {
        try {
          rollbackIssues.push(
            ...restoreStateDirLockPosture(
              stateDirLockExec(sandboxName),
              target.configDir,
              rollbackLocked,
            ),
          );
        } catch (rollbackError) {
          rollbackIssues.push(
            `state-directory rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      };
      if (rollbackLocked) {
        restoreTop("lock");
        restoreState();
      } else {
        restoreState();
        restoreTop("unlock");
      }
      if (rollbackIssues.length > 0) {
        console.error(
          `  CRITICAL: OpenClaw unlock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox. ${rollbackIssues.join(", ")}`,
        );
      }
    }
    throw error;
  }
}

function unlockAgentConfigWithoutHostLock(
  sandboxName: string,
  rawTarget: AgentConfigTarget,
  rollbackLocked = getShieldsPosture(sandboxName, false).locked,
  allowLegacyHermesProtocol = false,
  cachedProtocol?: HermesShieldsProtocol,
): void {
  const target = ensureConfigHashSensitiveFile(rawTarget);
  const protocol = resolveHermesShieldsProtocol(
    sandboxName,
    target,
    allowLegacyHermesProtocol,
    cachedProtocol,
  );
  return unlockAgentConfigUnderMutationLock(sandboxName, target, rollbackLocked, protocol);
}

function unlockAgentConfig(
  sandboxName: string,
  rawTarget: AgentConfigTarget,
  rollbackLocked?: boolean,
  allowLegacyHermesProtocol = false,
  cachedProtocol?: HermesShieldsProtocol,
): void {
  return withShieldsTransitionLock(sandboxName, "unlock agent config", () => {
    const effectiveRollbackLocked = rollbackLocked ?? getShieldsPosture(sandboxName, false).locked;
    return unlockAgentConfigWithoutHostLock(
      sandboxName,
      rawTarget,
      effectiveRollbackLocked,
      allowLegacyHermesProtocol,
      cachedProtocol,
    );
  });
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

function inspectMutableConfigPerms(sandboxName: string): MutableConfigPermsInspection {
  validateName(sandboxName, "sandbox name");
  prepareExpiredAutoRestoreHostLockTakeover(sandboxName);
  return withTimerBoundShieldsMutationLock(
    sandboxName,
    "inspect mutable config permissions",
    () => {
      const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
      return inspectMutableConfigPermsCore(
        target,
        getShieldsPostureWithoutHostLock(sandboxName, true).mode,
        (p) => privilegedSandboxExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", p]),
      );
    },
  );
}

function repairMutableConfigPerms(sandboxName: string): MutableConfigRepairResult {
  validateName(sandboxName, "sandbox name");
  prepareExpiredAutoRestoreHostLockTakeover(sandboxName);
  return withTimerBoundShieldsMutationLock(sandboxName, "repair mutable config permissions", () => {
    const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
    return repairMutableConfigPermsCore(
      target,
      getShieldsPostureWithoutHostLock(sandboxName, true).mode,
      () => normalizeMutableOpenClawConfig(sandboxName, target.configDir),
    );
  });
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
// Layer 3 is best-effort because the privileged sandbox exec may lack
// CAP_LINUX_IMMUTABLE. Layers 1+2 are sufficient. We still attempt it in case
// the runtime environment supports it.
// ---------------------------------------------------------------------------

function captureSealHashes(sandboxName: string, filesToHash: string[]): { [path: string]: string } {
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

function lockAgentConfigUnderMutationLock(
  sandboxName: string,
  rawTarget: AgentConfigTarget,
  rollbackLocked: boolean,
  protocol: HermesShieldsProtocol,
): { chattrApplied: boolean; fileHashes: { [path: string]: string } } {
  const target = ensureConfigHashSensitiveFile(rawTarget);
  const errors: string[] = [];
  const filesToLock = [target.configPath, ...(target.sensitiveFiles || [])];
  const openClawProtocol = target.agentName === "openclaw";
  let transaction: {
    token: string;
    originalLocked: boolean;
    rollbackLocked: boolean;
  } | null = null;
  const legacyHermesProtocol = target.agentName === "hermes" && protocol === "legacy";
  let openClawMutationStarted = false;
  let chattrSucceeded = target.agentName === "hermes" && !legacyHermesProtocol ? false : true;

  // Agents without a descriptor-sealed top-level transaction retain the
  // historical validate-before-mutate ordering. OpenClaw and current Hermes
  // must revoke writes to their canonical config first: otherwise an agent can
  // plant one invalid nested entry and veto the auto-restore deadline forever.
  if (!openClawProtocol && (target.agentName !== "hermes" || legacyHermesProtocol)) {
    const preflightIssues = preflightStateDirLock(stateDirLockExec(sandboxName), target.configDir);
    if (preflightIssues.length > 0) {
      throw new Error(`Config not locked: ${preflightIssues.join(", ")}`);
    }
  }

  try {
    if (target.agentName === "hermes" && !legacyHermesProtocol) {
      transaction = beginHermesConfigShields(
        sandboxName,
        target,
        "locked",
        rollbackLocked ? "locked" : "mutable",
      );
    }
    if (openClawProtocol) {
      openClawMutationStarted = true;
      // This is the containment boundary: freeze and fresh-seal the canonical
      // pair before inspecting attacker-writable descendant state.
      chattrSucceeded = transitionOpenClawTopConfig(sandboxName, target, "lock");
    } else if (legacyHermesProtocol) {
      transitionLegacyHermesConfig(sandboxName, target, "lock", filesToLock);
    } else if (target.agentName !== "hermes") {
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
        privilegedSandboxExec(sandboxName, ["chown", "root:root", target.configDir]);
      } catch {
        errors.push("chown root:root config dir");
      }
    }

    // For Hermes, the guard applies immutable flags to the fresh sealed
    // inodes. Other agents keep the existing best-effort host path.
    if (!openClawProtocol && (target.agentName !== "hermes" || legacyHermesProtocol)) {
      for (const f of filesToLock) {
        try {
          privilegedSandboxExec(sandboxName, ["chattr", "+i", f]);
        } catch {
          chattrSucceeded = false;
        }
      }
    }

    if (transaction) {
      runHermesStateDirTransition(sandboxName, target, transaction.token, "lock");
    } else {
      const stateDirLockIssues = applyStateDirLockMode(
        stateDirLockExec(sandboxName),
        target.configDir,
        "root:sandbox",
        true,
      );
      if (stateDirLockIssues.length > 0) {
        throw new Error(`Config not locked: ${stateDirLockIssues.join(", ")}`);
      }
    }

    if (!openClawProtocol) {
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
    }
    if (errors.length > 0) {
      console.error(`  Some lock operations failed: ${errors.join(", ")}`);
    }

    if (transaction) {
      chattrSucceeded = applyHermesConfigShields(sandboxName, target, transaction.token);
    }

    const { issues } = verifyShieldsLockState(sandboxName, target, {
      verifyChattr: chattrSucceeded,
      verifyParentProtection: target.agentName === "hermes" || openClawProtocol,
      exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
      assertLegacyLayout: assertNoLegacyStateLayout,
    });
    if (issues.length > 0) throw new Error(`Config not locked: ${issues.join(", ")}`);

    const fileHashes = captureSealHashes(sandboxName, filesToLock);
    if (transaction) {
      finishHermesConfigShields(sandboxName, target, transaction.token);
    }
    return { chattrApplied: chattrSucceeded, fileHashes };
  } catch (error) {
    if (transaction && !transaction.rollbackLocked) {
      // The requested direction is hardening from a mutable posture. Once the
      // root guard has frozen the canonical Hermes config, a nested-state
      // finding must not hand mutation authority back to the sandbox. Commit
      // the top-level locked posture and leave shields state DOWN so the timer
      // retains authority and retries the remaining recursive work.
      try {
        applyHermesConfigShields(sandboxName, target, transaction.token);
        finishHermesConfigShields(sandboxName, target, transaction.token);
      } catch (containmentError) {
        const message =
          containmentError instanceof Error ? containmentError.message : String(containmentError);
        console.error(
          `  CRITICAL: Hermes lock failed after containment began; the root transaction remains sealed. Restore from a trusted backup and recreate the sandbox. ${message}`,
        );
      }
    } else if (transaction) {
      try {
        prepareHermesConfigShieldsAbort(sandboxName, target, transaction.token);
        runHermesStateDirTransition(
          sandboxName,
          target,
          transaction.token,
          transaction.rollbackLocked ? "lock" : "unlock",
        );
        abortHermesConfigShields(sandboxName, target, transaction.token);
      } catch (abortError) {
        const message = abortError instanceof Error ? abortError.message : String(abortError);
        console.error(
          `  CRITICAL: Hermes shields rollback preparation failed; the root transaction remains sealed. Restore from a trusted backup and recreate the sandbox. ${message}`,
        );
      }
    } else if (openClawProtocol && openClawMutationStarted) {
      const rollbackIssues: OpenClawRollbackIssue[] = [];
      const restoreTop = (action: "lock" | "unlock") => {
        try {
          transitionOpenClawTopConfig(sandboxName, target, action);
        } catch (rollbackError) {
          rollbackIssues.push(
            openClawRollbackIssue("top-level config rollback failed", rollbackError),
          );
        }
      };
      const restoreState = () => {
        try {
          rollbackIssues.push(
            ...restoreStateDirLockPosture(
              stateDirLockExec(sandboxName),
              target.configDir,
              rollbackLocked,
            ).map((message) => ({ message, readinessFailure: false })),
          );
        } catch (rollbackError) {
          rollbackIssues.push(
            openClawRollbackIssue("state-directory rollback failed", rollbackError),
          );
        }
      };
      if (rollbackLocked) {
        restoreTop("lock");
        restoreState();
      } else {
        // Preserve the canonical config seal. The caller records shields as
        // still DOWN and the timer retries recursive containment; reopening
        // the top-level pair here would make one planted nested entry an
        // attacker-controlled veto over the restore deadline.
        restoreTop("lock");
      }
      if (rollbackIssues.length > 0) {
        const rollbackSummary = rollbackIssues.map(({ message }) => message).join(", ");
        if (
          isOpenClawReadinessFailure(error) &&
          rollbackIssues.every(({ readinessFailure }) => readinessFailure)
        ) {
          console.error(
            `  Warning: OpenClaw lock rollback could not restore the trusted posture. Confirm the sandbox is running and ready, then retry the operation before rebuilding. ${rollbackSummary}`,
          );
        } else {
          console.error(
            `  CRITICAL: OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox. ${rollbackSummary}`,
          );
        }
      }
    }
    throw error;
  }
}

function synchronizeAutoRestoreTransition(
  sandboxName: string,
  processToken: string,
  snapshotPath: string,
): void {
  const transition = waitForShieldsDownForwardCommit(sandboxName, processToken);
  if (!transition) return;
  if (transition.snapshotPath !== snapshotPath) {
    throw new Error("Auto-restore snapshot does not match shields-down transition ownership");
  }

  // The timer restores policy before calling lockAgentConfig. If it expired
  // while shieldsDown was still applying the permissive policy or unlocking
  // config, that first restore may have been overwritten. The phase handshake
  // above waits until the forward path has either committed its last weakening
  // mutation or its owner has died; restore the restrictive snapshot again at
  // that stable boundary before locking config.
  const restoreResult = run(buildPolicySetCommand(transition.snapshotPath, sandboxName), {
    ignoreError: true,
  });
  const status = typeof restoreResult.status === "number" ? restoreResult.status : 1;
  if (status !== 0) {
    throw new Error(
      `Policy restore after shields-down handoff exited with status ${String(status)}`,
    );
  }
  clearShieldsDownTransition(sandboxName, processToken);
}

function prepareAutoRestoreTransitionTakeover(
  sandboxName: string,
  processToken: string,
  snapshotPath: string,
): void {
  if (!/^[0-9a-f]{32}$/.test(processToken)) {
    throw new Error("Invalid auto-restore transition takeover token");
  }

  const transition = readShieldsDownTransition(sandboxName, processToken);
  if (transition && transition.snapshotPath !== snapshotPath) {
    throw new Error("Auto-restore snapshot does not match shields-down transition ownership");
  }
  if (transition) {
    // This waits briefly for the forward commit and stops its exact process
    // tree if the deadline fired while it was still weakening the sandbox.
    waitForShieldsDownForwardCommit(sandboxName, processToken);
  }

  const owner = inspectShieldsTransitionLockOwner(sandboxName, processToken);
  if (!owner) return;
  if (
    isProcessAlive(owner.pid) &&
    readProcessStartIdentity(owner.pid) === owner.processStartIdentity
  ) {
    // The same timer token is also propagated to config/inference/restart
    // mutations made during the mutable window. At expiry those operations
    // are weaker than restoring lockdown and may be preempted safely.
    stopTimedOutShieldsDownTree(owner.pid, owner.processStartIdentity);
  }
  const takeover = takeoverShieldsTransitionLock(
    sandboxName,
    owner.pid,
    owner.processStartIdentity,
    processToken,
  );
  if (
    !takeover.removed &&
    takeover.reason !== "missing" &&
    takeover.reason !== "path-changed" &&
    takeover.reason !== "owner-mismatch"
  ) {
    throw new Error(`Cannot take over expired shields transition lock: ${takeover.reason}`);
  }
}

function synchronizeAutoRestoreWithShieldsDown(sandboxName: string): void {
  const timerMarker = readTimerMarker(sandboxName);
  if (
    !timerMarker ||
    timerMarker.pid !== process.pid ||
    !timerMarker.processToken ||
    !/^[0-9a-f]{32}$/.test(timerMarker.processToken)
  ) {
    return;
  }
  synchronizeAutoRestoreTransition(sandboxName, timerMarker.processToken, timerMarker.snapshotPath);
}

function lockAgentConfigWithoutHostLock(
  sandboxName: string,
  rawTarget: AgentConfigTarget,
  rollbackLocked = getShieldsPosture(sandboxName, false).locked,
  allowLegacyHermesProtocol = false,
  cachedProtocol?: HermesShieldsProtocol,
): { chattrApplied: boolean; fileHashes: { [path: string]: string } } {
  const target = ensureConfigHashSensitiveFile(rawTarget);
  const protocol = resolveHermesShieldsProtocol(
    sandboxName,
    target,
    allowLegacyHermesProtocol,
    cachedProtocol,
  );
  synchronizeAutoRestoreWithShieldsDown(sandboxName);
  return lockAgentConfigUnderMutationLock(sandboxName, target, rollbackLocked, protocol);
}

function lockAgentConfig(
  sandboxName: string,
  rawTarget: AgentConfigTarget,
  rollbackLocked?: boolean,
  allowLegacyHermesProtocol = false,
  cachedProtocol?: HermesShieldsProtocol,
): { chattrApplied: boolean; fileHashes: { [path: string]: string } } {
  return withShieldsTransitionLock(sandboxName, "lock agent config", () => {
    const effectiveRollbackLocked = rollbackLocked ?? getShieldsPosture(sandboxName, false).locked;
    return lockAgentConfigWithoutHostLock(
      sandboxName,
      rawTarget,
      effectiveRollbackLocked,
      allowLegacyHermesProtocol,
      cachedProtocol,
    );
  });
}

function rollbackShieldsDown(
  sandboxName: string,
  target: AgentConfigTarget,
  snapshotPath: string,
  allowLegacyHermesProtocol = false,
  cachedProtocol?: HermesShieldsProtocol,
): void {
  console.error("  Rolling back — restoring policy from snapshot...");
  const rollbackResult = run(buildPolicySetCommand(snapshotPath, sandboxName), {
    ignoreError: true,
  });
  let rollbackChattrApplied: boolean | null = null;
  let rollbackFileHashes: { [path: string]: string } | null = null;
  if (rollbackResult.status === 0) {
    // Re-confirm after the settle window so a reconciler revert cannot leave
    // the rolled-back config DRIFTED — same fail-closed treatment as the
    // auto-restore path. Leaves the hashes null (→ "manual intervention"
    // below) when the lock will not re-confirm.
    const relock = relockAndReconfirm(() =>
      lockAgentConfig(sandboxName, target, true, allowLegacyHermesProtocol, cachedProtocol),
    );
    if (relock.ok && relock.lastResult) {
      rollbackChattrApplied = relock.lastResult.chattrApplied;
      rollbackFileHashes = relock.lastResult.fileHashes;
    } else {
      console.error(
        "  Warning: Rollback re-lock could not be re-confirmed. Check config manually.",
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
    printManualRelockRecoveryHint(sandboxName);
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
  allowLegacyHermesProtocol = false,
  cachedTarget?: AgentConfigTarget,
  cachedProtocol?: HermesShieldsProtocol,
): LockdownActivationResult {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return { ok: false, error: "saved snapshot is missing" };
  }

  const restoreResult = run(buildPolicySetCommand(snapshotPath, sandboxName), {
    ignoreError: true,
  });
  const restoreStatus = typeof restoreResult.status === "number" ? restoreResult.status : 1;
  if (restoreStatus !== 0) {
    return {
      ok: false,
      error: `policy restore exited with status ${String(restoreStatus)}`,
    };
  }

  const target = ensureConfigHashSensitiveFile(cachedTarget ?? resolveAgentConfig(sandboxName));
  let protocol: HermesShieldsProtocol;
  try {
    protocol = resolveHermesShieldsProtocol(
      sandboxName,
      target,
      allowLegacyHermesProtocol,
      cachedProtocol,
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // Re-confirm the lock after a settle window. This restore feeds the
  // auto-restore inline recovery and the `shields up` snapshot path, both of
  // which mark shields UP on this result — so a reconciler revert here would
  // otherwise leave the same DRIFTED state #4663 is about. relockAndReconfirm
  // fails closed (ok:false) when the lock will not hold past the settle window.
  const relock = relockAndReconfirm(() =>
    lockAgentConfig(sandboxName, target, false, allowLegacyHermesProtocol, protocol),
  );
  if (!relock.ok || !relock.lastResult) {
    return {
      ok: false,
      error: relock.error ?? "config re-lock did not re-confirm after the settle window",
    };
  }
  return {
    ok: true,
    chattrApplied: relock.lastResult.chattrApplied,
    fileHashes: relock.lastResult.fileHashes,
  };
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
  if (isProcessAlive(marker.pid) && verifyTimerMarkerIdentity(marker).verified) {
    if (Date.now() <= restoreAtMs + AUTO_RESTORE_COMPLETION_GRACE_MS) {
      return { attempted: false, restored: false };
    }
    const timerStartIdentity = readProcessStartIdentity(marker.pid);
    if (!timerStartIdentity) {
      console.error(
        "  Recovery warning: expired auto-restore timer identity cannot be pinned safely.",
      );
      return { attempted: true, restored: false };
    }
    try {
      stopTimedOutShieldsDownTree(marker.pid, timerStartIdentity);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Recovery warning: ${message}`);
      return { attempted: true, restored: false };
    }
  }

  console.error(
    "  Warning: auto-restore timer marker is expired and the timer process is not the recorded shields timer; attempting inline restore.",
  );

  if (marker.processToken && /^[0-9a-f]{32}$/.test(marker.processToken)) {
    try {
      synchronizeAutoRestoreTransition(sandboxName, marker.processToken, marker.snapshotPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendAuditEntry({
        action: "shields_up_failed",
        sandbox: sandboxName,
        timestamp: new Date().toISOString(),
        restored_by: "auto_timer",
        policy_snapshot: marker.snapshotPath,
        error: `Inline auto-restore handoff failed: ${message}`,
      });
      console.error(`  Recovery warning: ${message}`);
      return { attempted: true, restored: false };
    }
  }

  const activation = activateLockdownFromSnapshot(
    sandboxName,
    marker.snapshotPath,
    marker.allowLegacyHermesProtocol === true,
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
    console.error("  Recovery warning: inline auto-restore failed; shields remain DOWN.");
    console.error(`  Recovery warning: run \`nemoclaw ${sandboxName} shields up\` manually.`);
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
  if (marker.processToken && /^[0-9a-f]{32}$/.test(marker.processToken)) {
    clearShieldsDownTransition(sandboxName, marker.processToken);
  }
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
  if (deriveShieldsMode(state, state._hasStateFile) !== "temporarily_unlocked") {
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
  allowLegacyHermesProtocol?: boolean;
  // Internal rebuild lease: once the deadline expires, the detached recovery
  // owner defers while this exact process is alive and retries transient
  // restore failures after owner death. Interactive shields-down never sets it.
  deferAutoRestoreWhileOwnerAlive?: boolean;
  processToken?: string;
}

function shieldsDownWithoutHostLock(sandboxName: string, opts: ShieldsDownOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  if (state.shieldsDown) {
    console.error(
      `  Config is already unlocked for ${sandboxName} (since ${state.shieldsDownAt}).`,
    );
    console.error("  Run `nemoclaw shields up` first, or use --extend (not yet implemented).");
    return failShieldsCommand(`Config is already unlocked for ${sandboxName}`, opts.throwOnError);
  }

  // Resolve the old-image compatibility contract before touching timers,
  // host state, policy, or sandbox files. A transport failure or an
  // unsupported/incomplete guard must leave an ordinary shields command with
  // no partial mutation. The result is pinned for the complete transition so
  // a later probe failure cannot silently switch a sealed path to legacy.
  const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
  const protocol = requireHermesShieldsProtocol(
    sandboxName,
    target,
    opts.allowLegacyHermesProtocol === true,
  );

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
    console.error(`  Unknown policy "${policyName}". Use "permissive" or a path to a YAML file.`);
    return failShieldsCommand(`Unknown policy "${policyName}"`, opts.throwOnError);
  }

  const now = new Date().toISOString();
  let transition: ShieldsDownTransition | null = null;

  // Commit the host-side recovery authority before weakening policy or file
  // permissions. If this process is killed later, the detached timer and its
  // marker already exist and the persisted state honestly reports shields
  // down. A crash can therefore never leave an untracked mutable window.
  if (!opts.skipTimer) {
    const restoreAt = new Date(Date.now() + timeoutSeconds * 1000);
    const processToken = opts.processToken ?? randomBytes(16).toString("hex");
    if (!/^[0-9a-f]{32}$/.test(processToken)) {
      throw new Error("Invalid shields-down recovery process token");
    }
    const timerScript = path.join(__dirname, "timer.ts");
    const timerScriptJs = timerScript.replace(/\.ts$/, ".js");
    const actualScript = fs.existsSync(timerScriptJs) ? timerScriptJs : timerScript;
    transition = {
      version: 1,
      phase: "preparing",
      ownerPid: process.pid,
      ownerStartIdentity:
        readProcessStartIdentity(process.pid) ??
        (() => {
          throw new Error("Cannot identify shields-down owner process");
        })(),
      processToken,
      sandboxName,
      snapshotPath,
    };
    const leaseOwnerPid = opts.deferAutoRestoreWhileOwnerAlive ? transition.ownerPid : null;
    const leaseOwnerStartIdentity = opts.deferAutoRestoreWhileOwnerAlive
      ? transition.ownerStartIdentity
      : null;
    let timerChild: ReturnType<typeof fork> | null = null;

    try {
      // Publish the forward-transition ownership marker before authorizing the
      // timer. If the timeout expires while this command is still weakening
      // policy/config, the timer waits for phase=active or owner death instead
      // of racing the forward mutations.
      writeShieldsDownTransition(transition, null);
      timerChild = fork(
        actualScript,
        [
          sandboxName,
          snapshotPath,
          restoreAt.toISOString(),
          target.configPath,
          target.configDir,
          processToken,
          opts.allowLegacyHermesProtocol === true ? "1" : "0",
          leaseOwnerPid === null ? "" : String(leaseOwnerPid),
          leaseOwnerStartIdentity ?? "",
        ],
        {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      if (!timerChild.pid) throw new Error("auto-restore timer did not report a process id");
      fs.writeFileSync(
        timerMarkerPath(sandboxName),
        JSON.stringify({
          pid: timerChild.pid,
          sandboxName,
          snapshotPath,
          restoreAt: restoreAt.toISOString(),
          processToken,
          allowLegacyHermesProtocol: opts.allowLegacyHermesProtocol === true,
          ...(leaseOwnerPid !== null && leaseOwnerStartIdentity
            ? { leaseOwnerPid, leaseOwnerStartIdentity }
            : {}),
        }),
        { mode: 0o600 },
      );
      if (!timerChild.send({ type: "authorize", processToken })) {
        throw new Error("auto-restore timer authorization channel closed early");
      }
      timerChild.disconnect();
      timerChild.unref();
    } catch (err) {
      try {
        timerChild?.kill("SIGTERM");
      } catch {
        // Best effort; without a matching marker the child has no authority.
      }
      clearTimerMarker(sandboxName);
      clearShieldsDownTransition(sandboxName, processToken);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Cannot start auto-restore timer: ${message}`);
      return failShieldsCommand(`Cannot start auto-restore timer: ${message}`, opts.throwOnError);
    }
  }

  try {
    saveShieldsState(sandboxName, {
      shieldsDown: true,
      shieldsDownAt: now,
      shieldsDownTimeout: timeoutSeconds,
      shieldsDownReason: reason,
      shieldsDownPolicy: policyName,
      shieldsPolicySnapshotPath: snapshotPath,
    });
  } catch (error) {
    if (transition) {
      clearShieldsDownTransition(sandboxName, transition.processToken);
      killTimer(sandboxName);
    }
    throw error;
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
  console.log(`  Unlocking ${target.agentName} config (${target.configPath})...`);
  try {
    unlockAgentConfig(
      sandboxName,
      target,
      deriveShieldsMode(state, state._hasStateFile) === "locked",
      opts.allowLegacyHermesProtocol === true,
      protocol,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rollbackShieldsDown(
      sandboxName,
      target,
      snapshotPath,
      opts.allowLegacyHermesProtocol === true,
      protocol,
    );
    if (transition) clearShieldsDownTransition(sandboxName, transition.processToken);
    console.error(`  ERROR: ${message}`);
    console.error(
      "  Config did not reach the mutable-default state; the scheduled auto-restore remains authoritative.",
    );
    console.error(
      `  Re-run \`nemoclaw ${sandboxName} shields down\` after correcting file ownership.`,
    );
    return failShieldsCommand(message, opts.throwOnError);
  }

  if (transition) {
    try {
      transition = { ...transition, phase: "active" };
      writeShieldsDownTransition(transition, "preparing");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rollbackShieldsDown(
        sandboxName,
        target,
        snapshotPath,
        opts.allowLegacyHermesProtocol === true,
        protocol,
      );
      clearShieldsDownTransition(sandboxName, transition.processToken);
      console.error(`  ERROR: ${message}`);
      console.error("  Auto-restore handoff failed; lockdown was restored.");
      return failShieldsCommand(message, opts.throwOnError);
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
    console.log(`  Run \`nemoclaw ${sandboxName} shields up\` to opt into lockdown.`);
  }
}

function shieldsDown(sandboxName: string, opts: ShieldsDownOpts = {}): void {
  validateName(sandboxName, "sandbox name");
  const processToken = opts.skipTimer
    ? undefined
    : (opts.processToken ?? randomBytes(16).toString("hex"));
  const effectiveOpts = processToken ? { ...opts, processToken } : opts;
  try {
    return withShieldsTransitionLock(
      sandboxName,
      "shields down",
      () => shieldsDownWithoutHostLock(sandboxName, effectiveOpts),
      processToken ? { takeoverToken: processToken } : {},
    );
  } catch (error) {
    return completeDeferredShieldsExit(error, opts.throwOnError === true);
  }
}

// ---------------------------------------------------------------------------
// shields up — opt into lockdown
//
// Locks config + applies restrictive network policy. This is an opt-in
// hardening step that restricts the sandbox beyond its default state.
// ---------------------------------------------------------------------------

function shieldsUpWithoutHostLock(
  sandboxName: string,
  opts: { throwOnError?: boolean; allowLegacyHermesProtocol?: boolean } = {},
): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  // shieldsDown === false means explicitly locked by a previous shields-up.
  // undefined (no state file) means fresh sandbox — mutable default, allow shields-up.
  if (state.shieldsDown === false) {
    // Verify the sandbox filesystem still matches the locked posture. If a
    // host-root tamper has reverted protected perms or rewritten file
    // content (even when the mode/owner is restored), re-apply the lock
    // so the recovery hint surfaced by `shields status` actually works.
    const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
    const { issues } = verifyShieldsLockState(sandboxName, target, {
      verifyChattr: state.chattrApplied === true,
      verifyParentProtection: target.agentName === "openclaw" || target.agentName === "hermes",
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
    const realHashDrift = hashIssues.filter((entry) => !entry.includes("no seal recorded"));
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
    if (requiresLegacyOptIn && process.env.NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE !== "1") {
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
          const filesToHash = [target.configPath, ...(target.sensitiveFiles || [])];
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
    const protocol = requireHermesShieldsProtocol(
      sandboxName,
      target,
      opts.allowLegacyHermesProtocol === true,
    );
    console.log(`  Lockdown drifted — re-applying lock for ${sandboxName}...`);
    // #4663: re-confirm the lock held after the in-sandbox reconciler settles,
    // re-applying if it reverts perms. A single re-apply here was also being
    // reverted on DGX Station / DGX Spark, leaving the sandbox DRIFTED. This
    // narrows (does not close) the revert window; the chattr +i immutable bit
    // applied inside lockAgentConfig is the only fully durable defense.
    const relock = relockAndReconfirm(() =>
      lockAgentConfig(sandboxName, target, true, opts.allowLegacyHermesProtocol === true, protocol),
    );
    if (!relock.ok || !relock.lastResult) {
      const message = relock.error ?? "Config re-lock did not re-confirm after settle window";
      console.error(`  ERROR: ${message}`);
      console.error("  Config remains drifted — manual intervention required.");
      printManualRelockRecoveryHint(sandboxName);
      return failShieldsCommand(message, opts.throwOnError);
    }
    const lockResult: { chattrApplied: boolean; fileHashes: { [path: string]: string } } =
      relock.lastResult;
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

  // If coming from shields-down, validate the saved policy snapshot before
  // any mutation. A fresh sandbox has no prior snapshot and is already on its
  // restrictive baseline.
  //    If first shields-up on a fresh sandbox (no prior shields-down),
  //    the current policy is already the restrictive baseline — skip restore.
  const snapshotPath = state.shieldsDown ? state.shieldsPolicySnapshotPath : undefined;
  if (state.shieldsDown && (!snapshotPath || !fs.existsSync(snapshotPath))) {
    console.error("  Cannot restore restrictive policy: saved snapshot is missing.");
    console.error(
      "  Sandbox remains unlocked; recapture shields-down state before running shields up.",
    );
    return failShieldsCommand("Saved policy snapshot is missing", opts.throwOnError);
  }
  const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
  const protocol = requireHermesShieldsProtocol(
    sandboxName,
    target,
    opts.allowLegacyHermesProtocol === true,
  );

  // Keep the auto-restore owner alive through policy restore, config locking,
  // and the final UP state commit. Manual shields-up and the timer are both
  // monotonic hardening paths; revoking the timer earlier would turn a failed
  // manual/rebuild relock into an unbounded mutable window.
  const timerMarker = readTimerMarker(sandboxName);

  let snapshotLockResult: {
    chattrApplied: boolean;
    fileHashes: { [path: string]: string };
  } | null = null;
  if (snapshotPath) {
    console.log("  Restoring restrictive policy from snapshot...");
    const activation = activateLockdownFromSnapshot(
      sandboxName,
      snapshotPath,
      opts.allowLegacyHermesProtocol === true,
      target,
      protocol,
    );
    if (!activation.ok) {
      console.error(`  ERROR: ${activation.error ?? "unknown restore error"}`);
      console.error("  Config remains unlocked — manual intervention required.");
      printManualRelockRecoveryHint(sandboxName);
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
    //     Uses the registry-scoped privileged sandbox exec to bypass Landlock.
    //     Each operation runs independently and the result is verified.
    //     If verification fails, config remains unlocked — we do not lie about state.
    console.log(`  Locking ${target.agentName} config (${target.configPath})...`);
    let lockResult: { chattrApplied: boolean; fileHashes: { [path: string]: string } };
    try {
      lockResult = lockAgentConfig(
        sandboxName,
        target,
        false,
        opts.allowLegacyHermesProtocol === true,
        protocol,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${message}`);
      console.error("  Config remains unlocked — manual intervention required.");
      printManualRelockRecoveryHint(sandboxName);
      return failShieldsCommand(message, opts.throwOnError);
    }
    saveShieldsState(sandboxName, {
      chattrApplied: lockResult.chattrApplied,
      fileHashes: lockResult.fileHashes,
    });
  }

  // 3. Calculate duration
  const downAt = state.shieldsDownAt ? new Date(state.shieldsDownAt) : new Date();
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
  killTimer(sandboxName);
  if (timerMarker?.processToken && /^[0-9a-f]{32}$/.test(timerMarker.processToken)) {
    clearShieldsDownTransition(sandboxName, timerMarker.processToken);
  }

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

function shieldsUp(
  sandboxName: string,
  opts: { throwOnError?: boolean; allowLegacyHermesProtocol?: boolean } = {},
): void {
  validateName(sandboxName, "sandbox name");
  try {
    return withTimerBoundShieldsMutationLock(sandboxName, "shields up", () =>
      shieldsUpWithoutHostLock(sandboxName, opts),
    );
  } catch (error) {
    return completeDeferredShieldsExit(error, opts.throwOnError === true);
  }
}

// ---------------------------------------------------------------------------
// shields status
// ---------------------------------------------------------------------------

type ShieldsStatusDeps = {
  verifyLockState?: typeof verifyShieldsLockState;
  resolveConfig?: typeof resolveAgentConfig;
};

function shieldsStatusWithoutHostLock(
  sandboxName: string,
  allowInlineRecovery = true,
  deps: ShieldsStatusDeps = {},
): void {
  validateName(sandboxName, "sandbox name");

  const verify = deps.verifyLockState ?? verifyShieldsLockState;
  const resolveConfig = deps.resolveConfig ?? resolveAgentConfig;

  const posture = getShieldsPostureWithoutHostLock(sandboxName, allowInlineRecovery);
  const { state } = posture;
  if (state._isCorrupt) {
    console.error("  Shields: ERROR (state file is corrupt)");
    console.error(
      `  ${stateFilePath(sandboxName)} could not be parsed: ${state._corruptError ?? "unknown error"}`,
    );
    console.error(
      `  Recovery warning: run \`nemoclaw ${sandboxName} shields up\` to restore a known-good state.`,
    );
    throw new DeferredShieldsExit("Shields state is corrupt", 1);
  }

  switch (posture.mode) {
    case "mutable_default":
      // NC-2227-02: Fresh sandbox with no shields history — do NOT claim locked
      console.log(`  Shields: ${posture.statusText}`);
      console.log("  Config is mutable. Run `nemoclaw <sandbox> shields up` to opt into lockdown.");
      return;

    case "locked": {
      // Cross-check the sandbox filesystem so a host-root tamper that reverts
      // protected perms back to a sandbox-writable state is surfaced as drift
      // instead of reported as a clean lockdown.
      let driftIssues: string[] = [];
      try {
        const target = ensureConfigHashSensitiveFile(resolveConfig(sandboxName));
        driftIssues = verify(sandboxName, target, {
          verifyChattr: state.chattrApplied === true,
          verifyParentProtection: target.agentName === "openclaw" || target.agentName === "hermes",
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
        console.error("  Shields: UP (DRIFTED — declared locked but sandbox filesystem differs)");
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
        const hashIssues = driftIssues.filter(isHashVerificationIssue);
        const realHashDrift = hashIssues.filter((entry) => !entry.includes("no seal recorded"));
        const hasMissingSeals = hashIssues.length > realHashDrift.length;
        const recoveryLines =
          realHashDrift.length > 0
            ? [
                `  Recovery: restore the original file content from a trusted source, or rebuild the sandbox, then run \`nemoclaw ${sandboxName} shields up\` to re-seal.`,
              ]
            : hasMissingSeals
              ? [
                  "  Recovery: rebuild the sandbox for a known-good baseline,",
                  `  or set NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE=1 and re-run \`nemoclaw ${sandboxName} shields up\` to seal the current bytes.`,
                ]
              : [`  Recovery: nemoclaw ${sandboxName} shields up   # re-lock and re-verify`];
        for (const line of recoveryLines) {
          console.error(line);
        }
        throw new DeferredShieldsExit("Locked shields state has filesystem drift", 2);
      }
      if (!state.fileHashes) {
        // Legacy state file pre-dates the content seal. Perm-only
        // verification cannot prove the locked bytes were not already
        // tampered before the upgrade, so we cannot honestly call this
        // a clean lockdown. Surface integrity-unknown and exit with
        // status 2 (same code as drifted) so scripts treat it as a
        // failure until the operator seals an explicit baseline.
        console.error("  Shields: UP (UNSEALED — content integrity unknown for legacy lockdown)");
        console.error(policyLine);
        if (state.shieldsDownAt) {
          console.error(`  Last unlocked: ${state.shieldsDownAt}`);
        }
        console.error("  Recovery: rebuild the sandbox for a known-good baseline,");
        console.error(
          `  or set NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE=1 and re-run \`nemoclaw ${sandboxName} shields up\` to seal the current bytes.`,
        );
        throw new DeferredShieldsExit("Locked shields state has no content seal", 2);
      }
      console.log(`  Shields: ${posture.statusText}`);
      console.log(policyLine);
      if (state.shieldsDownAt) {
        console.log(`  Last unlocked: ${state.shieldsDownAt}`);
      }
      return;
    }

    case "temporarily_unlocked": {
      const downSince = state.shieldsDownAt ? new Date(state.shieldsDownAt) : null;
      const elapsed = downSince ? Math.floor((Date.now() - downSince.getTime()) / 1000) : 0;
      const remaining =
        state.shieldsDownTimeout != null ? Math.max(0, state.shieldsDownTimeout - elapsed) : null;

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

function shieldsStatus(
  sandboxName: string,
  allowInlineRecovery = true,
  deps: ShieldsStatusDeps = {},
): void {
  validateName(sandboxName, "sandbox name");
  try {
    if (!allowInlineRecovery) {
      return withShieldsTransitionLock(sandboxName, "shields status", () =>
        shieldsStatusWithoutHostLock(sandboxName, false, deps),
      );
    }
    prepareExpiredAutoRestoreHostLockTakeover(sandboxName);
    return withTimerBoundShieldsMutationLock(sandboxName, "shields status", () =>
      shieldsStatusWithoutHostLock(sandboxName, true, deps),
    );
  } catch (error) {
    return completeDeferredShieldsExit(error);
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
  const state = allowInlineRecovery
    ? getShieldsPosture(sandboxName, true).state
    : recoverExpiredAutoRestoreGate(sandboxName, false);
  if (state._isCorrupt) return false;
  const mode = deriveShieldsMode(state, state._hasStateFile);
  return mode !== "locked";
}

/**
 * Remove the local shields state for a sandbox, returning it to the
 * `mutable_default` posture. Used by stale-sandbox rebuild recovery (#4497):
 * the live sandbox is gone, so the recorded lock seal/file-hashes no longer
 * correspond to any live image. Clearing the state prevents a stale seal from
 * blocking a fresh `shields up` and stops a freshly recreated (mutable) sandbox
 * from being reported as locked. Best-effort: a missing state file is fine.
 */
function clearShieldsStateWithoutHostLock(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");
  const timerMarker = readTimerMarker(sandboxName);
  killTimer(sandboxName);
  if (timerMarker?.processToken && /^[0-9a-f]{32}$/.test(timerMarker.processToken)) {
    clearShieldsDownTransition(sandboxName, timerMarker.processToken);
  }
  try {
    fs.rmSync(stateFilePath(sandboxName), { force: true });
  } catch {
    /* best effort — absent or unreadable state is already mutable_default */
  }
}

function clearShieldsState(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");
  return withShieldsTransitionLock(sandboxName, "clear shields state", () =>
    clearShieldsStateWithoutHostLock(sandboxName),
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  clearShieldsState,
  DEFAULT_TIMEOUT_SECONDS,
  deriveShieldsMode,
  excludeRecoveryProcessTree,
  getShieldsPosture,
  inspectMutableConfigPerms,
  isShieldsDown,
  killTimer,
  lockAgentConfig,
  MAX_TIMEOUT_SECONDS,
  parseDuration,
  prepareAutoRestoreTransitionTakeover,
  repairMutableConfigPerms,
  shieldsDown,
  shieldsStatus,
  shieldsUp,
  supportsHermesSealedShieldsTransactions,
  synchronizeAutoRestoreWithShieldsDown,
  unlockAgentConfig,
};
