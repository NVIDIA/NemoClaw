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

import { run, runCapture, validateName } from "../runner";

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { createHash, randomBytes } = require("crypto");
const { CLI_NAME }: typeof import("../cli/branding") = require("../cli/branding");
const { isObjectRecord }: typeof import("../core/json-types") = require("../core/json-types");
const {
  dockerExecFileSync,
  dockerSpawnSync,
}: typeof import("../adapters/docker/exec") = require("../adapters/docker/exec");
const {
  isDirectSandboxFallbackUnavailableError,
  privilegedSandboxExecArgv,
  withPrivilegedSandboxExecutionLease,
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
  hasExactTimerAuthorizationProof,
  isProcessAlive,
  readProcessStartIdentity,
  processInspectionDeadlineAfter,
  processInspectionDeadlineReached,
  verifyTimerMarkerIdentity,
  killTimer,
} = require("./timer-control");
const { appendAuditEntry } = require("./audit");
const {
  resolveAgentConfig,
  resolveRegisteredSandboxAgentAuthority,
  resolveAgentStateLockContract,
}: typeof import("../sandbox/agent-config") = require("../sandbox/agent-config");
const {
  assertLegacyMcpPolicyRestoreSafe,
  buildDeadlineRuntimeManagedMcpPolicy,
  buildRuntimeManagedMcpPolicy,
  buildRuntimePermissivePolicy,
  hasManagedMcpPolicyClaims,
  inspectExactManagedMcpPolicies,
  inspectProvableManagedMcpPoliciesForDeadline,
}: typeof import("./permissive-runtime") = require("./permissive-runtime");
const { cleanupTempDir } = require("../onboard/temp-files");
const { verifyShieldsLockState }: typeof import("./verify-lock") = require("./verify-lock");
const {
  relockAndReconfirm,
  waitForHermesInferenceRouteConvergence,
}: typeof import("./relock-reconfirm") = require("./relock-reconfirm");
const {
  inspectAnyShieldsTransitionLockOwner,
  isShieldsTransitionLockUnavailable,
  resolveShieldsStateDir,
  withShieldsTransitionLock,
}: typeof import("./transition-lock") = require("./transition-lock");
const {
  beginCommittedMcpLifecycleContainmentSync,
  getMcpLifecycleLockPath,
  isMcpLifecycleLockHeld,
  durableMcpLifecycleContainmentFailure,
  withMcpLifecycleDeadlineFenceSync,
  withMcpLifecycleLockSync,
  withTimerBoundAutoRestoreLock,
  withTimerBoundShieldsMutationLock,
  withTimerBoundShieldsMutationLockFallback,
}: typeof import("./timer-bound-lock") = require("./timer-bound-lock");
const {
  buildConfigHashRepairCommand,
  buildDeepAgentsConfigLockCommand,
  DEEP_AGENTS_CONFIG_LOCK_ERROR_PROTOCOL_PREFIX,
  parseSha256Output,
  isHashVerificationIssue,
  isSha256Hex,
}: typeof import("./seal") = require("./seal");
const {
  applyStateDirLockMode,
  preflightStateDirLock,
  restoreStateDirLockPosture,
  restoreStateDirStartupAccess,
  stateLockPlanCompatibilityIssues,
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
const {
  HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_PATH,
  hasActiveHermesRuntimeProviderStateMutation,
  runHermesRuntimeProviderStateMutation,
  supportsHermesRuntimeProviderStateMutation,
}: typeof import("./hermes-runtime-state-mutation") = require("./hermes-runtime-state-mutation");
type MutableConfigPermsInspection = import("./mutable-config-perms").MutableConfigPermsInspection;
type MutableConfigRepairResult = import("./mutable-config-perms").MutableConfigRepairResult;
type AgentStateLockPlan = import("../agent/definition-types").AgentStateLockPlan;
type ManagedMcpPolicyOmission = import("./permissive-runtime").ManagedMcpPolicyOmission;
type TimerMarker = import("./timer-control").TimerMarker;
const STATE_DIR = resolveShieldsStateDir();
const SHIELDS_TRANSITION_POLL_MS = 50;
const SHIELDS_TRANSITION_HANDOFF_GRACE_MS = 500;
const SHIELDS_TRANSITION_TERMINATE_GRACE_MS = 1000;
const SHIELDS_TIMER_START_IDENTITY_WAIT_MS = 1000;
const SHIELDS_TIMER_AUTHORIZATION_WAIT_MS = 5000;
const INTERACTIVE_CONTAINMENT_COMMIT_MAX_ATTEMPTS =
  Math.floor(SHIELDS_TRANSITION_HANDOFF_GRACE_MS / SHIELDS_TRANSITION_POLL_MS) + 1;
const AUTO_RESTORE_COMPLETION_GRACE_MS = 30_000;
// Retry on the detached timer's cadence for one additional completion-grace
// window before converting the live deadline fence into durable containment.
const INTERACTIVE_AUTO_RESTORE_RETRY_MS = 5_000;
const INTERACTIVE_AUTO_RESTORE_MAX_ATTEMPTS =
  Math.floor(AUTO_RESTORE_COMPLETION_GRACE_MS / INTERACTIVE_AUTO_RESTORE_RETRY_MS) + 1;
const HERMES_RUNTIME_CONFIG_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const HERMES_RESTART_SEAL_STATE = "/run/nemoclaw/hermes-restart-seal.json";
const HERMES_CONFIG_HASH = "/etc/nemoclaw/hermes.config-hash";
const HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_PROBE = [
  "import os",
  "import sys",
  "try:",
  "    os.lstat(sys.argv[1])",
  "except FileNotFoundError:",
  '    print("absent")',
  "else:",
  '    print("present")',
].join("\n");
const STATE_DIR_GUARD_TIMEOUT_MS = 15 * 60 * 1000;
const OPENCLAW_CONFIG_GUARD_TIMEOUT_MS = 6 * 60 * 1000;
// Exceeds the failed-startup guard's 25-minute in-container timeout and its
// five-second termination grace, so the host never abandons a live recovery.
const OPENCLAW_CONFIG_GUARD_RECOVERY_TIMEOUT_MS = 26 * 60 * 1000;
const HERMES_CONFIG_GUARD_TIMEOUT_MS = 11 * 60 * 1000;
const MAX_SHIELDS_FORWARD_POLICY_BYTES = 16 * 1024 * 1024;

type ShieldsDownForwardPolicy = {
  schemaVersion: 1;
  path: string;
  sha256: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: 1;
};

type ShieldsDownTransition = {
  version: 1;
  phase: "preparing" | "active" | "policy_rejected";
  ownerPid: number;
  ownerStartIdentity: string;
  processToken: string;
  sandboxName: string;
  snapshotPath: string;
  /** Exact generated MCP keys owned when snapshotPath was captured. */
  managedMcpPolicyKeys?: string[];
  /** Durable exact policy replay authority for interrupted forward recovery. */
  forwardPolicy?: ShieldsDownForwardPolicy;
};

const transitionPollBuffer = new Int32Array(new SharedArrayBuffer(4));

function sameTimerMarkerGeneration(current: TimerMarker | null, expected: TimerMarker): boolean {
  return (
    current?.pid === expected.pid &&
    current.sandboxName === expected.sandboxName &&
    current.snapshotPath === expected.snapshotPath &&
    current.restoreAt === expected.restoreAt &&
    current.processToken === expected.processToken &&
    current.timerProcessStartIdentity === expected.timerProcessStartIdentity &&
    current.allowLegacyHermesProtocol === expected.allowLegacyHermesProtocol &&
    current.agentName === expected.agentName &&
    current.configPath === expected.configPath &&
    current.configDir === expected.configDir &&
    current.leaseOwnerPid === expected.leaseOwnerPid &&
    current.leaseOwnerStartIdentity === expected.leaseOwnerStartIdentity
  );
}

function assertTimerMarkerGeneration(sandboxName: string, expected: TimerMarker): void {
  if (!sameTimerMarkerGeneration(readTimerMarker(sandboxName), expected)) {
    throw new Error("Auto-restore authority changed before Shields transition takeover");
  }
}

function isExactLiveFutureTimerAuthority(marker: TimerMarker, now = Date.now()): boolean {
  const restoreAtMs = new Date(marker.restoreAt).getTime();
  if (!Number.isFinite(restoreAtMs) || restoreAtMs <= now || !marker.timerProcessStartIdentity) {
    return false;
  }
  const deadline = processInspectionDeadlineAfter(SHIELDS_TRANSITION_TERMINATE_GRACE_MS);
  return (
    isProcessAlive(marker.pid, deadline) &&
    readProcessStartIdentity(marker.pid, deadline) === marker.timerProcessStartIdentity &&
    verifyTimerMarkerIdentity(marker).verified &&
    hasExactTimerAuthorizationProof(marker)
  );
}

function assertExactLiveFutureTimerAuthority(sandboxName: string, marker: TimerMarker): void {
  assertTimerMarkerGeneration(sandboxName, marker);
  if (!isExactLiveFutureTimerAuthority(marker)) {
    throw new Error(
      "Interrupted Hermes Shields down recovery has no exact live future auto-restore timer authority",
    );
  }
  assertTimerMarkerGeneration(sandboxName, marker);
}

function waitForTimerProcessStartIdentity(pid: number): string | null {
  const deadline = Date.now() + SHIELDS_TIMER_START_IDENTITY_WAIT_MS;
  while (true) {
    const identity = readProcessStartIdentity(pid);
    if (identity) return identity;
    if (Date.now() >= deadline || !isProcessAlive(pid)) return null;
    Atomics.wait(transitionPollBuffer, 0, 0, SHIELDS_TRANSITION_POLL_MS);
  }
}

function waitForTimerAuthorizationProof(marker: TimerMarker): boolean {
  const deadline = Date.now() + SHIELDS_TIMER_AUTHORIZATION_WAIT_MS;
  while (true) {
    if (hasExactTimerAuthorizationProof(marker)) return true;
    if (
      Date.now() >= deadline ||
      !isProcessAlive(marker.pid) ||
      readProcessStartIdentity(marker.pid) !== marker.timerProcessStartIdentity
    ) {
      return false;
    }
    Atomics.wait(transitionPollBuffer, 0, 0, SHIELDS_TRANSITION_POLL_MS);
  }
}

function appendAuditEntryBestEffort(entry: Parameters<typeof appendAuditEntry>[0]): void {
  try {
    appendAuditEntry(entry);
  } catch {
    // A failed diagnostic write must not release an active recovery gate.
  }
}

function shieldsDownTransitionPath(sandboxName: string, processToken: string): string {
  return path.join(STATE_DIR, `shields-transition-${sandboxName}-${processToken}.json`);
}

function shieldsDownForwardPolicyPath(sandboxName: string, processToken: string): string {
  return path.join(STATE_DIR, `shields-forward-policy-${sandboxName}-${processToken}.yaml`);
}

function isShieldsDownForwardPolicy(value: unknown): value is ShieldsDownForwardPolicy {
  if (!isObjectRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    value.size <= MAX_SHIELDS_FORWARD_POLICY_BYTES &&
    value.mode === 0o600 &&
    typeof value.uid === "number" &&
    Number.isSafeInteger(value.uid) &&
    value.uid >= 0 &&
    typeof value.gid === "number" &&
    Number.isSafeInteger(value.gid) &&
    value.gid >= 0 &&
    value.nlink === 1
  );
}

function isShieldsDownTransition(value: unknown): value is ShieldsDownTransition {
  if (!isObjectRecord(value)) return false;
  return (
    value.version === 1 &&
    (value.phase === "preparing" ||
      value.phase === "active" ||
      value.phase === "policy_rejected") &&
    typeof value.ownerPid === "number" &&
    Number.isInteger(value.ownerPid) &&
    value.ownerPid > 0 &&
    typeof value.ownerStartIdentity === "string" &&
    value.ownerStartIdentity.length > 0 &&
    typeof value.processToken === "string" &&
    /^[0-9a-f]{32}$/.test(value.processToken) &&
    typeof value.sandboxName === "string" &&
    typeof value.snapshotPath === "string" &&
    isOptionalManagedMcpPolicyKeys(value.managedMcpPolicyKeys) &&
    (value.forwardPolicy === undefined || isShieldsDownForwardPolicy(value.forwardPolicy))
  );
}

function sameManagedMcpPolicyKeys(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function sameShieldsDownForwardPolicy(
  left: ShieldsDownForwardPolicy | undefined,
  right: ShieldsDownForwardPolicy | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function sameShieldsDownTransitionAuthority(
  left: ShieldsDownTransition,
  right: ShieldsDownTransition,
  phase: ShieldsDownTransition["phase"] = right.phase,
): boolean {
  return (
    left.version === right.version &&
    left.phase === phase &&
    left.ownerPid === right.ownerPid &&
    left.ownerStartIdentity === right.ownerStartIdentity &&
    left.processToken === right.processToken &&
    left.sandboxName === right.sandboxName &&
    left.snapshotPath === right.snapshotPath &&
    sameManagedMcpPolicyKeys(left.managedMcpPolicyKeys, right.managedMcpPolicyKeys) &&
    sameShieldsDownForwardPolicy(left.forwardPolicy, right.forwardPolicy)
  );
}

function fsyncShieldsStateDirectory(): void {
  const directoryFd = fs.openSync(STATE_DIR, "r");
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function writeShieldsFileAtomicDurable(
  filePath: string,
  content: string | Buffer,
  mode = 0o600,
  replaceExisting = true,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    );
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (replaceExisting) {
      fs.renameSync(tempPath, filePath);
    } else {
      fs.linkSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    }
    const directoryFd = fs.openSync(path.dirname(filePath), "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}

function publishShieldsDownForwardPolicy(
  sandboxName: string,
  processToken: string,
  sourcePath: string,
): ShieldsDownForwardPolicy {
  const content = fs.readFileSync(sourcePath);
  if (content.length === 0 || content.length > MAX_SHIELDS_FORWARD_POLICY_BYTES) {
    throw new Error(
      `Shields-down forward policy must contain 1-${String(MAX_SHIELDS_FORWARD_POLICY_BYTES)} bytes`,
    );
  }
  const artifactPath = shieldsDownForwardPolicyPath(sandboxName, processToken);
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(artifactPath, flags, 0o600);
    created = true;
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("Shields-down forward policy was published with unsafe metadata");
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (metadata.uid !== currentUid) {
      throw new Error("Shields-down forward policy is not owned by the current host identity");
    }
    fs.closeSync(fd);
    fd = undefined;
    fsyncShieldsStateDirectory();
    return Object.freeze({
      schemaVersion: 1,
      path: artifactPath,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.length,
      mode: 0o600,
      uid: metadata.uid,
      gid: metadata.gid,
      nlink: 1,
    });
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.rmSync(artifactPath, { force: true });
    throw error;
  }
}

function requireShieldsDownForwardPolicy(transition: ShieldsDownTransition): string {
  const binding = transition.forwardPolicy;
  const expectedPath = shieldsDownForwardPolicyPath(
    transition.sandboxName,
    transition.processToken,
  );
  if (!binding || binding.path !== expectedPath || path.normalize(binding.path) !== binding.path) {
    throw new Error(
      "Interrupted Shields down recovery is missing its exact forward-policy authority",
    );
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      binding.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== binding.nlink ||
      (before.mode & 0o777) !== binding.mode ||
      before.uid !== binding.uid ||
      before.gid !== binding.gid ||
      before.size !== binding.size ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      throw new Error("Interrupted Shields down forward policy has unsafe metadata");
    }
    const content = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.length !== binding.size ||
      createHash("sha256").update(content).digest("hex") !== binding.sha256
    ) {
      throw new Error("Interrupted Shields down forward policy no longer matches its binding");
    }
    return binding.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot validate interrupted Shields down forward policy: ${message}`, {
      cause: error,
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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

function readTimerBoundShieldsDownTransition(sandboxName: string): ShieldsDownTransition | null {
  const marker = readTimerMarker(sandboxName);
  if (!marker?.processToken || !/^[0-9a-f]{32}$/.test(marker.processToken)) return null;
  const transition = readShieldsDownTransition(sandboxName, marker.processToken);
  return transition?.snapshotPath === marker.snapshotPath ? transition : null;
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
      current.ownerStartIdentity !== transition.ownerStartIdentity ||
      current.snapshotPath !== transition.snapshotPath ||
      !sameManagedMcpPolicyKeys(current.managedMcpPolicyKeys, transition.managedMcpPolicyKeys) ||
      !sameShieldsDownForwardPolicy(current.forwardPolicy, transition.forwardPolicy)
    ) {
      throw new Error("Shields-down recovery ownership changed during the transition");
    }
  }

  const tempPath = `${transitionPath}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
  let tempFd: number | undefined;
  try {
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(tempFd, JSON.stringify(transition));
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
    fs.renameSync(tempPath, transitionPath);
    fsyncShieldsStateDirectory();
  } finally {
    if (tempFd !== undefined) fs.closeSync(tempFd);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort. The authoritative path was either atomically replaced or unchanged.
    }
  }
}

function writeTimerMarkerAtomic(sandboxName: string, marker: TimerMarker): void {
  writeShieldsFileAtomicDurable(timerMarkerPath(sandboxName), JSON.stringify(marker));
}

function clearShieldsDownTransition(sandboxName: string, processToken: string): void {
  let removed = false;
  try {
    fs.rmSync(shieldsDownTransitionPath(sandboxName, processToken), { force: true });
    removed = true;
  } catch {
    // Best effort. A stale transition marker never grants mutation authority.
  }
  try {
    fs.rmSync(shieldsDownForwardPolicyPath(sandboxName, processToken), { force: true });
    removed = true;
  } catch {
    // Best effort. The deterministic artifact path cannot grant authority alone.
  }
  if (removed) {
    try {
      fsyncShieldsStateDirectory();
    } catch {
      // Best effort. Neither retired path can grant recovery authority alone.
    }
  }
}

type ExactProcessStatus = "current" | "gone" | "unknown";

function processCanBeSignaled(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readExactProcessStatus(
  pid: number,
  startIdentity: string,
  deadline: number,
): ExactProcessStatus {
  const alive = processCanBeSignaled(pid);
  const observedStartIdentity = readProcessStartIdentity(pid, deadline);
  if (observedStartIdentity === null) return alive ? "unknown" : "gone";
  if (observedStartIdentity !== startIdentity) return "gone";
  return alive ? "current" : "gone";
}

function persistUnresolvedShieldsContainment(
  sandboxName: string,
  processToken: string,
  reason: string,
  assertTakeoverAuthority?: () => void,
): void {
  const containmentPath = `${getMcpLifecycleLockPath(sandboxName, STATE_DIR)}.containment`;
  if (fs.existsSync(containmentPath)) return;
  try {
    beginCommittedMcpLifecycleContainmentSync(
      sandboxName,
      processToken,
      reason,
      STATE_DIR,
      assertTakeoverAuthority,
    );
  } catch (error) {
    if (isDurableContainmentFailure(error)) throw error;
    if (fs.existsSync(containmentPath)) return;
    throw error;
  }
}

function waitForShieldsDownForwardCommit(
  sandboxName: string,
  processToken: string,
  assertTakeoverAuthority?: () => void,
): ShieldsDownTransition | null {
  let observed = readShieldsDownTransition(sandboxName, processToken);
  if (!observed) return null;

  const handoffDeadline = processInspectionDeadlineAfter(SHIELDS_TRANSITION_HANDOFF_GRACE_MS);
  const ownerMayBeCurrent = () =>
    readExactProcessStatus(observed!.ownerPid, observed!.ownerStartIdentity, handoffDeadline) !==
    "gone";
  while (
    observed.phase === "preparing" &&
    !processInspectionDeadlineReached(handoffDeadline) &&
    ownerMayBeCurrent()
  ) {
    Atomics.wait(transitionPollBuffer, 0, 0, SHIELDS_TRANSITION_POLL_MS);
    const next = readShieldsDownTransition(sandboxName, processToken);
    if (!next) return null;
    if (
      next.ownerPid !== observed.ownerPid ||
      next.ownerStartIdentity !== observed.ownerStartIdentity ||
      next.snapshotPath !== observed.snapshotPath ||
      next.processToken !== observed.processToken ||
      !sameManagedMcpPolicyKeys(next.managedMcpPolicyKeys, observed.managedMcpPolicyKeys) ||
      !sameShieldsDownForwardPolicy(next.forwardPolicy, observed.forwardPolicy)
    ) {
      throw new Error("Shields-down recovery ownership changed while waiting for forward commit");
    }
    observed = next;
  }

  if (observed.phase === "preparing") {
    const ownerStatus = readExactProcessStatus(
      observed.ownerPid,
      observed.ownerStartIdentity,
      processInspectionDeadlineAfter(SHIELDS_TRANSITION_TERMINATE_GRACE_MS),
    );
    if (ownerStatus === "gone") {
      assertTakeoverAuthority?.();
      try {
        persistUnresolvedShieldsContainment(
          sandboxName,
          processToken,
          `Shields recovery owner PID ${String(
            observed.ownerPid,
          )} exited without descendant-containment proof`,
          assertTakeoverAuthority,
        );
      } catch (error) {
        if (isDurableContainmentFailure(error)) throw error;
        assertTakeoverAuthority?.();
        throw durableMcpLifecycleContainmentFailure(
          error,
          getMcpLifecycleLockPath(sandboxName, STATE_DIR),
        );
      }
      throw new Error(
        "Shields-down forward owner exited before committing its final mutation; durable containment requires operator resolution",
      );
    }
    throw new Error(
      "Shields-down forward owner is still active; automatic recovery is waiting behind the deadline gate",
    );
  }
  return observed;
}

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
  withPrivilegedSandboxExecutionLease(sandboxName, "shields privileged execution", () => {
    dockerExecFileSync(privilegedSandboxExecArgv(sandboxName, cmd, false, true), {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
  });
}

function privilegedSandboxExecCapture(sandboxName: string, cmd: string[], timeout = 15000): string {
  return withPrivilegedSandboxExecutionLease(sandboxName, "shields privileged capture", () =>
    dockerExecFileSync(privilegedSandboxExecArgv(sandboxName, cmd, false, true), {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    }).trim(),
  );
}

// Reject unsafe config paths before Shields down weakens policy or persists a
// provisional DOWN record. A symlink planted after shields up is refused by the
// unlock path, but without this preflight the provisional DOWN/permissive
// status survives when re-lock also fails on the same path (#8804).
const SHIELDS_DOWN_CONFIG_PATH_PREFLIGHT_SCRIPT = String.raw`
# nemoclaw-shields-down-path-preflight
import errno
import os
import stat
import sys

def die(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(1)

def open_nofollow(path, want_dir):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if want_dir:
        flags |= getattr(os, "O_DIRECTORY", 0)
    else:
        flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        return os.open(path, flags)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, getattr(errno, "ENOTDIR", errno.EINVAL)):
            die("refusing symlink path: " + path)
        if exc.errno == errno.ENOENT:
            die("missing config path: " + path)
        die("open failed for %s: %s" % (path, exc))

config_dir = sys.argv[1]
files = sys.argv[2:]
dir_fd = open_nofollow(config_dir, True)
try:
    mode = os.fstat(dir_fd).st_mode
    if not stat.S_ISDIR(mode):
        die("refusing non-directory config path: " + config_dir)
finally:
    os.close(dir_fd)
for path in files:
    fd = open_nofollow(path, False)
    try:
        mode = os.fstat(fd).st_mode
        if not stat.S_ISREG(mode):
            die("refusing non-regular config path: " + path)
    finally:
        os.close(fd)
`;

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr =
    "stderr" in error && error.stderr != null
      ? Buffer.isBuffer(error.stderr)
        ? error.stderr.toString("utf8")
        : String(error.stderr)
      : "";
  return `${error.message}\n${stderr}`.trim();
}

function isUnsafeShieldsConfigPathError(error: unknown): boolean {
  const message = errorText(error);
  return (
    /refusing (?:to follow )?symlink(?: path)?/i.test(message) ||
    /refusing non-(?:regular|directory) config path/i.test(message) ||
    /refusing unsafe(?:-| )(?:config|sealed|Hermes).*path/i.test(message) ||
    /canonical config path is not a safe regular file/i.test(message) ||
    /missing config path:/i.test(message)
  );
}

function assertShieldsDownConfigPathsSafe(sandboxName: string, target: AgentConfigTarget): void {
  const files = [target.configPath, ...(target.sensitiveFiles || [])];
  try {
    privilegedSandboxExecCapture(sandboxName, [
      "python3",
      "-I",
      "-c",
      SHIELDS_DOWN_CONFIG_PATH_PREFLIGHT_SCRIPT,
      target.configDir,
      ...files,
    ]);
  } catch (error) {
    const message = errorText(error);
    const refusal = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => isUnsafeShieldsConfigPathError(line));
    if (refusal) {
      throw new Error(refusal);
    }
    throw new Error(`Unsafe Shields config path check failed: ${message}`);
  }
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

type HermesShieldsProtocol =
  | "provider-state-mutation-v2"
  | "sealed-plan-v1"
  | "sealed-v1"
  | "legacy";

const HERMES_SEALED_V1_CONTRACT = [
  "begin-shields-transition",
  "run-state-dir-transition",
  "apply-shields-transition",
  "finish-shields-transition",
  "prepare-shields-abort",
  "abort-shields-transition",
  "--rollback-shields-mode",
] as const;
const HERMES_SEALED_PLAN_V1_CONTRACT = [
  ...HERMES_SEALED_V1_CONTRACT,
  "--state-lock-plan-json",
] as const;
const HERMES_LEGACY_GUARD_CONTRACT = [
  "ensure-api-key",
  "refresh-hashes",
  "provider-placeholders",
] as const;

function hasActiveRuntimeProviderStateMutation(sandboxName: string): boolean {
  return hasActiveHermesRuntimeProviderStateMutation(sandboxName, STATE_DIR);
}

/**
 * Drain retained provider authority before a Shields command can return from
 * persisted state or invoke an ordinary privileged container command. The
 * full same-locked transition first recovers the retained plan to its
 * fail-closed rollback, then republishes and verifies the complete recursive
 * locked plan before releasing the new fence.
 */
function resolveActiveHermesRuntimeProviderMutationTarget(
  sandboxName: string,
): AgentConfigTarget | null {
  if (!hasActiveRuntimeProviderStateMutation(sandboxName)) return null;
  const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
  if (target.agentName !== "hermes") {
    throw new Error(
      "An active runtime-provider state mutation no longer matches the Hermes sandbox registry authority",
    );
  }
  return target;
}

function recoverActiveHermesRuntimeProviderMutation(sandboxName: string): AgentConfigTarget | null {
  const target = resolveActiveHermesRuntimeProviderMutationTarget(sandboxName);
  if (!target) return null;
  runHermesProviderProtectionTransition(sandboxName, target, "locked", "locked");
  return target;
}

function inspectHermesShieldsProtocol(
  sandboxName: string,
  target: AgentConfigTarget,
): HermesShieldsProtocol {
  if (target.agentName !== "hermes") return "sealed-plan-v1";
  const { sandbox } = resolveRegisteredSandboxAgentAuthority(sandboxName);
  if (!sandbox || sandbox.agent !== "hermes") {
    throw new Error("Hermes shields protocol inspection lost its exact sandbox registry authority");
  }
  if (hasActiveRuntimeProviderStateMutation(sandboxName)) {
    return "provider-state-mutation-v2";
  }
  if (
    sandbox.openshellDriver?.trim().toLowerCase() === "docker" &&
    sandbox.workload?.kind === "managed-image" &&
    !sandbox.lifecycleGeneration
  ) {
    throw new Error("Managed Hermes Docker registry authority has no lifecycle generation");
  }
  if (
    sandbox.openshellDriver?.trim().toLowerCase() === "docker" &&
    sandbox.workload?.kind === "managed-image" &&
    sandbox.lifecycleGeneration
  ) {
    const capabilityPresence = privilegedSandboxExecCapture(sandboxName, [
      HERMES_PYTHON,
      "-I",
      "-c",
      HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_PROBE,
      HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_PATH,
    ]);
    if (capabilityPresence === "present") {
      const metadata = privilegedSandboxExecCapture(sandboxName, [
        "stat",
        "-c",
        "%a %u %g %h %F",
        HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_PATH,
      ]);
      const content = privilegedSandboxExecCapture(sandboxName, [
        "cat",
        HERMES_RUNTIME_STATE_MUTATION_CAPABILITY_PATH,
      ]);
      if (supportsHermesRuntimeProviderStateMutation(sandbox, { content, metadata })) {
        return "provider-state-mutation-v2";
      }
      throw new Error(
        "Hermes runtime state-mutation capability is present but invalid or unsupported; rebuild the sandbox",
      );
    }
    if (capabilityPresence !== "absent") {
      throw new Error(
        `Unexpected Hermes runtime state-mutation capability probe response: ${capabilityPresence}`,
      );
    }
    // A successful lstat probe proved the old image has no provider publisher
    // capability. Only that exact absence may select its sealed-plan protocol.
  }
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
  if (HERMES_SEALED_PLAN_V1_CONTRACT.every((entry) => help.includes(entry))) {
    return "sealed-plan-v1";
  }
  if (HERMES_SEALED_V1_CONTRACT.every((entry) => help.includes(entry))) {
    return "sealed-v1";
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
  return inspectHermesShieldsProtocol(sandboxName, target) !== "legacy";
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
  protocol: HermesShieldsProtocol,
): void {
  const planArgs =
    protocol === "sealed-plan-v1"
      ? ["--state-lock-plan-json", JSON.stringify(requireStateLockPlan(target))]
      : [];
  privilegedSandboxExec(
    sandboxName,
    hermesShieldsGuardArgs(
      "run-state-dir-transition",
      target,
      ["--state-action", action, ...planArgs, "--lock-token", token],
      "13m",
    ),
    STATE_DIR_GUARD_TIMEOUT_MS,
  );
}

function requireHermesRuntimeProviderSandbox(sandboxName: string) {
  const { sandbox } = resolveRegisteredSandboxAgentAuthority(sandboxName);
  if (
    !sandbox ||
    sandbox.agent !== "hermes" ||
    sandbox.openshellDriver?.trim().toLowerCase() !== "docker" ||
    sandbox.workload?.kind !== "managed-image" ||
    !sandbox.lifecycleGeneration
  ) {
    throw new Error(
      "Hermes runtime-provider state mutation lost its exact managed Docker registry authority",
    );
  }
  return sandbox;
}

function runHermesProviderProtectionTransition(
  sandboxName: string,
  configTarget: AgentConfigTarget,
  targetPosture: "locked" | "mutable",
  rollback: "locked" | "mutable",
): void {
  runHermesRuntimeProviderStateMutation({
    environment: process.env,
    sandbox: requireHermesRuntimeProviderSandbox(sandboxName),
    sandboxName,
    configTarget,
    target: targetPosture,
    rollback,
  });
}

function verifyHermesProviderMutablePosture(sandboxName: string, target: AgentConfigTarget): void {
  const issues: string[] = [];
  for (const file of [target.configPath, ...(target.sensitiveFiles || [])]) {
    try {
      const [mode, owner] = privilegedSandboxExecCapture(sandboxName, [
        "stat",
        "-c",
        "%a %U:%G",
        file,
      ]).split(" ");
      if (mode !== "640") issues.push(`${file} mode=${mode} (expected 640)`);
      if (owner !== "sandbox:sandbox") {
        issues.push(`${file} owner=${owner} (expected sandbox:sandbox)`);
      }
      const [flags] = privilegedSandboxExecCapture(sandboxName, ["lsattr", "-d", file])
        .trim()
        .split(/\s+/, 1);
      if (flags.includes("i")) issues.push(`${file} immutable bit still set`);
    } catch (error) {
      issues.push(
        `${file} verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    const [mode, owner] = privilegedSandboxExecCapture(sandboxName, [
      "stat",
      "-c",
      "%a %U:%G",
      target.configDir,
    ]).split(" ");
    if (mode !== "3770") issues.push(`${target.configDir} mode=${mode} (expected 3770)`);
    if (owner !== "sandbox:sandbox") {
      issues.push(`${target.configDir} owner=${owner} (expected sandbox:sandbox)`);
    }
  } catch (error) {
    issues.push(
      `${target.configDir} verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (issues.length > 0) throw new Error(`Config not unlocked: ${issues.join(", ")}`);
}

function hermesProviderChattrApplied(sandboxName: string, target: AgentConfigTarget): boolean {
  try {
    return [target.configPath, ...(target.sensitiveFiles || [])].every((file) => {
      const [flags] = privilegedSandboxExecCapture(sandboxName, ["lsattr", "-d", file])
        .trim()
        .split(/\s+/, 1);
      return flags.includes("i");
    });
  } catch {
    return false;
  }
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
  /** Exact generated MCP keys owned in the restrictive snapshot. */
  shieldsManagedMcpPolicyKeys?: string[];
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
  stateLockPlan?: AgentStateLockPlan;
  stateLockPlanInImage: boolean;
};

function requireStateLockPlan(target: AgentConfigTarget): AgentStateLockPlan {
  const plan = target.stateLockPlan;
  if (!plan || plan.version !== 1) {
    throw new Error(
      `Agent '${target.agentName ?? "unknown"}' does not expose a supported state lock plan`,
    );
  }
  return plan;
}

const DEEP_AGENTS_NAME = "langchain-deepagents-code";
const DEEP_AGENTS_CONFIG_DIR = "/sandbox/.deepagents";
const DEEP_AGENTS_CONFIG_PATH = `${DEEP_AGENTS_CONFIG_DIR}/config.toml`;
const DEEP_AGENTS_CONFIG_HASH_PATH = `${DEEP_AGENTS_CONFIG_DIR}/.config-hash`;

function isDeepAgentsTarget(target: AgentConfigTarget): boolean {
  return target.agentName === DEEP_AGENTS_NAME;
}

function assertCanonicalDeepAgentsTarget(target: AgentConfigTarget): void {
  if (!isDeepAgentsTarget(target)) return;
  const files = [target.configPath, ...(target.sensitiveFiles || [])];
  if (
    target.configDir !== DEEP_AGENTS_CONFIG_DIR ||
    target.configPath !== DEEP_AGENTS_CONFIG_PATH ||
    files.length !== 2 ||
    files[0] !== DEEP_AGENTS_CONFIG_PATH ||
    files[1] !== DEEP_AGENTS_CONFIG_HASH_PATH
  ) {
    throw new Error(
      `Deep Agents shields require the canonical protected-file set under ${DEEP_AGENTS_CONFIG_DIR}`,
    );
  }
}

function requiresProtectedSandboxParent(target: AgentConfigTarget): boolean {
  return (
    target.configDir.startsWith("/sandbox/") &&
    (target.agentName === "openclaw" ||
      target.agentName === "hermes" ||
      target.agentName === "langchain-deepagents-code")
  );
}

function configHashPath(configDir: string): string {
  return `${configDir.replace(/\/+$/, "")}/.config-hash`;
}

function ensureConfigHashSensitiveFile<T extends AgentConfigTarget>(target: T): T {
  const hashPath = configHashPath(target.configDir);
  const sensitiveFiles = target.sensitiveFiles || [];
  if (sensitiveFiles.includes(hashPath)) return target;
  return { ...target, sensitiveFiles: [...sensitiveFiles, hashPath] } as T;
}
function loadMarkerAgentStateLockPlan(
  agentName: string | undefined,
): Pick<AgentConfigTarget, "stateLockPlan" | "stateLockPlanInImage"> {
  if (!agentName) return { stateLockPlanInImage: false };
  try {
    return resolveAgentStateLockContract(agentName);
  } catch {
    // A marker path remains authoritative, but a missing agent definition
    // cannot authorize a state-directory mutation.
    return { stateLockPlanInImage: false };
  }
}

function resolvePersistedAutoRestoreTarget(
  sandboxName: string,
  marker: { agentName?: string; configPath?: string; configDir?: string },
  resolveConfig: (sandboxName: string) => AgentConfigTarget = resolveAgentConfig,
): AgentConfigTarget | undefined {
  if (!marker.configPath || !marker.configDir) return undefined;

  const persistedTarget: AgentConfigTarget = {
    ...(marker.agentName ? { agentName: marker.agentName } : {}),
    configPath: marker.configPath,
    configDir: marker.configDir,
    sensitiveFiles: [
      configHashPath(marker.configDir),
      ...(marker.agentName === "hermes" ? [`${marker.configDir.replace(/\/+$/, "")}/.env`] : []),
    ],
    ...loadMarkerAgentStateLockPlan(marker.agentName),
  };

  try {
    const resolved = ensureConfigHashSensitiveFile(resolveConfig(sandboxName));
    return (!marker.agentName || resolved.agentName === marker.agentName) &&
      resolved.configPath === marker.configPath &&
      resolved.configDir === marker.configDir
      ? resolved
      : persistedTarget;
  } catch {
    // The host-side timer marker is the recovery authority when the registry
    // is unavailable. Keep the original target instead of silently selecting
    // another agent's default configuration.
    return persistedTarget;
  }
}

const { DeferredShieldsExit }: typeof import("./deferred-exit") = require("./deferred-exit");

function failShieldsCommand(message: string, _shouldThrow?: boolean): never {
  // Never terminate while a transition-lock callback is active: process.exit
  // skips finally blocks and would strand the canonical lock. NemoClawCommand
  // translates this sentinel into an exit code after the lock has been
  // released (isDeferredShieldsExit in ./deferred-exit).
  throw new DeferredShieldsExit(message, 1);
}

function completeDeferredShieldsExit(error: unknown, shouldThrow = false): never {
  if (isShieldsTransitionLockUnavailable(error)) {
    console.error(`  ${error.summary}`);
    if (error.recovery) console.error(`  Recovery: ${error.recovery}`);
    return failShieldsCommand(error.summary, shouldThrow);
  }
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
    const contents = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(contents);
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
  const timerBoundTransition =
    !state._isCorrupt && state.shieldsDown === true
      ? readTimerBoundShieldsDownTransition(sandboxName)
      : null;
  const transitionDeniesMutability =
    timerBoundTransition?.phase === "policy_rejected" ||
    timerBoundTransition?.phase === "preparing";
  const effectiveState: LoadedShieldsState = transitionDeniesMutability
    ? {
        ...state,
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
      }
    : state;
  const mode = effectiveState._isCorrupt
    ? "error"
    : deriveShieldsMode(effectiveState, effectiveState._hasStateFile);
  return { ...describeShieldsMode(mode), state: effectiveState };
}

type ExpiredAutoRestoreTakeover = {
  marker: TimerMarker & { processToken: string };
};

function inspectExpiredAutoRestoreMarker(sandboxName: string): TimerMarker | null {
  const state = loadShieldsState(sandboxName);
  if (state._isCorrupt || state.shieldsDown !== true) return null;
  const marker = readTimerMarker(sandboxName);
  if (!marker) return null;
  return isExactLiveFutureTimerAuthority(marker) ? null : marker;
}

function inspectExpiredAutoRestoreTakeover(
  sandboxName: string,
  marker = inspectExpiredAutoRestoreMarker(sandboxName),
): ExpiredAutoRestoreTakeover | null {
  if (!marker?.processToken || !/^[0-9a-f]{32}$/.test(marker.processToken)) return null;
  return {
    marker: marker as TimerMarker & { processToken: string },
  };
}

function failInteractiveAutoRestoreClosed(
  sandboxName: string,
  marker: TimerMarker & { processToken: string },
  message: string,
): never {
  const containmentPath = `${getMcpLifecycleLockPath(sandboxName, STATE_DIR)}.containment`;
  let notifiedError: string | null = null;
  let lastContainmentError: string | null = null;
  // Retry a durable containment commit for one normal transition-handoff
  // window. A persistent state-directory failure returns to the operator only
  // through the coded failure that keeps the owned lifecycle gates.
  for (let attempt = 0; attempt < INTERACTIVE_CONTAINMENT_COMMIT_MAX_ATTEMPTS; attempt += 1) {
    assertTimerMarkerGeneration(sandboxName, marker);
    try {
      persistUnresolvedShieldsContainment(
        sandboxName,
        marker.processToken,
        `Interactive auto-restore could not complete safely: ${message}`,
        () => assertTimerMarkerGeneration(sandboxName, marker),
      );
      break;
    } catch (error) {
      if (isDurableContainmentFailure(error)) throw error;
      if (fs.existsSync(containmentPath)) break;
      assertTimerMarkerGeneration(sandboxName, marker);
      const containmentError = error instanceof Error ? error.message : String(error);
      lastContainmentError = containmentError;
      if (containmentError !== notifiedError) {
        appendAuditEntryBestEffort({
          action: "shields_up_failed",
          sandbox: sandboxName,
          timestamp: new Date().toISOString(),
          restored_by: "auto_timer",
          policy_snapshot: marker.snapshotPath,
          error: `Durable containment commit failed; retrying behind the deadline gate: ${containmentError}`,
        });
        notifiedError = containmentError;
      }
      if (attempt + 1 < INTERACTIVE_CONTAINMENT_COMMIT_MAX_ATTEMPTS) {
        Atomics.wait(transitionPollBuffer, 0, 0, SHIELDS_TRANSITION_POLL_MS);
      }
    }
  }
  if (!fs.existsSync(containmentPath)) {
    throw durableMcpLifecycleContainmentFailure(
      new Error(
        `${message}. Durable containment could not be committed after ${String(
          INTERACTIVE_CONTAINMENT_COMMIT_MAX_ATTEMPTS,
        )} attempts: ${lastContainmentError ?? "unknown state-directory failure"}. Correct the state-directory write failure and retry the command before running another sandbox mutation`,
      ),
      getMcpLifecycleLockPath(sandboxName, STATE_DIR),
    );
  }
  throw new Error(`${message}. Durable sandbox mutation containment requires operator resolution`);
}

function isDurableContainmentFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === "NEMOCLAW_DURABLE_CONTAINMENT"
  );
}

function retryInlineAutoRestore(
  sandboxName: string,
  marker: TimerMarker & { processToken: string },
): void {
  let notifiedError: string | null = null;
  for (let attempt = 0; attempt < INTERACTIVE_AUTO_RESTORE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const recoveredState = recoverExpiredAutoRestoreGate(sandboxName, true);
      if (!recoveredState._isCorrupt && recoveredState.shieldsDown !== true) {
        return;
      }
      assertTimerMarkerGeneration(sandboxName, marker);
      const message = "Inline auto-restore did not complete; retrying under the lifecycle gate";
      if (message !== notifiedError) {
        appendAuditEntryBestEffort({
          action: "shields_up_failed",
          sandbox: sandboxName,
          timestamp: new Date().toISOString(),
          restored_by: "auto_timer",
          policy_snapshot: marker.snapshotPath,
          error: message,
        });
        notifiedError = message;
      }
    } catch (error) {
      if (isDurableContainmentFailure(error)) throw error;
      assertTimerMarkerGeneration(sandboxName, marker);
      const message = error instanceof Error ? error.message : String(error);
      if (message !== notifiedError) {
        appendAuditEntryBestEffort({
          action: "shields_up_failed",
          sandbox: sandboxName,
          timestamp: new Date().toISOString(),
          restored_by: "auto_timer",
          policy_snapshot: marker.snapshotPath,
          error: message,
        });
        notifiedError = message;
      }
    }
    if (attempt + 1 < INTERACTIVE_AUTO_RESTORE_MAX_ATTEMPTS) {
      Atomics.wait(transitionPollBuffer, 0, 0, INTERACTIVE_AUTO_RESTORE_RETRY_MS);
    }
  }
  failInteractiveAutoRestoreClosed(
    sandboxName,
    marker,
    `Inline auto-restore exhausted ${String(
      INTERACTIVE_AUTO_RESTORE_MAX_ATTEMPTS,
    )} attempts: ${notifiedError ?? "recovery did not complete"}`,
  );
}

function withExpiredAutoRestoreDeadlineFence<T>(
  sandboxName: string,
  command: string,
  operation: (allowInlineRecovery: boolean) => T,
  fallbackTakeoverToken?: string,
): T {
  const expiredMarker = inspectExpiredAutoRestoreMarker(sandboxName);
  const takeover = inspectExpiredAutoRestoreTakeover(sandboxName, expiredMarker);
  const runWithHostLock = (callback: () => T) =>
    fallbackTakeoverToken
      ? withTimerBoundShieldsMutationLockFallback(
          sandboxName,
          command,
          fallbackTakeoverToken,
          callback,
        )
      : withTimerBoundShieldsMutationLock(sandboxName, command, callback);
  const retireUnexpectedFreshTimerGeneration = () => {
    if (!fallbackTakeoverToken) return;
    const state = loadShieldsState(sandboxName);
    if (state._isCorrupt || state.shieldsDown === true || !readTimerMarker(sandboxName)) return;
    withTimerBoundShieldsMutationLock(sandboxName, command, () => {
      const marker = readTimerMarker(sandboxName);
      const currentState = loadShieldsState(sandboxName);
      if (!marker || currentState._isCorrupt || currentState.shieldsDown === true) return;
      const revocation = killTimer(sandboxName);
      for (const warning of revocation.warnings) console.warn(`  ${warning}`);
      if (!revocation.authorityRevoked) {
        throw new Error(
          `Cannot revoke stale auto-restore timer authority for ${sandboxName}; refusing to create a replacement generation`,
        );
      }
      if (marker.processToken && /^[0-9a-f]{32}$/.test(marker.processToken)) {
        clearShieldsDownTransition(sandboxName, marker.processToken);
      }
    });
  };
  const recoverThenRun = () => {
    withTimerBoundAutoRestoreLock(sandboxName, command, () => {
      if (takeover) retryInlineAutoRestore(sandboxName, takeover.marker);
    });
    return runWithHostLock(() => operation(false));
  };
  if (isMcpLifecycleLockHeld(sandboxName, STATE_DIR)) {
    if (!expiredMarker || !takeover) {
      retireUnexpectedFreshTimerGeneration();
      return runWithHostLock(() => operation(true));
    }
    const { marker } = takeover;
    prepareAutoRestoreTransitionTakeover(
      sandboxName,
      marker.processToken,
      marker.snapshotPath,
      () => assertTimerMarkerGeneration(sandboxName, marker),
    );
    if (fallbackTakeoverToken) {
      retryInlineAutoRestore(sandboxName, marker);
    }
    // This lifecycle owner is what the live timer is waiting on. Run the
    // nested operation without re-entering recovery against that timer.
    return runWithHostLock(() => operation(false));
  }
  if (!takeover) {
    return withMcpLifecycleLockSync(
      sandboxName,
      () => {
        retireUnexpectedFreshTimerGeneration();
        return runWithHostLock(() => operation(true));
      },
      {
        stateDir: STATE_DIR,
      },
    );
  }

  const { marker } = takeover;
  const assertTakeoverAuthority = () => assertTimerMarkerGeneration(sandboxName, marker);
  return withMcpLifecycleDeadlineFenceSync(
    sandboxName,
    marker.processToken,
    () => {
      let notifiedError: string | null = null;
      for (let attempt = 0; attempt < INTERACTIVE_AUTO_RESTORE_MAX_ATTEMPTS; attempt += 1) {
        try {
          prepareAutoRestoreTransitionTakeover(
            sandboxName,
            marker.processToken,
            marker.snapshotPath,
            assertTakeoverAuthority,
          );
          return recoverThenRun();
        } catch (error) {
          if (isDurableContainmentFailure(error)) throw error;
          assertTakeoverAuthority();
          if (fs.existsSync(`${getMcpLifecycleLockPath(sandboxName, STATE_DIR)}.containment`)) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          if (message !== notifiedError) {
            appendAuditEntryBestEffort({
              action: "shields_up_failed",
              sandbox: sandboxName,
              timestamp: new Date().toISOString(),
              restored_by: "auto_timer",
              policy_snapshot: marker.snapshotPath,
              error: message,
            });
            notifiedError = message;
          }
          if (attempt + 1 < INTERACTIVE_AUTO_RESTORE_MAX_ATTEMPTS) {
            Atomics.wait(transitionPollBuffer, 0, 0, INTERACTIVE_AUTO_RESTORE_RETRY_MS);
          }
        }
      }
      return failInteractiveAutoRestoreClosed(
        sandboxName,
        marker,
        `Auto-restore transition takeover exhausted ${String(
          INTERACTIVE_AUTO_RESTORE_MAX_ATTEMPTS,
        )} attempts: ${notifiedError ?? "transition ownership did not become available"}`,
      );
    },
    {
      stateDir: STATE_DIR,
      throwOnCommittedContainment: true,
      onContainment: ({ kind, ownerPid, reason }) => {
        if (kind === "verified-live-wait") {
          appendAuditEntryBestEffort({
            action: "shields_auto_restore_lock_warning",
            sandbox: sandboxName,
            timestamp: new Date().toISOString(),
            restored_by: "auto_timer",
            policy_snapshot: marker.snapshotPath,
            warning: reason,
          });
          return;
        }
        appendAuditEntryBestEffort({
          action: "shields_up_failed",
          sandbox: sandboxName,
          timestamp: new Date().toISOString(),
          restored_by: "auto_timer",
          policy_snapshot: marker.snapshotPath,
          error: `${reason}${ownerPid ? ` Contained owner PID: ${String(ownerPid)}.` : ""}`,
        });
      },
    },
  );
}

function getShieldsPosture(sandboxName: string, allowInlineRecovery = false): ShieldsPosture {
  if (!allowInlineRecovery) return getShieldsPostureWithoutHostLock(sandboxName, false);
  validateName(sandboxName, "sandbox name");
  return withExpiredAutoRestoreDeadlineFence(
    sandboxName,
    "recover expired shields posture",
    (allowInlineRecovery) => getShieldsPostureWithoutHostLock(sandboxName, allowInlineRecovery),
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
  writeShieldsFileAtomicDurable(stateFilePath(sandboxName), JSON.stringify(updated, null, 2));
  return updated;
}

function restoreShieldsStateSnapshot(sandboxName: string, state: LoadedShieldsState): void {
  const {
    _hasStateFile: hasStateFile,
    _isCorrupt: isCorrupt,
    _corruptError: _corruptError,
    ...persisted
  } = state;
  const filePath = stateFilePath(sandboxName);
  if (!hasStateFile) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  if (isCorrupt) {
    throw new Error("Cannot restore a corrupt shields state snapshot");
  }
  writeShieldsFileAtomicDurable(filePath, JSON.stringify(persisted, null, 2));
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

function isOptionalManagedMcpPolicyKeys(value: unknown): value is string[] | undefined {
  if (value === undefined) return true;
  // Preserve string entries exactly so deadline recovery can strip and audit
  // malformed or duplicate ownership without delaying restrictive lockdown.
  // Manual restoration validates the same entries strictly during composition.
  return Array.isArray(value) && value.every((key) => typeof key === "string");
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
    isOptionalManagedMcpPolicyKeys(value.shieldsManagedMcpPolicyKeys) &&
    isOptionalBoolean(value.chattrApplied) &&
    isOptionalHashMap(value.fileHashes) &&
    isOptionalString(value.updatedAt)
  );
}

// ---------------------------------------------------------------------------
// State-dir lock — adapter between this module's privileged-exec helpers and
// the lock pipeline in ./state-dir-lock. AgentDefinition supplies the path
// plan; the sibling module owns helper execution and output validation so this
// file stays focused on shields state transitions.
// ---------------------------------------------------------------------------

function stateDirLockExec(sandboxName: string) {
  return {
    run: (cmd: string[], input?: string) =>
      withPrivilegedSandboxExecutionLease(sandboxName, "state directory guard", () => {
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
      }),
  };
}

function openClawConfigGuardExec(sandboxName: string) {
  return {
    run: (cmd: string[], input?: string) =>
      withPrivilegedSandboxExecutionLease(sandboxName, "OpenClaw config guard", () => {
        const timeout = cmd.includes("unlock-failed-startup")
          ? OPENCLAW_CONFIG_GUARD_RECOVERY_TIMEOUT_MS
          : OPENCLAW_CONFIG_GUARD_TIMEOUT_MS;
        const result = dockerSpawnSync(
          privilegedSandboxExecArgv(sandboxName, cmd, input !== undefined, true),
          {
            encoding: "utf-8",
            input,
            timeout,
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
      }),
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
    const issueCodes = result.issueCodes?.length === result.issues.length ? result.issueCodes : [];
    throw new OpenClawConfigGuardFailure(
      `Config not ${action === "unlock" ? "unlocked" : "locked"}: ${result.issues.join(", ")}`,
      issueCodes,
    );
  }
  if (result.resealedDrift) {
    // The guard found an already-locked config whose canonical file had drifted
    // perms-only (a reconciler re-permissioned it after the lock) and re-sealed
    // it in place instead of failing closed (#4663 / #7985). Surface the
    // self-heal so a rebuild/relock does not fix drift invisibly.
    console.log(
      "  Re-sealed a perms-only config-lock drift (config dir stays root-owned; contents intact).",
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
restore_mutable_parent = sys.argv[4] == "1"
config_dir = os.path.normpath(sys.argv[5])
files = sys.argv[6:]

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
        if unlock_ok and restore_mutable_parent:
            os.fchown(parent_fd, uid, gid)
            os.fchmod(parent_fd, 0o755)
        else:
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
        # Root-owned in the sandbox group with set-id/sticky: Hermes keeps
        # writing its top-level runtime state while the sticky bit stops the
        # sandbox identity from unlinking the sealed root-owned files (#7865).
        os.fchown(config_fd, 0, sandbox_gid)
        os.fchmod(config_fd, 0o3770)
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
    requiresProtectedSandboxParent(target) ? "1" : "0",
    target.configDir,
    ...filesToUnlock,
  ]);
}

function writeAbsentConfigHashNoSymlinkFollow(
  sandboxName: string,
  target: AgentConfigTarget,
): void {
  privilegedSandboxExec(
    sandboxName,
    buildConfigHashRepairCommand(target.configDir, target.configPath),
  );
}

type DeepAgentsConfigLockFailureStatus =
  | "config-root"
  | "sandbox-parent"
  | "incomplete"
  | "rollback-failed"
  | "transaction-failed";

const DEEP_AGENTS_CONFIG_LOCK_GENERIC_ERROR = "Deep Agents config lock transaction failed.";
const DEEP_AGENTS_CONFIG_LOCK_PROTOCOL_MAX_BYTES = 128;

function parseDeepAgentsConfigLockFailure(
  error: unknown,
): DeepAgentsConfigLockFailureStatus | null {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr !== "string" && !Buffer.isBuffer(stderr)) return null;

  const byteLength = Buffer.isBuffer(stderr) ? stderr.length : Buffer.byteLength(stderr);
  if (byteLength === 0 || byteLength > DEEP_AGENTS_CONFIG_LOCK_PROTOCOL_MAX_BYTES) return null;

  let line = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
  if (line.endsWith("\n")) line = line.slice(0, -1);
  if (!line || line.includes("\n") || line.includes("\r")) return null;

  const prefix = `${DEEP_AGENTS_CONFIG_LOCK_ERROR_PROTOCOL_PREFIX}:`;
  if (!line.startsWith(prefix)) return null;
  const status = line.slice(prefix.length);
  switch (status) {
    case "config-root":
    case "sandbox-parent":
    case "incomplete":
    case "rollback-failed":
    case "transaction-failed":
      return status;
    default:
      return null;
  }
}

function lockDeepAgentsTopConfig(
  sandboxName: string,
  target: AgentConfigTarget,
  failClosedOnError: boolean,
): void {
  assertCanonicalDeepAgentsTarget(target);
  let outcome: string;
  try {
    outcome = privilegedSandboxExecCapture(
      sandboxName,
      buildDeepAgentsConfigLockCommand(target.configDir, target.configPath, failClosedOnError),
    );
  } catch (error) {
    const status = parseDeepAgentsConfigLockFailure(error);
    if (status === "config-root") {
      console.error(
        "  CRITICAL: Deep Agents lock failed after containment began. NemoClaw confirmed fail-closed containment at the config root. Restore this sandbox from a trusted snapshot or recreate it before retrying. fail-closed containment=config-root",
      );
    } else if (status === "sandbox-parent") {
      console.error(
        "  CRITICAL: Deep Agents lock failed after containment began. NemoClaw confirmed fail-closed containment at the sandbox parent because NemoClaw could not confirm the complete config-root posture. In-sandbox recovery is unavailable. Restore this sandbox from a trusted snapshot or recreate it before retrying. fail-closed containment=sandbox-parent",
      );
    } else if (status === "incomplete") {
      console.error(
        "  CRITICAL: Deep Agents lock failed after containment began, and NemoClaw could not confirm fail-closed containment. Do not retry or repair from inside the sandbox. Restore this sandbox from a trusted snapshot or recreate it before retrying. fail-closed containment=incomplete",
      );
    } else if (status === "rollback-failed") {
      console.error(
        "  CRITICAL: Deep Agents config lock transaction could not restore its original posture. Restore this sandbox from a trusted snapshot or recreate it before retrying. rollback failed",
      );
    }
    throw new Error(DEEP_AGENTS_CONFIG_LOCK_GENERIC_ERROR);
  }
  if (outcome === "hash-created" || outcome === "hash-existing") return;
  throw new Error("Deep Agents config lock returned an unexpected result.");
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

class OpenClawConfigGuardFailure extends Error {
  constructor(
    message: string,
    readonly issueCodes: readonly string[],
  ) {
    super(message);
    this.name = "OpenClawConfigGuardFailure";
  }
}

/** Whether a guard error reports the OpenClaw startup readiness lease. */
function isOpenClawStartupNotReady(error: unknown): boolean {
  return (
    error instanceof OpenClawConfigGuardFailure &&
    error.issueCodes.length === 1 &&
    error.issueCodes[0] === "startup-not-ready"
  );
}

/** The guard's refusal when the sandbox is simply not in a failed startup. */
const FAILED_STARTUP_NOT_PROVEN = "failed-startup-not-proven";

/**
 * Lower shields on an OpenClaw sandbox whose startup terminally failed.
 *
 * Returns false when the sandbox is not in that state. The guard proves a
 * stable supervisor with no startup process and no readiness marker, then
 * unseals both layers in one mutex window.
 */
function recoverOpenClawFailedStartupShields(
  sandboxName: string,
  target: AgentConfigTarget,
): boolean {
  assertCanonicalOpenClawConfigTarget(target);
  const result = runOpenClawConfigGuard(
    openClawConfigGuardExec(sandboxName),
    "unlock-failed-startup",
    { planJson: JSON.stringify(requireStateLockPlan(target)) },
  );
  if (result.issues.length === 0) return true;
  // Only "not a failed startup" falls back. A transition, rollback, contract,
  // parse, or timeout failure must surface instead of being masked.
  const notApplicable =
    result.issueCodes?.length === result.issues.length &&
    result.issueCodes.every((code) => code === FAILED_STARTUP_NOT_PROVEN);
  if (notApplicable) return false;
  throw new Error(`Failed-startup shields recovery failed: ${result.issues.join(", ")}`);
}

/** Independently observe the mutable OpenClaw posture after the guard returns. */
function openClawMutablePostureIssues(sandboxName: string, target: AgentConfigTarget): string[] {
  assertCanonicalOpenClawConfigTarget(target);
  const issues: string[] = [];
  for (const file of [target.configPath, ...(target.sensitiveFiles || [])]) {
    try {
      const perms = privilegedSandboxExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", file]);
      const [mode, owner] = perms.split(" ");
      if (mode !== "660") issues.push(`${file} mode=${mode} (expected 660)`);
      if (owner !== "sandbox:sandbox") {
        issues.push(`${file} owner=${owner} (expected sandbox:sandbox)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`${file} stat failed: ${message}`);
    }
    try {
      const attrs = privilegedSandboxExecCapture(sandboxName, ["lsattr", "-d", file]);
      const [flags] = attrs.trim().split(/\s+/, 1);
      if (flags.includes("i")) issues.push(`${file} immutable bit still set`);
    } catch {
      // Some supported images omit lsattr. Ownership and mode remain required.
    }
  }

  try {
    const perms = privilegedSandboxExecCapture(sandboxName, [
      "stat",
      "-c",
      "%a %U:%G",
      target.configDir,
    ]);
    const [mode, owner] = perms.split(" ");
    if (mode !== "2770") issues.push(`config dir mode=${mode} (expected 2770)`);
    if (owner !== "sandbox:sandbox") {
      issues.push(`config dir owner=${owner} (expected sandbox:sandbox)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`config dir stat failed: ${message}`);
  }

  if (requiresProtectedSandboxParent(target)) {
    try {
      const perms = privilegedSandboxExecCapture(sandboxName, [
        "stat",
        "-c",
        "%a %U:%G",
        "/sandbox",
      ]);
      const [mode, owner] = perms.split(" ");
      if (mode !== "755") issues.push(`parent dir mode=${mode} (expected 755)`);
      if (owner !== "sandbox:sandbox") {
        issues.push(`parent dir owner=${owner} (expected sandbox:sandbox)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`parent dir stat failed: ${message}`);
    }
  }
  return issues;
}

function unlockAgentConfigUnderMutationLock(
  sandboxName: string,
  rawTarget: AgentConfigTarget,
  rollbackLocked: boolean,
  protocol: HermesShieldsProtocol,
): void {
  const target = ensureConfigHashSensitiveFile(rawTarget);
  if (target.agentName === "hermes" && protocol === "provider-state-mutation-v2") {
    if (!rollbackLocked) {
      runHermesProviderProtectionTransition(sandboxName, target, "mutable", "mutable");
      try {
        verifyHermesProviderMutablePosture(sandboxName, target);
        return;
      } catch {
        // State-derived mutable-default authority disagrees with the live
        // posture. Repair it with a restrictive rollback instead of creating
        // an invalid same-posture provider plan.
      }
    }
    runHermesProviderProtectionTransition(sandboxName, target, "mutable", "locked");
    verifyHermesProviderMutablePosture(sandboxName, target);
    return;
  }
  const compatibilityIssues = stateLockPlanCompatibilityIssues(
    stateDirLockExec(sandboxName),
    requireStateLockPlan(target),
    target.stateLockPlanInImage,
  );
  if (compatibilityIssues.length > 0) {
    throw new Error(`Config not unlocked: ${compatibilityIssues.join(", ")}`);
  }
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
      try {
        transitionOpenClawTopConfig(sandboxName, target, "preflight");
      } catch (preflightError) {
        // Preflight is read-only, so nothing is mutated yet. Hand the whole
        // unseal to the guard, which does it atomically (#8304).
        if (!isOpenClawStartupNotReady(preflightError)) throw preflightError;
        if (!recoverOpenClawFailedStartupShields(sandboxName, target)) throw preflightError;
        const postureIssues = openClawMutablePostureIssues(sandboxName, target);
        if (postureIssues.length > 0) {
          throw new Error(`Config not unlocked: ${postureIssues.join(", ")}`);
        }
        console.log("  Lowered shields on a sandbox whose startup never completed.");
        return;
      }
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
      runHermesStateDirTransition(sandboxName, target, transaction.token, "unlock", protocol);
    } else {
      const stateDirUnlockIssues = applyStateDirLockMode(
        stateDirLockExec(sandboxName),
        target.configDir,
        "sandbox:sandbox",
        false,
        requireStateLockPlan(target),
        target.stateLockPlanInImage,
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

    const issues = openClawProtocol ? openClawMutablePostureIssues(sandboxName, target) : [];
    if (!openClawProtocol) {
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
        // A 0700 Hermes root is provisional here. The token-bound guard finish
        // preserves it only for an attested same-UID topology, repairs and
        // verifies 03770 for a root-separated topology, and fails closed for an
        // unknown topology.
        const validDirMode =
          mode === dirMode ||
          (target.agentName === "hermes" && mode === "700" && transaction !== null);
        if (!validDirMode) {
          const expectedDirModes =
            target.agentName === "hermes" && transaction !== null
              ? `${dirMode}, or provisional 700 pending sealed guard topology attestation`
              : dirMode;
          issues.push(`config dir mode=${mode} (expected ${expectedDirModes})`);
        }
        if (owner !== "sandbox:sandbox") {
          issues.push(`config dir owner=${owner} (expected sandbox:sandbox)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`config dir stat failed: ${msg}`);
      }

      if (requiresProtectedSandboxParent(target) && target.agentName !== "hermes") {
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
          protocol,
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
            requireStateLockPlan(target),
            target.stateLockPlanInImage,
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
              requireStateLockPlan(target),
              target.stateLockPlanInImage,
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
  return withExpiredAutoRestoreDeadlineFence(
    sandboxName,
    "inspect mutable config permissions",
    (allowInlineRecovery) => {
      const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
      return inspectMutableConfigPermsCore(
        target,
        getShieldsPostureWithoutHostLock(sandboxName, allowInlineRecovery).mode,
        (p) => privilegedSandboxExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", p]),
      );
    },
  );
}

function repairMutableConfigPerms(sandboxName: string): MutableConfigRepairResult {
  validateName(sandboxName, "sandbox name");
  return withExpiredAutoRestoreDeadlineFence(
    sandboxName,
    "repair mutable config permissions",
    (allowInlineRecovery) => {
      const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
      return repairMutableConfigPermsCore(
        target,
        getShieldsPostureWithoutHostLock(sandboxName, allowInlineRecovery).mode,
        () => normalizeMutableOpenClawConfig(sandboxName, target.configDir),
      );
    },
  );
}

function restoreLockedStateDirStartupAccess(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");
  withExpiredAutoRestoreDeadlineFence(
    sandboxName,
    "restore locked startup access",
    (allowInlineRecovery) => {
      const posture = getShieldsPostureWithoutHostLock(sandboxName, allowInlineRecovery);
      if (!posture.locked) return;
      const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
      const issues = restoreStateDirStartupAccess(
        stateDirLockExec(sandboxName),
        target.configDir,
        requireStateLockPlan(target),
      );
      if (issues.length > 0) {
        throw new Error(`Locked startup access could not be restored: ${issues.join(", ")}`);
      }
    },
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
  if (target.agentName === "hermes" && protocol === "provider-state-mutation-v2") {
    const verifyProviderLockedPosture = () => {
      const chattrApplied = hermesProviderChattrApplied(sandboxName, target);
      const verified = verifyShieldsLockState(sandboxName, target, {
        verifyChattr: chattrApplied,
        verifyParentProtection: true,
        exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
        assertLegacyLayout: assertNoLegacyStateLayout,
      });
      if (verified.issues.length > 0) {
        throw new Error(`Config not locked: ${verified.issues.join(", ")}`);
      }
      return {
        chattrApplied,
        fileHashes: captureSealHashes(sandboxName, [
          target.configPath,
          ...(target.sensitiveFiles || []),
        ]),
      };
    };
    if (rollbackLocked) {
      runHermesProviderProtectionTransition(sandboxName, target, "locked", "locked");
      try {
        return verifyProviderLockedPosture();
      } catch {
        // Repair a drifted live posture with a mutable rollback. Locked-target
        // failures retain the provider fence, so this remains fail-closed.
      }
    }
    runHermesProviderProtectionTransition(sandboxName, target, "locked", "mutable");
    return verifyProviderLockedPosture();
  }
  const compatibilityIssues = stateLockPlanCompatibilityIssues(
    stateDirLockExec(sandboxName),
    requireStateLockPlan(target),
    target.stateLockPlanInImage,
  );
  if (compatibilityIssues.length > 0) {
    throw new Error(`Config not locked: ${compatibilityIssues.join(", ")}`);
  }
  const errors: string[] = [];
  const filesToLock = [target.configPath, ...(target.sensitiveFiles || [])];
  const openClawProtocol = target.agentName === "openclaw";
  const deepAgentsProtocol = isDeepAgentsTarget(target);
  let transaction: {
    token: string;
    originalLocked: boolean;
    rollbackLocked: boolean;
  } | null = null;
  const legacyHermesProtocol = target.agentName === "hermes" && protocol === "legacy";
  let openClawMutationStarted = false;
  let deepAgentsLockSucceeded = false;
  let chattrSucceeded = target.agentName === "hermes" && !legacyHermesProtocol ? false : true;

  // Agents without a descriptor-sealed top-level transaction retain the
  // historical validate-before-mutate ordering. OpenClaw, sealed Hermes, and
  // Deep Agents must revoke writes to their canonical config first. Otherwise,
  // an agent can plant one invalid nested entry and prevent the deadline from
  // restoring Shields up.
  if (
    !openClawProtocol &&
    !deepAgentsProtocol &&
    (target.agentName !== "hermes" || legacyHermesProtocol)
  ) {
    const preflightIssues = preflightStateDirLock(
      stateDirLockExec(sandboxName),
      target.configDir,
      requireStateLockPlan(target),
      target.stateLockPlanInImage,
    );
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
      if (isDeepAgentsTarget(target)) {
        lockDeepAgentsTopConfig(sandboxName, target, !rollbackLocked);
        deepAgentsLockSucceeded = true;
      } else {
        writeAbsentConfigHashNoSymlinkFollow(sandboxName, target);
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
      runHermesStateDirTransition(sandboxName, target, transaction.token, "lock", protocol);
    } else {
      const stateDirLockIssues = applyStateDirLockMode(
        stateDirLockExec(sandboxName),
        target.configDir,
        "root:sandbox",
        true,
        requireStateLockPlan(target),
        target.stateLockPlanInImage,
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
      // A sealed Hermes transaction deliberately keeps /sandbox frozen as
      // root:root 0755 until finish publishes the prepared sticky/group
      // parent metadata. Verify the recursively locked tree while rollback is
      // still available, then verify the parent after the final commit below.
      verifyParentProtection:
        requiresProtectedSandboxParent(target) &&
        (target.agentName !== "hermes" || transaction === null),
      exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
      assertLegacyLayout: assertNoLegacyStateLayout,
    });
    if (issues.length > 0) throw new Error(`Config not locked: ${issues.join(", ")}`);

    const fileHashes = captureSealHashes(sandboxName, filesToLock);
    if (transaction) {
      finishHermesConfigShields(sandboxName, target, transaction.token);
      transaction = null;
      const committed = verifyShieldsLockState(sandboxName, target, {
        verifyChattr: chattrSucceeded,
        verifyParentProtection: true,
        exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
        assertLegacyLayout: assertNoLegacyStateLayout,
      });
      if (committed.issues.length > 0) {
        throw new Error(`Config not locked: ${committed.issues.join(", ")}`);
      }
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
          protocol,
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
              requireStateLockPlan(target),
              target.stateLockPlanInImage,
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
    } else if (deepAgentsLockSucceeded) {
      const rollbackIssues: string[] = [];
      if (rollbackLocked) {
        try {
          rollbackIssues.push(
            ...restoreStateDirLockPosture(
              stateDirLockExec(sandboxName),
              target.configDir,
              true,
              requireStateLockPlan(target),
              target.stateLockPlanInImage,
            ),
          );
        } catch (rollbackError) {
          rollbackIssues.push(
            `state-directory rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
        try {
          rollbackIssues.push(
            ...verifyShieldsLockState(sandboxName, target, {
              verifyParentProtection: true,
              exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
              assertLegacyLayout: assertNoLegacyStateLayout,
            }).issues,
          );
        } catch (rollbackError) {
          rollbackIssues.push(
            `locked rollback verification failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      if (rollbackIssues.length > 0) {
        console.error(
          `  CRITICAL: Deep Agents lock rollback could not restore the trusted posture. Restore this sandbox from a trusted snapshot or recreate it before retrying. ${rollbackIssues.join(", ")}`,
        );
      }
    }
    throw error;
  }
}

function synchronizeAutoRestoreTransition(
  sandboxName: string,
  processToken: string,
  snapshotPath: string,
  options: {
    expiredTimerRecovery?: boolean;
    retainTransition?: boolean;
    assertTakeoverAuthority?: () => void;
  } = {},
): void {
  const transition = waitForShieldsDownForwardCommit(
    sandboxName,
    processToken,
    options.assertTakeoverAuthority,
  );
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
  const marker = readTimerMarker(sandboxName);
  const timerOwnsRecovery =
    marker?.pid === process.pid &&
    marker.processToken === processToken &&
    marker.snapshotPath === transition.snapshotPath;
  const deadlineAuthoritative = timerOwnsRecovery || options.expiredTimerRecovery === true;
  const restoreResult = applyShieldsPolicySnapshot(sandboxName, transition.snapshotPath, {
    transitionProcessToken: processToken,
    ...(deadlineAuthoritative ? { deadlineAuthoritative: true } : {}),
    ...(options.expiredTimerRecovery ? { expiredTimerRecovery: true } : {}),
  });
  const status = typeof restoreResult.status === "number" ? restoreResult.status : 1;
  if (status !== 0) {
    throw new Error(
      `Policy restore after shields-down handoff exited with status ${String(status)}`,
    );
  }
  if (!options.retainTransition) {
    clearShieldsDownTransition(sandboxName, processToken);
  }
}

function prepareAutoRestoreTransitionTakeover(
  sandboxName: string,
  processToken: string,
  snapshotPath: string,
  assertTakeoverAuthority?: () => void,
): void {
  if (!/^[0-9a-f]{32}$/.test(processToken)) {
    throw new Error("Invalid auto-restore transition takeover token");
  }
  const transition = readShieldsDownTransition(sandboxName, processToken);
  if (transition && transition.snapshotPath !== snapshotPath) {
    throw new Error("Auto-restore snapshot does not match shields-down transition ownership");
  }
  if (transition) {
    waitForShieldsDownForwardCommit(sandboxName, processToken, assertTakeoverAuthority);
  }

  const owner = inspectAnyShieldsTransitionLockOwner(sandboxName);
  if (!owner) return;
  const ownerStatus = readExactProcessStatus(
    owner.pid,
    owner.processStartIdentity,
    processInspectionDeadlineAfter(SHIELDS_TRANSITION_TERMINATE_GRACE_MS),
  );
  if (ownerStatus === "gone") {
    assertTakeoverAuthority?.();
    try {
      persistUnresolvedShieldsContainment(
        sandboxName,
        processToken,
        `Shields recovery owner PID ${String(owner.pid)} exited without descendant-containment proof`,
        assertTakeoverAuthority,
      );
    } catch (error) {
      if (isDurableContainmentFailure(error)) throw error;
      assertTakeoverAuthority?.();
      throw durableMcpLifecycleContainmentFailure(
        error,
        getMcpLifecycleLockPath(sandboxName, STATE_DIR),
      );
    }
    throw new Error(
      "Shields transition owner exited without descendant-containment proof; durable containment requires operator resolution",
    );
  }
  throw new Error(
    "Shields transition owner is still active; automatic recovery is waiting behind the deadline gate",
  );
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
  synchronizeAutoRestoreTransition(
    sandboxName,
    timerMarker.processToken,
    timerMarker.snapshotPath,
    {
      retainTransition: true,
      assertTakeoverAuthority: () => assertTimerMarkerGeneration(sandboxName, timerMarker),
    },
  );
}

function completeAutoRestoreTransition(
  sandboxName: string,
  processToken: string,
  snapshotPath: string,
): boolean {
  const marker = readTimerMarker(sandboxName);
  if (
    marker?.pid !== process.pid ||
    marker.processToken !== processToken ||
    marker.snapshotPath !== snapshotPath
  ) {
    return false;
  }
  const transition = readShieldsDownTransition(sandboxName, processToken);
  if (transition && transition.snapshotPath !== snapshotPath) {
    throw new Error("Auto-restore completion does not match shields-down transition ownership");
  }
  clearShieldsDownTransition(sandboxName, processToken);
  return true;
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

type ShieldsDownRollbackOutcome =
  | "mutable_default_restored"
  | "lockdown_restored"
  | "manual_intervention_required";

type ShieldsDownRollbackResult = {
  outcome: ShieldsDownRollbackOutcome;
  timerAuthorityRevoked: boolean;
};

function describeRollbackTimerAuthority(
  hadScheduledTimer: boolean,
  timerAuthorityRevoked: boolean,
): string {
  if (!hadScheduledTimer) return "";
  return timerAuthorityRevoked
    ? " Auto-restore timer authority was revoked."
    : " The scheduled auto-restore remains authoritative.";
}
function resolveExactManagedMcpPolicies(
  sandboxName: string,
  livePolicyYaml?: string,
): ReturnType<typeof inspectExactManagedMcpPolicies> {
  let effectiveLivePolicy = livePolicyYaml;
  if (!effectiveLivePolicy) {
    let rawPolicy: string;
    try {
      rawPolicy = runCapture(buildPolicyGetCommand(sandboxName));
    } catch (error) {
      throw new Error("Cannot read the live gateway policy for managed MCP reconciliation", {
        cause: error,
      });
    }
    effectiveLivePolicy = parseCurrentPolicy(rawPolicy);
  }
  if (!effectiveLivePolicy) {
    throw new Error("Cannot parse the live gateway policy for managed MCP reconciliation");
  }
  return inspectExactManagedMcpPolicies(sandboxName, effectiveLivePolicy);
}

function resolveProvableManagedMcpPoliciesForDeadline(
  sandboxName: string,
): ReturnType<typeof inspectProvableManagedMcpPoliciesForDeadline> {
  try {
    let effectiveLivePolicy = "";
    try {
      effectiveLivePolicy = parseCurrentPolicy(runCapture(buildPolicyGetCommand(sandboxName)));
    } catch {
      // The tolerant deadline inspector records exact omissions for every claim
      // when the live policy cannot be parsed or read.
    }
    return inspectProvableManagedMcpPoliciesForDeadline(sandboxName, effectiveLivePolicy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      policies: [],
      omissions: [
        {
          reason: `Managed MCP registry inspection failed at the auto-restore deadline: ${message}`,
        },
      ],
    };
  }
}

/**
 * Restore a saved complete policy while reconciling only exact generated MCP
 * entries. Snapshot-time keys are removed before currently owned entries are
 * overlaid, so changes made during the shields-down window survive both manual
 * and timer restoration.
 */
interface ShieldsPolicySnapshotRestoreOptions {
  transitionProcessToken?: string;
  deadlineAuthoritative?: boolean;
  expiredTimerRecovery?: boolean;
  buildPolicySet?: typeof buildPolicySetCommand;
  runPolicySet?: typeof run;
}

type ShieldsPolicySnapshotRestoreResult = ReturnType<typeof run> & {
  managedMcpOmissions?: ManagedMcpPolicyOmission[];
};

function applyShieldsPolicySnapshot(
  sandboxName: string,
  snapshotPath: string,
  options: ShieldsPolicySnapshotRestoreOptions = {},
): ShieldsPolicySnapshotRestoreResult {
  const buildPolicySet = options.buildPolicySet ?? buildPolicySetCommand;
  const runPolicySet = options.runPolicySet ?? run;
  const state = loadShieldsState(sandboxName);
  let transition: ShieldsDownTransition | null = null;
  if (options.transitionProcessToken !== undefined) {
    if (!/^[0-9a-f]{32}$/.test(options.transitionProcessToken)) {
      throw new Error("Invalid Shields transition recovery token");
    }
    transition = readShieldsDownTransition(sandboxName, options.transitionProcessToken);
    if (
      !transition &&
      fs.existsSync(shieldsDownTransitionPath(sandboxName, options.transitionProcessToken))
    ) {
      throw new Error("Shields transition recovery authority is invalid");
    }
    if (transition && transition.snapshotPath !== snapshotPath) {
      throw new Error("Shields transition does not authorize the policy snapshot being restored");
    }
  }
  if (options.deadlineAuthoritative) {
    const marker = readTimerMarker(sandboxName);
    const markerMatchesRecovery =
      marker?.sandboxName === sandboxName &&
      marker.snapshotPath === snapshotPath &&
      marker.processToken === options.transitionProcessToken;
    const timerAuthorityIsInactive =
      options.expiredTimerRecovery === true &&
      markerMatchesRecovery &&
      !isExactLiveFutureTimerAuthority(marker!);
    if (
      options.transitionProcessToken === undefined ||
      !markerMatchesRecovery ||
      (marker!.pid !== process.pid && !timerAuthorityIsInactive)
    ) {
      throw new Error("The active auto-restore timer does not authorize deadline restoration");
    }
  }

  if (state._isCorrupt && !transition) {
    throw new Error(
      `Cannot restore a Shields policy while persisted state is corrupt: ${
        state._corruptError ?? "invalid state"
      }`,
    );
  }
  // A preparing transition can outlive its owner before Shields state is
  // committed; its token-bound marker is then the recovery authority.
  // Every ordinary restore remains bound to the exact persisted snapshot.
  if (!transition && state.shieldsPolicySnapshotPath !== snapshotPath) {
    throw new Error("Shields state does not match the policy snapshot being restored");
  }
  const persistedSnapshotMatches = state.shieldsPolicySnapshotPath === snapshotPath;
  const ownershipOmissions: ManagedMcpPolicyOmission[] = [];
  if (
    transition?.managedMcpPolicyKeys !== undefined &&
    persistedSnapshotMatches &&
    state.shieldsManagedMcpPolicyKeys !== undefined &&
    !sameManagedMcpPolicyKeys(transition.managedMcpPolicyKeys, state.shieldsManagedMcpPolicyKeys)
  ) {
    if (!options.deadlineAuthoritative) {
      throw new Error("Shields transition ownership does not match persisted policy ownership");
    }
    ownershipOmissions.push({
      reason:
        "Shields transition ownership did not match persisted policy ownership at the auto-restore deadline",
    });
  }
  let snapshotManagedPolicyKeys =
    transition?.managedMcpPolicyKeys ??
    (persistedSnapshotMatches ? state.shieldsManagedMcpPolicyKeys : undefined);
  // Older Shields state has no exact snapshot-time ownership manifest.
  // A manual restore preserves raw-snapshot behavior only when neither current
  // state nor the snapshot can involve managed MCP. Deadline restoration
  // instead strips every reserved key and overlays only independently proven
  // current entries so legacy metadata cannot delay restrictive lockdown.
  if (snapshotManagedPolicyKeys === undefined) {
    if (options.deadlineAuthoritative) {
      snapshotManagedPolicyKeys = [];
      ownershipOmissions.push({
        reason:
          "Legacy Shields state had no managed MCP ownership manifest at the auto-restore deadline",
      });
    } else {
      assertLegacyMcpPolicyRestoreSafe(
        fs.readFileSync(snapshotPath, "utf-8"),
        hasManagedMcpPolicyClaims(sandboxName),
      );
      return runPolicySet(buildPolicySet(snapshotPath, sandboxName), {
        ignoreError: true,
      });
    }
  }
  let managedMcpOmissions: ManagedMcpPolicyOmission[] = [];
  let runtimePolicyPath: string;
  if (options.deadlineAuthoritative) {
    const inspection = resolveProvableManagedMcpPoliciesForDeadline(sandboxName);
    const runtime = buildDeadlineRuntimeManagedMcpPolicy(snapshotPath, {
      managedMcpPolicies: inspection.policies,
      snapshotManagedPolicyKeys,
      readBasePolicy: () => fs.readFileSync(snapshotPath, "utf-8"),
    });
    runtimePolicyPath = runtime.path;
    managedMcpOmissions = [...ownershipOmissions, ...inspection.omissions, ...runtime.omissions];
  } else {
    const managedMcpPolicies = resolveExactManagedMcpPolicies(sandboxName);
    runtimePolicyPath = buildRuntimeManagedMcpPolicy(snapshotPath, {
      managedMcpPolicies,
      snapshotManagedPolicyKeys,
      readBasePolicy: () => fs.readFileSync(snapshotPath, "utf-8"),
    });
  }
  const runtimePolicyIsTemp = runtimePolicyPath !== snapshotPath;
  try {
    const result = runPolicySet(buildPolicySet(runtimePolicyPath, sandboxName), {
      ignoreError: true,
    });
    return managedMcpOmissions.length > 0 ? { ...result, managedMcpOmissions } : result;
  } finally {
    if (runtimePolicyIsTemp) {
      cleanupTempDir(runtimePolicyPath, "nemoclaw-permissive-runtime");
    }
  }
}

function rollbackShieldsDown(
  sandboxName: string,
  target: AgentConfigTarget,
  snapshotPath: string,
  initialMode: ShieldsMode,
  initialState: LoadedShieldsState,
  allowLegacyHermesProtocol = false,
  cachedProtocol?: HermesShieldsProtocol,
): ShieldsDownRollbackResult {
  console.error("  Rolling back — restoring policy from snapshot...");
  let rollbackResult: ReturnType<typeof run> | null = null;
  try {
    rollbackResult = applyShieldsPolicySnapshot(sandboxName, snapshotPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Warning: Policy restore preparation failed during rollback: ${message}`);
  }
  let timerAuthorityRevoked = false;
  let rollbackChattrApplied: boolean | null = null;
  let rollbackFileHashes: { [path: string]: string } | null = null;
  const protocol = resolveHermesShieldsProtocol(
    sandboxName,
    target,
    allowLegacyHermesProtocol,
    cachedProtocol,
  );
  if (rollbackResult?.status === 0) {
    if (initialMode === "mutable_default" && target.agentName === "openclaw") {
      try {
        unlockAgentConfigUnderMutationLock(sandboxName, target, false, protocol);
        const timerCancellation = killTimer(sandboxName);
        timerAuthorityRevoked = timerCancellation.authorityRevoked;
        if (!timerCancellation.authorityRevoked) {
          throw new Error(
            `Cannot revoke auto-restore timer authority: ${timerCancellation.warnings.join("; ")}`,
          );
        }
        restoreShieldsStateSnapshot(sandboxName, initialState);
        console.error("  Original mutable-default posture restored.");
        return { outcome: "mutable_default_restored", timerAuthorityRevoked };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(
          `  Warning: Could not verify the original mutable-default posture; applying fail-closed lockdown. ${detail}`,
        );
      }
    }
    // Re-confirm after the settle window so a reconciler revert cannot leave
    // the rolled-back config DRIFTED — same fail-closed treatment as the
    // auto-restore path. Leaves the hashes null (→ "manual intervention"
    // below) when the lock will not re-confirm.
    const relock = relockAndReconfirm(() =>
      lockAgentConfigUnderMutationLock(sandboxName, target, true, protocol),
    );
    if (relock.ok && relock.lastResult) {
      rollbackChattrApplied = relock.lastResult.chattrApplied;
      rollbackFileHashes = relock.lastResult.fileHashes;
    } else {
      console.error(
        `  Warning: Rollback re-lock could not be re-confirmed. Check config manually. ${relock.error ?? ""}`.trimEnd(),
      );
      // An unsafe config path (for example a symlink planted after shields up)
      // fails unlock and then fails the same re-lock. Restrictive policy is
      // already restored. Clearing the provisional DOWN record keeps status
      // honest instead of reporting DOWN/permissive for an unlock that never
      // completed (#8804 / #8198 status integrity).
      if (
        initialMode === "locked" &&
        relock.error !== undefined &&
        isUnsafeShieldsConfigPathError(relock.error)
      ) {
        const timerCancellation = killTimer(sandboxName);
        timerAuthorityRevoked = timerCancellation.authorityRevoked;
        if (!timerCancellation.authorityRevoked) {
          console.error(
            `  Warning: Restrictive policy was restored, but auto-restore timer authority could not be revoked: ${timerCancellation.warnings.join("; ")}`,
          );
        }
        restoreShieldsStateSnapshot(sandboxName, initialState);
        console.error(
          "  Restrictive policy restored and provisional Shields down cleared. The config path remains unsafe; restore a regular config file before retrying.",
        );
        return { outcome: "lockdown_restored", timerAuthorityRevoked };
      }
    }
  } else {
    console.error("  Warning: Policy restore failed during rollback.");
  }
  if (rollbackChattrApplied !== null && rollbackFileHashes !== null) {
    if (!timerAuthorityRevoked) {
      const timerCancellation = killTimer(sandboxName);
      timerAuthorityRevoked = timerCancellation.authorityRevoked;
      if (!timerCancellation.authorityRevoked) {
        console.error(
          `  Warning: Lockdown was restored, but auto-restore timer authority could not be revoked: ${timerCancellation.warnings.join("; ")}`,
        );
      }
    }
    saveShieldsState(sandboxName, {
      shieldsDown: false,
      shieldsDownAt: null,
      shieldsDownTimeout: null,
      shieldsDownReason: null,
      shieldsDownPolicy: null,
      chattrApplied: rollbackChattrApplied,
      fileHashes: rollbackFileHashes,
    });
    console.error(
      initialMode === "mutable_default"
        ? "  Fail-closed lockdown applied; the original mutable-default posture was not restored."
        : "  Lockdown restored. Config was never left unguarded.",
    );
    return { outcome: "lockdown_restored", timerAuthorityRevoked };
  }
  console.error("  Config remains unlocked — manual intervention required.");
  printManualRelockRecoveryHint(sandboxName);
  return { outcome: "manual_intervention_required", timerAuthorityRevoked };
}

interface LockdownActivationResult {
  ok: boolean;
  error?: string;
  chattrApplied?: boolean;
  fileHashes?: { [path: string]: string };
  managedMcpOmissions?: ManagedMcpPolicyOmission[];
}

function activateLockdownFromSnapshot(
  sandboxName: string,
  snapshotPath: string,
  allowLegacyHermesProtocol = false,
  cachedTarget?: AgentConfigTarget,
  cachedProtocol?: HermesShieldsProtocol,
  restoreOptions: ShieldsPolicySnapshotRestoreOptions = {},
): LockdownActivationResult {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return { ok: false, error: "saved snapshot is missing" };
  }

  let restoreResult: ShieldsPolicySnapshotRestoreResult;
  try {
    restoreResult = applyShieldsPolicySnapshot(sandboxName, snapshotPath, restoreOptions);
  } catch (error) {
    return {
      ok: false,
      error: `policy restore preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
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
    ...(restoreResult.managedMcpOmissions
      ? { managedMcpOmissions: restoreResult.managedMcpOmissions }
      : {}),
  };
}

function recoverExpiredAutoRestoreInline(
  sandboxName: string,
  state: ShieldsState & { _isCorrupt?: boolean; _corruptError?: string },
): { attempted: boolean; restored: boolean } {
  if (state._isCorrupt) return { attempted: false, restored: false };
  if (state.shieldsDown !== true) return { attempted: false, restored: false };

  const marker = readTimerMarker(sandboxName);
  if (marker && isExactLiveFutureTimerAuthority(marker)) {
    return { attempted: false, restored: false };
  }

  const snapshotPath = marker?.snapshotPath ?? state.shieldsPolicySnapshotPath;
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    console.error(
      "  Recovery warning: DOWN state has no usable timer authority or restrictive policy snapshot.",
    );
    return { attempted: true, restored: false };
  }

  console.error(
    marker
      ? "  Warning: auto-restore timer authority is expired, invalid, or no longer live; attempting inline restore."
      : "  Warning: DOWN state has a missing or malformed auto-restore marker; attempting inline restore under the lifecycle gate.",
  );

  if (marker?.processToken && /^[0-9a-f]{32}$/.test(marker.processToken)) {
    try {
      synchronizeAutoRestoreTransition(sandboxName, marker.processToken, marker.snapshotPath, {
        expiredTimerRecovery: true,
        retainTransition: true,
        assertTakeoverAuthority: () => assertTimerMarkerGeneration(sandboxName, marker),
      });
    } catch (error) {
      if (isDurableContainmentFailure(error)) throw error;
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

  const cachedTarget = marker ? resolvePersistedAutoRestoreTarget(sandboxName, marker) : undefined;
  const activation = activateLockdownFromSnapshot(
    sandboxName,
    snapshotPath,
    marker?.allowLegacyHermesProtocol === true,
    cachedTarget,
    undefined,
    marker?.processToken && /^[0-9a-f]{32}$/.test(marker.processToken)
      ? {
          transitionProcessToken: marker.processToken,
          deadlineAuthoritative: true,
          expiredTimerRecovery: true,
        }
      : {},
  );
  const nowIso = new Date().toISOString();
  if (!activation.ok) {
    appendAuditEntry({
      action: "shields_up_failed",
      sandbox: sandboxName,
      timestamp: nowIso,
      restored_by: "auto_timer",
      policy_snapshot: snapshotPath,
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
  if (marker?.processToken && /^[0-9a-f]{32}$/.test(marker.processToken)) {
    clearShieldsDownTransition(sandboxName, marker.processToken);
  }
  clearTimerMarker(sandboxName);
  appendAuditEntry({
    action: "shields_auto_restore",
    sandbox: sandboxName,
    timestamp: nowIso,
    restored_by: "auto_timer",
    policy_snapshot: snapshotPath,
    restored_at: nowIso,
    ...(activation.managedMcpOmissions?.length
      ? {
          warning: `Inline auto-restore omitted ${String(
            activation.managedMcpOmissions.length,
          )} unproven managed MCP policy entries`,
        }
      : {}),
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
  throwOnError?: boolean;
  allowLegacyHermesProtocol?: boolean;
  // Internal rebuild lease: once the deadline expires, the detached recovery
  // owner defers while this exact process is alive and retries transient
  // restore failures after owner death. Interactive shields-down never sets it.
  deferAutoRestoreWhileOwnerAlive?: boolean;
  processToken?: string;
}

type RecoveredShieldsDownCompletion = {
  readonly alreadyCommitted: boolean;
  readonly audit: Parameters<typeof appendAuditEntry>[0];
  readonly marker: TimerMarker | null;
  readonly authority: ShieldsDownTransition | null;
  readonly transition: ShieldsDownTransition | null;
};

function prepareRecoveredShieldsDownCompletion(
  sandboxName: string,
  target: AgentConfigTarget,
  state: LoadedShieldsState,
): RecoveredShieldsDownCompletion {
  if (
    !state.shieldsDownAt ||
    !Number.isFinite(new Date(state.shieldsDownAt).getTime()) ||
    typeof state.shieldsDownTimeout !== "number" ||
    !state.shieldsDownPolicy ||
    !state.shieldsPolicySnapshotPath ||
    !fs.existsSync(state.shieldsPolicySnapshotPath)
  ) {
    throw new Error(
      "Interrupted Hermes Shields down recovery is missing its exact persisted completion state",
    );
  }
  const audit: Parameters<typeof appendAuditEntry>[0] = {
    action: "shields_down",
    sandbox: sandboxName,
    timestamp: state.shieldsDownAt,
    timeout_seconds: state.shieldsDownTimeout,
    reason: state.shieldsDownReason ?? undefined,
    policy_applied: state.shieldsDownPolicy,
    policy_snapshot: state.shieldsPolicySnapshotPath,
  };
  const marker = readTimerMarker(sandboxName);
  if (!marker) {
    throw new Error(
      "Interrupted Hermes Shields down recovery lost its exact auto-restore timer authority",
    );
  }
  if (
    !marker.processToken ||
    !/^[0-9a-f]{32}$/.test(marker.processToken) ||
    marker.snapshotPath !== state.shieldsPolicySnapshotPath ||
    marker.agentName !== target.agentName ||
    marker.configPath !== target.configPath ||
    marker.configDir !== target.configDir
  ) {
    throw new Error(
      "Interrupted Hermes Shields down recovery no longer matches its exact timer authority",
    );
  }
  const transition = readShieldsDownTransition(sandboxName, marker.processToken);
  if (
    !transition ||
    transition.snapshotPath !== marker.snapshotPath ||
    !sameManagedMcpPolicyKeys(transition.managedMcpPolicyKeys, state.shieldsManagedMcpPolicyKeys)
  ) {
    throw new Error(
      "Interrupted Hermes Shields down recovery no longer matches its timer-bound transition",
    );
  }
  if (transition.phase === "policy_rejected") {
    throw new Error("A rejected Shields down transition cannot be recovered as mutable");
  }
  requireShieldsDownForwardPolicy(transition);
  return {
    alreadyCommitted: transition.phase === "active",
    audit,
    marker,
    authority: transition,
    transition: transition.phase === "preparing" ? transition : null,
  };
}

function applyRecoveredShieldsDownForwardPolicy(
  sandboxName: string,
  completion: RecoveredShieldsDownCompletion,
): void {
  if (!completion.authority) return;
  assertRecoveredShieldsDownAuthority(sandboxName, completion, completion.authority.phase);
  const policyPath = requireShieldsDownForwardPolicy(completion.authority);
  const result = run(buildPolicySetCommand(policyPath, sandboxName), { ignoreError: true });
  if (result.status !== 0) {
    throw new Error("Interrupted Shields down forward policy could not be reapplied");
  }
  requireShieldsDownForwardPolicy(completion.authority);
  assertRecoveredShieldsDownAuthority(sandboxName, completion, completion.authority.phase);
}

function assertRecoveredShieldsDownAuthority(
  sandboxName: string,
  completion: RecoveredShieldsDownCompletion,
  phase: ShieldsDownTransition["phase"],
): void {
  if (!completion.marker || !completion.authority) return;
  assertExactLiveFutureTimerAuthority(sandboxName, completion.marker);
  const current = readShieldsDownTransition(sandboxName, completion.authority.processToken);
  if (!current || !sameShieldsDownTransitionAuthority(current, completion.authority, phase)) {
    throw new Error("Interrupted Hermes Shields down recovery lost its exact transition authority");
  }
  requireShieldsDownForwardPolicy(current);
  assertExactLiveFutureTimerAuthority(sandboxName, completion.marker);
}

function assertFreshShieldsDownAuthority(
  sandboxName: string,
  marker: TimerMarker,
  transition: ShieldsDownTransition,
  phase: ShieldsDownTransition["phase"],
): void {
  assertExactLiveFutureTimerAuthority(sandboxName, marker);
  const current = readShieldsDownTransition(sandboxName, transition.processToken);
  if (!current || !sameShieldsDownTransitionAuthority(current, transition, phase)) {
    throw new Error("Fresh Shields down lost its exact timer-bound transition authority");
  }
  requireShieldsDownForwardPolicy(current);
  assertExactLiveFutureTimerAuthority(sandboxName, marker);
}

function resolveReleasedProviderShieldsDownTarget(
  sandboxName: string,
  state: LoadedShieldsState,
  allowLegacyHermesProtocol: boolean,
): AgentConfigTarget | null {
  if (!state.shieldsDown) return null;
  const marker = readTimerMarker(sandboxName);
  if (!marker?.processToken || !/^[0-9a-f]{32}$/.test(marker.processToken)) return null;
  const transition = readShieldsDownTransition(sandboxName, marker.processToken);
  if (transition?.phase !== "preparing") return null;
  const target = ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
  if (target.agentName !== "hermes") return null;
  return requireHermesShieldsProtocol(sandboxName, target, allowLegacyHermesProtocol) ===
    "provider-state-mutation-v2"
    ? target
    : null;
}

function finishRecoveredHermesShieldsDown(
  sandboxName: string,
  completion: RecoveredShieldsDownCompletion,
): void {
  if (completion.authority) {
    assertRecoveredShieldsDownAuthority(sandboxName, completion, completion.authority.phase);
  }
  const convergence = waitForHermesInferenceRouteConvergence(sandboxName, { run });
  if (!convergence.ok) {
    const status = convergence.httpStatus > 0 ? `HTTP ${convergence.httpStatus}` : "unavailable";
    throw new Error(
      `Hermes inference route did not converge after policy transition (${status}; ${convergence.attempts} attempts)`,
    );
  }
  if (completion.authority) {
    assertRecoveredShieldsDownAuthority(sandboxName, completion, completion.authority.phase);
  }
  if (completion.transition) {
    writeShieldsDownTransition({ ...completion.transition, phase: "active" }, "preparing");
  }
  if (completion.authority) {
    assertRecoveredShieldsDownAuthority(sandboxName, completion, "active");
  }
}

function failRecoveredHermesShieldsDown(
  sandboxName: string,
  target: AgentConfigTarget,
  state: LoadedShieldsState,
  completion: RecoveredShieldsDownCompletion,
  allowLegacyHermesProtocol: boolean,
  error: unknown,
  throwOnError: boolean | undefined,
): never {
  const message = error instanceof Error ? error.message : String(error);
  const rollback = rollbackShieldsDown(
    sandboxName,
    target,
    state.shieldsPolicySnapshotPath as string,
    "locked",
    state,
    allowLegacyHermesProtocol,
    "provider-state-mutation-v2",
  );
  if (completion.transition && rollback.timerAuthorityRevoked) {
    clearShieldsDownTransition(sandboxName, completion.transition.processToken);
  }
  console.error(`  ERROR: ${message}`);
  const timerAuthority = describeRollbackTimerAuthority(
    completion.transition !== null,
    rollback.timerAuthorityRevoked,
  );
  if (rollback.outcome === "lockdown_restored") {
    console.error(`  Interrupted config unlock was rolled back to lockdown.${timerAuthority}`);
  } else {
    console.error(
      `  Interrupted config unlock recovery is incomplete.${timerAuthority} Manual intervention is required.`,
    );
  }
  return failShieldsCommand(message, throwOnError);
}

type FreshShieldsDownTimerStart = {
  transition: ShieldsDownTransition;
  timerAuthority: TimerMarker;
  policyPathForApply: string;
};

function startFreshShieldsDownTimer(input: {
  sandboxName: string;
  timeoutSeconds: number;
  processToken: string;
  snapshotPath: string;
  target: AgentConfigTarget;
  allowLegacyHermesProtocol: boolean;
  deferAutoRestoreWhileOwnerAlive: boolean;
  managedMcpPolicyKeys: string[];
  policyFile: string;
}): FreshShieldsDownTimerStart {
  const {
    sandboxName,
    timeoutSeconds,
    processToken,
    snapshotPath,
    target,
    allowLegacyHermesProtocol,
    deferAutoRestoreWhileOwnerAlive,
    managedMcpPolicyKeys,
    policyFile,
  } = input;
  const restoreAt = new Date(Date.now() + timeoutSeconds * 1000);
  const timerScript = path.join(__dirname, "timer.ts");
  const timerScriptJs = timerScript.replace(/\.ts$/, ".js");
  const actualScript = fs.existsSync(timerScriptJs) ? timerScriptJs : timerScript;
  let timerChild: ReturnType<typeof fork> | null = null;
  let transition: ShieldsDownTransition | null = null;

  try {
    const ownerStartIdentity =
      readProcessStartIdentity(process.pid) ??
      (() => {
        throw new Error("Cannot identify shields-down owner process");
      })();
    const forwardPolicy = publishShieldsDownForwardPolicy(sandboxName, processToken, policyFile);
    transition = {
      version: 1,
      phase: "preparing",
      ownerPid: process.pid,
      ownerStartIdentity,
      processToken,
      sandboxName,
      snapshotPath,
      managedMcpPolicyKeys,
      forwardPolicy,
    };
    const leaseOwnerPid = deferAutoRestoreWhileOwnerAlive ? transition.ownerPid : null;
    const leaseOwnerStartIdentity = deferAutoRestoreWhileOwnerAlive
      ? transition.ownerStartIdentity
      : null;
    // Publish forward ownership before authorizing the timer so an early
    // deadline waits for active or owner death instead of racing mutations.
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
        allowLegacyHermesProtocol ? "1" : "0",
        leaseOwnerPid === null ? "" : String(leaseOwnerPid),
        leaseOwnerStartIdentity ?? "",
        target.agentName ?? "",
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    if (!timerChild.pid) throw new Error("auto-restore timer did not report a process id");
    const timerProcessStartIdentity = waitForTimerProcessStartIdentity(timerChild.pid);
    if (!timerProcessStartIdentity) {
      throw new Error("auto-restore timer process identity could not be verified");
    }
    const timerMarker: TimerMarker = {
      pid: timerChild.pid,
      sandboxName,
      snapshotPath,
      restoreAt: restoreAt.toISOString(),
      processToken,
      timerProcessStartIdentity,
      allowLegacyHermesProtocol,
      agentName: target.agentName,
      configPath: target.configPath,
      configDir: target.configDir,
      ...(leaseOwnerPid !== null && leaseOwnerStartIdentity
        ? { leaseOwnerPid, leaseOwnerStartIdentity }
        : {}),
    };
    writeTimerMarkerAtomic(sandboxName, timerMarker);
    if (!timerChild.send({ type: "authorize", processToken, acknowledge: true })) {
      throw new Error("auto-restore timer authorization channel closed early");
    }
    if (!waitForTimerAuthorizationProof(timerMarker)) {
      throw new Error("auto-restore timer did not publish exact authorization proof");
    }
    assertExactLiveFutureTimerAuthority(sandboxName, timerMarker);
    timerChild.disconnect();
    timerChild.unref();
    return {
      transition,
      timerAuthority: timerMarker,
      policyPathForApply: forwardPolicy.path,
    };
  } catch (error) {
    clearTimerMarker(sandboxName);
    if (transition) clearShieldsDownTransition(sandboxName, processToken);
    if (timerChild) {
      try {
        timerChild.disconnect();
      } catch {
        // The failed child may already have closed IPC.
      }
      timerChild.unref();
    }
    throw error;
  }
}

function shieldsDownWithoutHostLock(sandboxName: string, opts: ShieldsDownOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  const retainedProviderTarget = resolveActiveHermesRuntimeProviderMutationTarget(sandboxName);
  if (state._isCorrupt) {
    if (retainedProviderTarget) {
      runHermesProviderProtectionTransition(
        sandboxName,
        retainedProviderTarget,
        "locked",
        "locked",
      );
    }
    console.error("  Shields state is corrupt; refusing to unlock.");
    console.error(
      `  Recovery: inspect the reported state error and restore trusted state for ${sandboxName} before retrying.`,
    );
    return failShieldsCommand(`Shields state is corrupt for ${sandboxName}`, opts.throwOnError);
  }
  let recoveredProviderTarget: AgentConfigTarget | null = null;
  if (retainedProviderTarget && state.shieldsDown !== true) {
    runHermesProviderProtectionTransition(sandboxName, retainedProviderTarget, "locked", "locked");
    recoveredProviderTarget = retainedProviderTarget;
  }
  const initialMode = deriveShieldsMode(state, state._hasStateFile);
  if (state.shieldsDown) {
    // Provider release deliberately precedes route convergence and the final
    // timer-bound transition commit. A process can therefore die after the
    // durable provider claim is gone while the exact host transition remains
    // in preparing. Treat that marker as recovery authority too: verify (or
    // repair) mutable posture, converge the route, then commit it active.
    const completionTarget =
      retainedProviderTarget ??
      resolveReleasedProviderShieldsDownTarget(
        sandboxName,
        state,
        opts.allowLegacyHermesProtocol === true,
      );
    if (completionTarget) {
      const completion = prepareRecoveredShieldsDownCompletion(
        sandboxName,
        completionTarget,
        state,
      );
      // The provisional DOWN record can outlive a process that lost its
      // provider-unlock response. Recovery first restores the retained plan's
      // restrictive rollback. Reconcile the recorded mutable posture and
      // verify it before treating this retry as complete.
      try {
        applyRecoveredShieldsDownForwardPolicy(sandboxName, completion);
        if (retainedProviderTarget) {
          runHermesProviderProtectionTransition(
            sandboxName,
            retainedProviderTarget,
            "locked",
            "locked",
          );
        }
        if (completion.authority) {
          assertRecoveredShieldsDownAuthority(sandboxName, completion, completion.authority.phase);
        }
        unlockAgentConfigUnderMutationLock(
          sandboxName,
          completionTarget,
          false,
          "provider-state-mutation-v2",
        );
        if (completion.authority) {
          assertRecoveredShieldsDownAuthority(sandboxName, completion, completion.authority.phase);
        }
        finishRecoveredHermesShieldsDown(sandboxName, completion);
      } catch (error) {
        return failRecoveredHermesShieldsDown(
          sandboxName,
          completionTarget,
          state,
          completion,
          opts.allowLegacyHermesProtocol === true,
          error,
          opts.throwOnError,
        );
      }
      if (!completion.alreadyCommitted) {
        if (completion.authority) {
          assertRecoveredShieldsDownAuthority(sandboxName, completion, "active");
        }
        appendAuditEntry(completion.audit);
      }
      console.log(`  Recovered interrupted config unlock for ${sandboxName}.`);
      return;
    }
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
  const target =
    recoveredProviderTarget ?? ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
  const protocol: HermesShieldsProtocol = recoveredProviderTarget
    ? "provider-state-mutation-v2"
    : requireHermesShieldsProtocol(sandboxName, target, opts.allowLegacyHermesProtocol === true);

  // Refuse an unsafe config path before timer, host state, or policy mutation.
  // Otherwise unlock rejects the path after the provisional DOWN/permissive
  // record is already live, and status integrity fails when re-lock cannot
  // reseal the same unsafe path (#8804).
  try {
    assertShieldsDownConfigPathsSafe(sandboxName, target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ERROR: ${message}`);
    console.error("  Shields down did not take effect. `shields status` continues to report `UP`.");
    return failShieldsCommand(message, opts.throwOnError);
  }

  // Kill stale auto-restore markers only when this command will actually
  // transition into shields-down. A repeated shields-down must not cancel the
  // active timer and leave the sandbox unlocked indefinitely.
  const timerCancellation = killTimer(sandboxName);
  if (!timerCancellation.authorityRevoked) {
    const detail = timerCancellation.warnings.join("; ");
    console.error(`  Cannot revoke stale auto-restore timer authority: ${detail}`);
    return failShieldsCommand(
      `Cannot revoke stale auto-restore timer authority for ${sandboxName}`,
      opts.throwOnError,
    );
  }

  const timeoutSeconds = parseDuration(opts.timeout || `${DEFAULT_TIMEOUT_SECONDS}`);
  const reason = opts.reason || null;
  const policyName = opts.policy || "permissive";
  const processToken = opts.processToken ?? randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(processToken)) {
    throw new Error("Invalid shields-down recovery process token");
  }

  // 1. Capture current policy snapshot
  console.log("  Capturing current policy snapshot...");
  let rawPolicy: string;
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName));
  } catch {
    rawPolicy = "";
  }

  const policyYaml = parseCurrentPolicy(rawPolicy);
  if (!policyYaml) {
    console.error("  Cannot capture current policy. Is the sandbox running?");
    return failShieldsCommand("Cannot capture current policy", opts.throwOnError);
  }

  let managedMcpPolicies: ReturnType<typeof inspectExactManagedMcpPolicies>;
  try {
    managedMcpPolicies = resolveExactManagedMcpPolicies(sandboxName, policyYaml);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Cannot preserve managed MCP policy state: ${message}`);
    return failShieldsCommand(
      `Cannot preserve managed MCP policy state: ${message}`,
      opts.throwOnError,
    );
  }
  const snapshotManagedMcpPolicyKeys = managedMcpPolicies.map((policy) => policy.key);

  const snapshotPath = path.join(
    STATE_DIR,
    `policy-snapshot-${sandboxName}-${processToken}-${randomBytes(8).toString("hex")}.yaml`,
  );
  writeShieldsFileAtomicDurable(snapshotPath, policyYaml, 0o600, false);
  console.log(`  Saved: ${snapshotPath}`);

  // 2. Determine and apply relaxed policy
  let policyFile: string;
  let policyFileIsTemp = false;
  try {
    if (policyName === "permissive") {
      const basePath = resolvePermissivePolicyPath(sandboxName);
      // Union the live sandbox's filesystem_policy.read_only/read_write into
      // the static permissive baseline. OpenShell rejects removal of those
      // paths on a live sandbox, and runtime-injected entries (/proc on
      // GPU, /opt/hermes on Hermes, /home/linuxbrew on post-#3913 OpenClaw,
      // etc.) are not present in the static YAML. See #3942, #3957, #3168.
      // policyYaml is the pre-parsed body we already captured for the
      // snapshot above — reuse it instead of re-fetching. Exact generated MCP
      // entries are overlaid without copying any unrelated live egress.
      policyFile = buildRuntimePermissivePolicy(basePath, {
        livePolicyYaml: policyYaml,
        managedMcpPolicies,
        readBasePolicy: () => fs.readFileSync(basePath, "utf-8"),
      });
      policyFileIsTemp = policyFile !== basePath;
    } else if (fs.existsSync(policyName)) {
      const basePath = path.resolve(policyName);
      policyFile = buildRuntimeManagedMcpPolicy(basePath, {
        managedMcpPolicies,
        readBasePolicy: () => fs.readFileSync(basePath, "utf-8"),
      });
      policyFileIsTemp = policyFile !== basePath;
    } else {
      console.error(`  Unknown policy "${policyName}". Use "permissive" or a path to a YAML file.`);
      fs.rmSync(snapshotPath, { force: true });
      return failShieldsCommand(`Unknown policy "${policyName}"`, opts.throwOnError);
    }
  } catch (error) {
    fs.rmSync(snapshotPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Cannot compose Shields-down policy: ${message}`);
    return failShieldsCommand(`Cannot compose Shields-down policy: ${message}`, opts.throwOnError);
  }

  // Every exit after the permissive merge builds a temp policy directory must
  // remove it. The apply below has always cleaned up, but the timer-failure
  // and saveShieldsState-failure early exits between here and there historically
  // leaked one 0700 nemoclaw-permissive-runtime-* directory per failed
  // attempt. Route all three exits through one cleanup. See #7964.
  const cleanupRuntimePolicyFile = () => {
    if (policyFileIsTemp) {
      cleanupTempDir(policyFile, "nemoclaw-permissive-runtime");
    }
  };

  const now = new Date().toISOString();
  // Commit the host-side recovery authority before weakening policy or file
  // permissions. If this process is killed later, the detached timer and its
  // marker already exist and the persisted state honestly reports shields
  // down. A crash can therefore never leave an untracked mutable window.
  let timerStart: FreshShieldsDownTimerStart;
  try {
    timerStart = startFreshShieldsDownTimer({
      sandboxName,
      timeoutSeconds,
      processToken,
      snapshotPath,
      target,
      allowLegacyHermesProtocol: opts.allowLegacyHermesProtocol === true,
      deferAutoRestoreWhileOwnerAlive: opts.deferAutoRestoreWhileOwnerAlive === true,
      managedMcpPolicyKeys: snapshotManagedMcpPolicyKeys,
      policyFile,
    });
  } catch (error) {
    cleanupRuntimePolicyFile();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Cannot start auto-restore timer: ${message}`);
    return failShieldsCommand(`Cannot start auto-restore timer: ${message}`, opts.throwOnError);
  }
  let { transition } = timerStart;
  const { timerAuthority, policyPathForApply } = timerStart;

  try {
    if (transition && timerAuthority) {
      assertFreshShieldsDownAuthority(sandboxName, timerAuthority, transition, "preparing");
    }
    saveShieldsState(sandboxName, {
      shieldsDown: true,
      shieldsDownAt: now,
      shieldsDownTimeout: timeoutSeconds,
      shieldsDownReason: reason,
      shieldsDownPolicy: policyName,
      shieldsPolicySnapshotPath: snapshotPath,
      shieldsManagedMcpPolicyKeys: snapshotManagedMcpPolicyKeys,
    });
  } catch (error) {
    if (transition) {
      const timerCancellation = killTimer(sandboxName);
      if (timerCancellation.authorityRevoked) {
        clearShieldsDownTransition(sandboxName, transition.processToken);
      }
    }
    cleanupRuntimePolicyFile();
    throw error;
  }

  if (transition && timerAuthority) {
    try {
      assertFreshShieldsDownAuthority(sandboxName, timerAuthority, transition, "preparing");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rollback = rollbackShieldsDown(
        sandboxName,
        target,
        snapshotPath,
        initialMode,
        state,
        opts.allowLegacyHermesProtocol === true,
        protocol,
      );
      if (rollback.timerAuthorityRevoked) {
        clearShieldsDownTransition(sandboxName, transition.processToken);
      }
      cleanupRuntimePolicyFile();
      console.error(`  ERROR: ${message}`);
      if (rollback.outcome === "mutable_default_restored") {
        console.error(
          "  Timer handoff failed before policy mutation; original state was restored.",
        );
      } else if (rollback.outcome === "lockdown_restored") {
        console.error("  Timer handoff failed before policy mutation; lockdown was restored.");
      } else {
        console.error("  Timer handoff failed; manual recovery is required.");
      }
      return failShieldsCommand(message, opts.throwOnError);
    }
  }

  console.log(`  Applying ${policyName} policy...`);
  let policySetResult: ReturnType<typeof run>;
  try {
    policySetResult = run(buildPolicySetCommand(policyPathForApply, sandboxName), {
      ignoreError: true,
    });
  } finally {
    cleanupRuntimePolicyFile();
  }
  if (policySetResult.status !== 0) {
    // The permissive policy was rejected before it applied — for example,
    // OpenShell refuses a live Landlock change on a sandbox whose policy is
    // sealed at startup (Deep Agents). Nothing was weakened: configuration is
    // still locked and the restrictive policy is unchanged. The provisional
    // Shields down record written above therefore conflicts with the actual
    // posture. Clear it, cancel the now-pointless timer and transition, and
    // fail closed. Otherwise `shields status` would report `DOWN`/permissive
    // for an unlock that never happened.
    // See #8198.
    try {
      saveShieldsState(sandboxName, {
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
        shieldsPolicySnapshotPath: null,
      });
    } catch (stateErr) {
      // Clearing the provisional Shields down record failed, so on disk the
      // record still says `DOWN`. Mark the retained transition as rejected so
      // status derives the restrictive posture instead of treating the
      // provisional record as a completed unlock. The timer and transition
      // remain the recovery authority and reclaim the restrictive snapshot.
      if (transition) {
        try {
          transition = { ...transition, phase: "policy_rejected" };
          writeShieldsDownTransition(transition, "preparing");
        } catch (transitionErr) {
          const transitionMessage =
            transitionErr instanceof Error ? transitionErr.message : String(transitionErr);
          console.error(
            `  The rejected Shields down transition could not be recorded: ${transitionMessage}`,
          );
        }
      }
      const stateMessage = stateErr instanceof Error ? stateErr.message : String(stateErr);
      console.error(
        `  ERROR: Could not apply the ${policyName} policy, and clearing the provisional Shields down record failed: ${stateMessage}`,
      );
      console.error("  The scheduled auto-restore remains authoritative.");
      return failShieldsCommand(`Could not apply ${policyName} policy`, opts.throwOnError);
    }
    const timerCancellation = killTimer(sandboxName);
    if (transition && timerCancellation.authorityRevoked) {
      clearShieldsDownTransition(sandboxName, transition.processToken);
    }
    console.error(
      `  ERROR: Could not apply the ${policyName} policy; the sandbox remains in the Shields up state.`,
    );
    console.error("  Shields down did not take effect. `shields status` continues to report `UP`.");
    return failShieldsCommand(`Could not apply ${policyName} policy`, opts.throwOnError);
  }

  // 2b. Return config to default mutable state.
  //     OpenClaw uses sandbox:sandbox 0660/2770 here so the gateway UID, which
  //     is a member of the sandbox group, can mutate runtime config.
  console.log(`  Unlocking ${target.agentName} config (${target.configPath})...`);
  let inferenceRouteConvergenceFailed = false;
  try {
    if (transition && timerAuthority) {
      assertFreshShieldsDownAuthority(sandboxName, timerAuthority, transition, "preparing");
    }
    unlockAgentConfig(
      sandboxName,
      target,
      initialMode === "locked",
      opts.allowLegacyHermesProtocol === true,
      protocol,
    );
    if (target.agentName === "hermes") {
      console.log("  Confirming Hermes inference route after policy transition...");
      const convergence = waitForHermesInferenceRouteConvergence(sandboxName, { run });
      if (!convergence.ok) {
        inferenceRouteConvergenceFailed = true;
        const status =
          convergence.httpStatus > 0 ? `HTTP ${convergence.httpStatus}` : "unavailable";
        throw new Error(
          `Hermes inference route did not converge after policy transition (${status}; ${convergence.attempts} attempts)`,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const rollback = rollbackShieldsDown(
      sandboxName,
      target,
      snapshotPath,
      initialMode,
      state,
      opts.allowLegacyHermesProtocol === true,
      protocol,
    );
    if (transition && rollback.timerAuthorityRevoked) {
      clearShieldsDownTransition(sandboxName, transition.processToken);
    }
    console.error(`  ERROR: ${message}`);
    const timerAuthority = describeRollbackTimerAuthority(
      transition !== null,
      rollback.timerAuthorityRevoked,
    );
    if (rollback.outcome === "mutable_default_restored") {
      console.error(
        `  Config mutation failed; the original mutable-default posture was restored.${timerAuthority}`,
      );
    } else if (rollback.outcome === "lockdown_restored") {
      console.error(
        `  Config did not reach the mutable-default state; fail-closed lockdown was restored.${timerAuthority}`,
      );
    } else {
      console.error(
        `  Config rollback is incomplete.${timerAuthority} Manual intervention is required.`,
      );
    }
    if (inferenceRouteConvergenceFailed) {
      console.error(
        `  Recover the Hermes inference route, then re-run \`nemoclaw ${sandboxName} shields down\`.`,
      );
    } else {
      console.error(
        `  Re-run \`nemoclaw ${sandboxName} shields down\` after correcting file ownership.`,
      );
    }
    return failShieldsCommand(message, opts.throwOnError);
  }

  if (transition) {
    try {
      if (!timerAuthority) {
        throw new Error("Fresh Shields down lost its timer authorization proof");
      }
      assertFreshShieldsDownAuthority(sandboxName, timerAuthority, transition, "preparing");
      transition = { ...transition, phase: "active" };
      writeShieldsDownTransition(transition, "preparing");
      assertFreshShieldsDownAuthority(sandboxName, timerAuthority, transition, "active");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const rollback = rollbackShieldsDown(
        sandboxName,
        target,
        snapshotPath,
        initialMode,
        state,
        opts.allowLegacyHermesProtocol === true,
        protocol,
      );
      if (rollback.timerAuthorityRevoked) {
        clearShieldsDownTransition(sandboxName, transition.processToken);
      }
      console.error(`  ERROR: ${message}`);
      const timerAuthority = describeRollbackTimerAuthority(true, rollback.timerAuthorityRevoked);
      if (rollback.outcome === "mutable_default_restored") {
        console.error(
          `  Auto-restore handoff failed; the original mutable-default posture was restored.${timerAuthority}`,
        );
      } else if (rollback.outcome === "lockdown_restored") {
        console.error(`  Auto-restore handoff failed; lockdown was restored.${timerAuthority}`);
      } else {
        console.error(
          `  Auto-restore handoff failed; rollback is incomplete.${timerAuthority} Manual intervention is required.`,
        );
      }
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
  const mins = Math.floor(timeoutSeconds / 60);
  const secs = timeoutSeconds % 60;
  console.log(
    `  Config unlocked for ${sandboxName} (auto-lockdown in: ${mins}m${secs ? ` ${secs}s` : ""})`,
  );
  console.log("");
  console.log("  Sandbox is in default (mutable) state.");
  console.log(`  Run \`nemoclaw ${sandboxName} shields up\` to opt into lockdown.`);
}

function shieldsDown(sandboxName: string, opts: ShieldsDownOpts = {}): void {
  validateName(sandboxName, "sandbox name");
  const processToken = opts.processToken ?? randomBytes(16).toString("hex");
  const effectiveOpts = { ...opts, processToken };
  try {
    return withExpiredAutoRestoreDeadlineFence(
      sandboxName,
      "shields down",
      () => shieldsDownWithoutHostLock(sandboxName, effectiveOpts),
      processToken,
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
  const recoveredProviderTarget = recoverActiveHermesRuntimeProviderMutation(sandboxName);
  if (state._isCorrupt) {
    console.error("  Shields state is corrupt; refusing to raise shields.");
    console.error(
      `  Recovery: inspect the reported state error and restore trusted state for ${sandboxName} before retrying.`,
    );
    return failShieldsCommand(
      `Cannot raise shields while persisted shields state is corrupt for ${sandboxName}`,
      opts.throwOnError,
    );
  }
  // shieldsDown === false means explicitly locked by a previous shields-up.
  // undefined (no state file) means fresh sandbox — mutable default, allow shields-up.
  if (state.shieldsDown === false) {
    // Verify the sandbox filesystem still matches the locked posture. If a
    // host-root tamper has reverted protected perms or rewritten file
    // content (even when the mode/owner is restored), re-apply the lock
    // so the recovery hint surfaced by `shields status` actually works.
    const target =
      recoveredProviderTarget ?? ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
    if (
      !recoveredProviderTarget &&
      target.agentName === "hermes" &&
      inspectHermesShieldsProtocol(sandboxName, target) === "provider-state-mutation-v2"
    ) {
      runHermesProviderProtectionTransition(sandboxName, target, "locked", "locked");
    }
    const { issues } = verifyShieldsLockState(sandboxName, target, {
      verifyChattr: state.chattrApplied === true,
      verifyParentProtection: requiresProtectedSandboxParent(target),
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
    const protocol: HermesShieldsProtocol = recoveredProviderTarget
      ? "provider-state-mutation-v2"
      : requireHermesShieldsProtocol(sandboxName, target, opts.allowLegacyHermesProtocol === true);
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
  const target =
    recoveredProviderTarget ?? ensureConfigHashSensitiveFile(resolveAgentConfig(sandboxName));
  const protocol: HermesShieldsProtocol = recoveredProviderTarget
    ? "provider-state-mutation-v2"
    : requireHermesShieldsProtocol(sandboxName, target, opts.allowLegacyHermesProtocol === true);

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
    return withExpiredAutoRestoreDeadlineFence(sandboxName, "shields up", () =>
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
  verifyStateLockPlan?: (sandboxName: string, target: AgentConfigTarget) => string[];
};

function verifyHermesProviderMutableStatus(
  sandboxName: string,
  mode: "mutable_default" | "temporarily_unlocked",
  transition: ShieldsDownTransition | null,
  resolveConfig: typeof resolveAgentConfig,
): void {
  try {
    const target = ensureConfigHashSensitiveFile(resolveConfig(sandboxName));
    if (target.agentName !== "hermes") return;
    if (inspectHermesShieldsProtocol(sandboxName, target) !== "provider-state-mutation-v2") {
      return;
    }

    const marker = mode === "temporarily_unlocked" ? readTimerMarker(sandboxName) : null;
    const assertTimedAuthority = () => {
      if (mode !== "temporarily_unlocked") return;
      if (!marker || !transition || transition.phase !== "active") {
        throw new Error("Timed mutable status lost its exact active auto-restore authority");
      }
      assertFreshShieldsDownAuthority(sandboxName, marker, transition, "active");
    };

    assertTimedAuthority();
    runHermesProviderProtectionTransition(sandboxName, target, "mutable", "mutable");
    assertTimedAuthority();
    verifyHermesProviderMutablePosture(sandboxName, target);
    assertTimedAuthority();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const declared = mode === "temporarily_unlocked" ? "DOWN" : "NOT CONFIGURED";
    console.error(
      `  Shields: ${declared} (DRIFTED — declared mutable but runtime-provider verification failed)`,
    );
    console.error(`  Drift: ${message}`);
    console.error(
      `  Recovery: run \`nemoclaw ${sandboxName} shields up\` to reconcile and verify lockdown.`,
    );
    throw new DeferredShieldsExit("Mutable shields state has runtime-provider drift", 2);
  }
}

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
    console.error(`  Recovery warning: restore trusted state for ${sandboxName} before retrying.`);
    throw new DeferredShieldsExit("Shields state is corrupt", 1);
  }

  const transition = readTimerBoundShieldsDownTransition(sandboxName);
  if (transition?.phase === "preparing") {
    console.error("  Shields: ERROR (Shields down transition incomplete)");
    console.error("  The scheduled auto-restore remains authoritative.");
    throw new DeferredShieldsExit("Shields down transition is incomplete", 1);
  }

  const recoveredProviderTarget = recoverActiveHermesRuntimeProviderMutation(sandboxName);
  if (recoveredProviderTarget && posture.mode !== "locked") {
    console.error("  Shields: ERROR (runtime-provider recovery restored lockdown)");
    console.error(
      `  Recovery: retry the intended Shields transition for ${sandboxName}; persisted posture was not accepted as clean.`,
    );
    throw new DeferredShieldsExit(
      "Recovered runtime-provider mutation conflicts with persisted mutable posture",
      2,
    );
  }

  switch (posture.mode) {
    case "mutable_default":
      verifyHermesProviderMutableStatus(sandboxName, posture.mode, transition, resolveConfig);
      // NC-2227-02: Fresh sandbox with no shields history — do NOT claim locked
      console.log(`  Shields: ${posture.statusText}`);
      console.log("  Config is mutable. Run `nemoclaw <sandbox> shields up` to opt into lockdown.");
      return;

    case "locked": {
      // Cross-check the sandbox filesystem so a host-root tamper that reverts
      // protected perms back to a sandbox-writable state is surfaced as drift
      // instead of reported as a clean lockdown.
      let driftIssues: string[] = [];
      let planIssues: string[] = [];
      try {
        const target =
          recoveredProviderTarget ?? ensureConfigHashSensitiveFile(resolveConfig(sandboxName));
        if (
          !recoveredProviderTarget &&
          target.agentName === "hermes" &&
          inspectHermesShieldsProtocol(sandboxName, target) === "provider-state-mutation-v2"
        ) {
          runHermesProviderProtectionTransition(sandboxName, target, "locked", "locked");
        }
        try {
          planIssues = deps.verifyStateLockPlan
            ? deps.verifyStateLockPlan(sandboxName, target)
            : stateLockPlanCompatibilityIssues(
                stateDirLockExec(sandboxName),
                requireStateLockPlan(target),
                target.stateLockPlanInImage,
              );
          driftIssues.push(...planIssues.map((issue) => `state lock plan: ${issue}`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          driftIssues.push(`unable to verify state lock plan: ${msg}`);
        }
        try {
          driftIssues.push(
            ...verify(sandboxName, target, {
              verifyChattr: state.chattrApplied === true,
              verifyParentProtection: requiresProtectedSandboxParent(target),
              exec: (cmd: string[]) => privilegedSandboxExecCapture(sandboxName, cmd),
              assertLegacyLayout: assertNoLegacyStateLayout,
              expectedHashes: state.fileHashes,
            }).issues,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          driftIssues.push(`unable to verify agent config target: ${msg}`);
        }
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
            : planIssues.length > 0
              ? [
                  "  Recovery: rebuild the sandbox so its generated state lock plan matches the current agent manifest.",
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
      verifyHermesProviderMutableStatus(sandboxName, posture.mode, transition, resolveConfig);
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
    return withExpiredAutoRestoreDeadlineFence(
      sandboxName,
      "shields status",
      (allowInlineRecovery) => shieldsStatusWithoutHostLock(sandboxName, allowInlineRecovery, deps),
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
  const posture = getShieldsPosture(sandboxName, allowInlineRecovery);
  return posture.mode !== "error" && posture.mode !== "locked";
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
  applyShieldsPolicySnapshot,
  clearShieldsState,
  completeAutoRestoreTransition,
  DEFAULT_TIMEOUT_SECONDS,
  deriveShieldsMode,
  getShieldsPosture,
  inspectMutableConfigPerms,
  isShieldsDown,
  killTimer,
  lockAgentConfig,
  MAX_TIMEOUT_SECONDS,
  parseDuration,
  prepareAutoRestoreTransitionTakeover,
  repairMutableConfigPerms,
  resolvePersistedAutoRestoreTarget,
  restoreLockedStateDirStartupAccess,
  shieldsDown,
  shieldsStatus,
  shieldsUp,
  supportsHermesSealedShieldsTransactions,
  synchronizeAutoRestoreWithShieldsDown,
  unlockAgentConfig,
};
