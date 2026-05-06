// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Onboard session management — create, load, save, and update the
 * onboarding session file (~/.nemoclaw/onboard-session.json) with
 * step-level progress tracking and file-based locking.
 */

import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText, redactUrl } from "./redact";
import { isErrnoException } from "./errno";
import type { WebSearchConfig } from "./web-search";

export const SESSION_VERSION = 1;
export const SESSION_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
export const SESSION_FILE = path.join(SESSION_DIR, "onboard-session.json");
export const LOCK_FILE = path.join(SESSION_DIR, "onboard.lock");

import type { JsonValue, JsonObject } from "./json-types";

// Session-specific aliases for the shared JSON types.
type SessionJsonValue = JsonValue;
type UnknownRecord = JsonObject;
type StepStatus = "pending" | "in_progress" | "complete" | "failed" | "skipped";

const STEP_STATES: readonly StepStatus[] = [
  "pending",
  "in_progress",
  "complete",
  "failed",
  "skipped",
];
const VALID_STEP_STATES: ReadonlySet<string> = new Set(STEP_STATES);

// ── Types ────────────────────────────────────────────────────────

export interface StepState {
  status: StepStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface SessionFailure {
  step: string | null;
  message: string | null;
  recordedAt: string;
}

export interface SessionMetadata {
  gatewayName: string;
  fromDockerfile: string | null;
}

export interface Session {
  version: number;
  sessionId: string;
  resumable: boolean;
  status: string;
  mode: string;
  startedAt: string;
  updatedAt: string;
  lastStepStarted: string | null;
  lastCompletedStep: string | null;
  failure: SessionFailure | null;
  agent: string | null;
  sandboxName: string | null;
  provider: string | null;
  model: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
  policyPresets: string[] | null;
  messagingChannels: string[] | null;
  // SHA-256 hex digest of every legacy credential value successfully
  // written to the OpenShell gateway during this onboard session, keyed by
  // env-name. Persisted across process restarts so a `--resume` run that
  // skips already-completed upserts still knows the migration completed
  // earlier and can safely remove ~/.nemoclaw/credentials.json on the
  // final completeSession. Storing the hash (not just the env-name) lets
  // us detect when the legacy file value was edited between runs, when
  // the gateway provider was reset out-of-band, or when an unrelated
  // session is found on disk — in any of those cases the in-memory
  // migrated set is NOT seeded from the persisted record, so the cleanup
  // gate keeps the file until the *current* value is actually re-migrated.
  migratedLegacyValueHashes: Record<string, string> | null;
  gpuPassthrough: boolean;
  telegramConfig: TelegramConfig | null;
  metadata: SessionMetadata;
  steps: Record<string, StepState>;
}

export interface TelegramConfig {
  requireMention: boolean;
}

export interface LockInfo {
  pid: number;
  startedAt: string | null;
  command: string | null;
}

export interface LockResult {
  acquired: boolean;
  lockFile: string;
  stale: boolean;
  holderPid?: number;
  holderStartedAt?: string | null;
  holderCommand?: string | null;
}

export interface SessionUpdates {
  sandboxName?: string;
  provider?: string;
  model?: string;
  endpointUrl?: string;
  credentialEnv?: string;
  preferredInferenceApi?: string;
  nimContainer?: string;
  webSearchConfig?: WebSearchConfig | null;
  policyPresets?: string[];
  messagingChannels?: string[];
  migratedLegacyValueHashes?: Record<string, string>;
  gpuPassthrough?: boolean;
  telegramConfig?: TelegramConfig | null;
  metadata?: { gatewayName?: string; fromDockerfile?: string | null };
}

export interface DebugSessionSummary {
  version: number;
  sessionId: string;
  status: string;
  resumable: boolean;
  mode: string;
  startedAt: string;
  updatedAt: string;
  sandboxName: string | null;
  provider: string | null;
  model: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  policyPresets: string[] | null;
  gpuPassthrough: boolean;
  lastStepStarted: string | null;
  lastCompletedStep: string | null;
  failure: SessionFailure | null;
  steps: Record<string, StepState>;
}

// ── Helpers ──────────────────────────────────────────────────────

function ensureSessionDir(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

export function sessionPath(): string {
  return SESSION_FILE;
}

export function lockPath(): string {
  return LOCK_FILE;
}

function defaultSteps(): Record<string, StepState> {
  return {
    preflight: { status: "pending", startedAt: null, completedAt: null, error: null },
    gateway: { status: "pending", startedAt: null, completedAt: null, error: null },
    sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
    provider_selection: { status: "pending", startedAt: null, completedAt: null, error: null },
    inference: { status: "pending", startedAt: null, completedAt: null, error: null },
    openclaw: { status: "pending", startedAt: null, completedAt: null, error: null },
    agent_setup: { status: "pending", startedAt: null, completedAt: null, error: null },
    policies: { status: "pending", startedAt: null, completedAt: null, error: null },
  };
}

export function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: SessionJsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function readStringArray(value: SessionJsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readStringRecord(
  value: SessionJsonValue | undefined,
): Record<string, string> | null {
  if (!isObject(value)) return null;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === "string" && typeof v === "string") result[k] = v;
  }
  return result;
}

function isStepStatus(value: string): value is StepStatus {
  return VALID_STEP_STATES.has(value);
}

function readStepStatus(value: SessionJsonValue | undefined): StepStatus | null {
  if (typeof value !== "string") return null;
  return isStepStatus(value) ? value : null;
}

function parseWebSearchConfig(value: SessionJsonValue | undefined): WebSearchConfig | null {
  return isObject(value) && value.fetchEnabled === true ? { fetchEnabled: true } : null;
}

function parseTelegramConfig(value: unknown): TelegramConfig | null {
  if (!isObject(value)) return null;
  if (value.requireMention === true) return { requireMention: true };
  if (value.requireMention === false) return { requireMention: false };
  return null;
}

function parseSessionMetadata(value: SessionJsonValue | undefined): SessionMetadata | undefined {
  if (!isObject(value)) return undefined;
  return {
    gatewayName: readString(value.gatewayName) ?? "nemoclaw",
    fromDockerfile: readString(value.fromDockerfile),
  };
}

function parseStepState(value: SessionJsonValue | undefined): StepState | null {
  if (!isObject(value)) return null;
  const status = readStepStatus(value.status);
  if (!status) return null;
  return {
    status,
    startedAt: readString(value.startedAt),
    completedAt: readString(value.completedAt),
    error: redactSensitiveText(value.error),
  };
}

function parseLockInfo(value: SessionJsonValue | undefined): LockInfo | null {
  if (!isObject(value) || typeof value.pid !== "number") return null;
  return {
    pid: value.pid,
    startedAt: readString(value.startedAt),
    command: readString(value.command),
  };
}

// redactSensitiveText and redactUrl imported from ./redact (#2381).
export { redactSensitiveText, redactUrl };

export function sanitizeFailure(
  input:
    | { step?: SessionJsonValue; message?: SessionJsonValue; recordedAt?: SessionJsonValue }
    | null
    | undefined,
): SessionFailure | null {
  if (!input) return null;
  const step = readString(input.step);
  const message = redactSensitiveText(input.message);
  const recordedAt = readString(input.recordedAt) ?? new Date().toISOString();
  return step || message ? { step, message, recordedAt } : null;
}

export function validateStep(step: SessionJsonValue | undefined): boolean {
  return parseStepState(step) !== null;
}

// ── Session CRUD ─────────────────────────────────────────────────

export function createSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    version: SESSION_VERSION,
    sessionId: overrides.sessionId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    resumable: true,
    status: "in_progress",
    mode: overrides.mode ?? "interactive",
    startedAt: overrides.startedAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastStepStarted: overrides.lastStepStarted ?? null,
    lastCompletedStep: overrides.lastCompletedStep ?? null,
    failure: overrides.failure ?? null,
    agent: overrides.agent ?? null,
    sandboxName: overrides.sandboxName ?? null,
    provider: overrides.provider ?? null,
    model: overrides.model ?? null,
    endpointUrl: overrides.endpointUrl ?? null,
    credentialEnv: overrides.credentialEnv ?? null,
    preferredInferenceApi: overrides.preferredInferenceApi ?? null,
    nimContainer: overrides.nimContainer ?? null,
    webSearchConfig:
      overrides.webSearchConfig?.fetchEnabled === true ? { fetchEnabled: true } : null,
    policyPresets: readStringArray(overrides.policyPresets),
    messagingChannels: readStringArray(overrides.messagingChannels),
    migratedLegacyValueHashes: overrides.migratedLegacyValueHashes
      ? readStringRecord(overrides.migratedLegacyValueHashes)
      : null,
    gpuPassthrough: overrides.gpuPassthrough === true,
    telegramConfig: parseTelegramConfig(overrides.telegramConfig),
    metadata: {
      gatewayName: overrides.metadata?.gatewayName ?? "nemoclaw",
      fromDockerfile: overrides.metadata?.fromDockerfile ?? null,
    },
    steps: {
      ...defaultSteps(),
      ...(overrides.steps ?? {}),
    },
  };
}

export function normalizeSession(data: Session | SessionJsonValue | undefined): Session | null {
  if (!isObject(data) || data.version !== SESSION_VERSION) return null;

  const normalized = createSession({
    sessionId: readString(data.sessionId) ?? undefined,
    mode: readString(data.mode) ?? undefined,
    startedAt: readString(data.startedAt) ?? undefined,
    updatedAt: readString(data.updatedAt) ?? undefined,
    agent: readString(data.agent),
    sandboxName: readString(data.sandboxName),
    provider: readString(data.provider),
    model: readString(data.model),
    endpointUrl: typeof data.endpointUrl === "string" ? redactUrl(data.endpointUrl) : null,
    credentialEnv: readString(data.credentialEnv),
    preferredInferenceApi: readString(data.preferredInferenceApi),
    nimContainer: readString(data.nimContainer),
    webSearchConfig: parseWebSearchConfig(data.webSearchConfig),
    policyPresets: readStringArray(data.policyPresets),
    messagingChannels: readStringArray(data.messagingChannels),
    migratedLegacyValueHashes: readStringRecord(data.migratedLegacyValueHashes),
    gpuPassthrough: data.gpuPassthrough === true,
    telegramConfig: parseTelegramConfig(data.telegramConfig),
    lastStepStarted: readString(data.lastStepStarted),
    lastCompletedStep: readString(data.lastCompletedStep),
    failure: sanitizeFailure(isObject(data.failure) ? data.failure : null),
    metadata: parseSessionMetadata(data.metadata),
  });
  normalized.resumable = data.resumable !== false;
  normalized.status = readString(data.status) ?? normalized.status;

  if (isObject(data.steps)) {
    for (const [name, step] of Object.entries(data.steps)) {
      const parsedStep = parseStepState(step);
      if (Object.prototype.hasOwnProperty.call(normalized.steps, name) && parsedStep) {
        normalized.steps[name] = parsedStep;
      }
    }
  }

  return normalized;
}

export function loadSession(): Session | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    return normalizeSession(parsed);
  } catch {
    return null;
  }
}

export function saveSession(session: Session): Session {
  const normalized = normalizeSession(session) || createSession();
  normalized.updatedAt = new Date().toISOString();
  ensureSessionDir();
  const tmpFile = path.join(
    SESSION_DIR,
    `.onboard-session.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  fs.writeFileSync(tmpFile, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, SESSION_FILE);
  return normalized;
}

export function clearSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {
    return;
  }
}

// ── Locking ──────────────────────────────────────────────────────

function parseLockFile(contents: string): LockInfo | null {
  try {
    return parseLockInfo(JSON.parse(contents));
  } catch {
    return null;
  }
}

const MALFORMED_STALE_SECONDS = 30;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function readProcProcessStartMs(pid: number): number | null {
  try {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const btimeLine = fs
      .readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((line) => line.startsWith("btime "));
    const bootSeconds = btimeLine ? Number(btimeLine.trim().split(/\s+/)[1]) : NaN;
    const closeParen = statText.lastIndexOf(")");
    if (!Number.isFinite(bootSeconds) || closeParen < 0) return null;

    const fieldsAfterComm = statText
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = Number(fieldsAfterComm[19]);
    if (!Number.isFinite(startTicks)) return null;

    // Linux exposes /proc/<pid>/stat starttime in USER_HZ ticks. 100 is the
    // stable value on supported NemoClaw Linux hosts.
    const clockTicksPerSecond = 100;
    return (bootSeconds + startTicks / clockTicksPerSecond) * 1000;
  } catch {
    return null;
  }
}

function lockHolderStillMatches(lock: LockInfo): boolean {
  if (!isProcessAlive(lock.pid)) return false;
  if (lock.pid === process.pid) return true;

  const lockStartedMs = lock.startedAt ? Date.parse(lock.startedAt) : NaN;
  if (!Number.isFinite(lockStartedMs)) return true;

  const processStartMs = readProcProcessStartMs(lock.pid);
  if (processStartMs === null) return true;

  // The original lock holder must have started before it wrote the lock. If
  // the currently-live PID started after the lock timestamp, the PID was reused
  // and the lock is stale even though kill(pid, 0) succeeds.
  return processStartMs <= lockStartedMs + 1000;
}

// File descriptor we hold across the lifetime of an acquired lock. On
// release, fstat(fd).ino vs stat(path).ino confirms the on-disk path
// still resolves to the file we created — closing the residual TOCTOU
// window in the inode-only check by tying ownership to a live
// descriptor rather than a value re-read from disk. See #1281.
let heldLockFd: number | null = null;

export function acquireOnboardLock(command: string | null = null): LockResult {
  ensureSessionDir();
  const payload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: typeof command === "string" ? command : null,
    },
    null,
    2,
  );

  // The retry budget here used to be 2, which is the bare minimum needed
  // for "see-stale → cleanup → reclaim". With the inode-verified cleanup
  // below it can take a few additional spins under contention because
  // multiple concurrent stale-cleaners can race and lose to each other
  // before one reclaims, so give the loop a little more room.
  // See issue #1281.
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      // openSync(..., "wx", mode) is the atomic create-or-fail
      // primitive. We hold the resulting fd at module scope so
      // releaseOnboardLock() can later confirm the on-disk path still
      // resolves to the same file we created (fstat ino vs stat ino).
      fd = fs.openSync(LOCK_FILE, "wx", 0o600);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }

      // Capture both the parsed lock and the inode so we can verify the
      // file we're about to unlink is STILL the same stale file we read.
      // Without the inode check, two concurrent processes can both read
      // the same stale lock, and the slower one will unlink the fresh
      // lock the faster one just claimed, breaking mutual exclusion.
      // See issue #1281.
      let existing: LockInfo | null;
      let staleInode: bigint | null;
      try {
        const stat = fs.statSync(LOCK_FILE, { bigint: true });
        staleInode = stat.ino;
        existing = parseLockFile(fs.readFileSync(LOCK_FILE, "utf8"));
      } catch (readError) {
        if (isErrnoException(readError) && readError.code === "ENOENT") {
          continue;
        }
        throw readError;
      }
      if (!existing) {
        // Malformed lock file. If the file is very recent (<30 s), a
        // concurrent process may be mid-write — leave it and retry.
        // Otherwise the file is stale debris from a crash between
        // openSync("wx") and writeSync() — remove it so subsequent
        // onboard runs are not permanently blocked (#2765).
        try {
          const lockStat = fs.statSync(LOCK_FILE);
          const ageMs = Date.now() - lockStat.mtimeMs;
          if (ageMs > MALFORMED_STALE_SECONDS * 1000) {
            unlinkIfInodeMatches(LOCK_FILE, staleInode);
          }
        } catch (statErr) {
          if (!(isErrnoException(statErr) && statErr.code === "ENOENT")) {
            throw statErr;
          }
        }
        continue;
      }
      if (lockHolderStillMatches(existing)) {
        return {
          acquired: false,
          lockFile: LOCK_FILE,
          stale: false,
          holderPid: existing.pid,
          holderStartedAt: existing.startedAt,
          holderCommand: existing.command,
        };
      }

      // Stale: unlink ONLY if the file on disk is still the same inode
      // we just read. If a concurrent process already cleaned up and
      // claimed the lock, the inode will have changed and we'll fall
      // through to the next iteration where openSync(wx) will either
      // succeed (we win) or fail EEXIST against the new holder (and we
      // re-read it).
      unlinkIfInodeMatches(LOCK_FILE, staleInode);
      continue;
    }

    // Atomic create succeeded — write the payload and keep the fd open
    // for the lifetime of the lock so releaseOnboardLock() can verify
    // ownership via the live descriptor.
    try {
      fs.writeSync(fd, payload);
    } catch (writeError) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        /* ignore */
      }
      throw writeError;
    }
    heldLockFd = fd;
    return { acquired: true, lockFile: LOCK_FILE, stale: false };
  }

  return { acquired: false, lockFile: LOCK_FILE, stale: true };
}

/**
 * Unlink LOCK_FILE only if its current inode equals `expectedInode`.
 * The dual stat-then-unlink is the only portable POSIX primitive Node
 * exposes for this — there's no atomic "unlink-if-inode" syscall — so
 * a sufficiently unlucky race can still slip through. The window is
 * orders of magnitude smaller than the unconditional unlink it
 * replaces, and the outer loop will detect a wrong unlink on its next
 * `writeFileSync(wx)` attempt because either we re-create the file
 * or we observe the new lock with a different inode.
 */
function unlinkIfInodeMatches(filePath: string, expectedInode: bigint | null): void {
  if (expectedInode === null) {
    return;
  }
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (stat.ino !== expectedInode) {
      // Someone else replaced the file. Leave it alone.
      return;
    }
  } catch (statError) {
    if (isErrnoException(statError) && statError.code === "ENOENT") {
      return;
    }
    throw statError;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (unlinkError) {
    if (!isErrnoException(unlinkError) || unlinkError.code !== "ENOENT") {
      throw unlinkError;
    }
  }
}

export function releaseOnboardLock(): void {
  // Preferred path: we hold the fd from a successful acquireOnboardLock.
  // Verify the on-disk path still resolves to the same file (fstat ino
  // == stat ino) before unlinking. If they disagree, another process
  // has already replaced the lock and we must NOT touch their file.
  if (heldLockFd !== null) {
    const fd = heldLockFd;
    heldLockFd = null;
    try {
      const fdStat = fs.fstatSync(fd, { bigint: true });
      let pathInode: bigint | null = null;
      try {
        const pathStat = fs.statSync(LOCK_FILE, { bigint: true });
        pathInode = pathStat.ino;
      } catch (error) {
        if (!(isErrnoException(error) && error.code === "ENOENT")) {
          // Unexpected — fall through to closing the fd.
        }
      }
      if (pathInode !== null && pathInode === fdStat.ino) {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch (unlinkError) {
          if (!(isErrnoException(unlinkError) && unlinkError.code === "ENOENT")) {
            // Best effort — surfacing this would mask the real error.
          }
        }
      }
    } catch {
      // fstat can fail if the fd was already closed somehow; nothing
      // safe to do beyond closing it below.
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    return;
  }

  // Fallback (no fd held — e.g., a test wrote the lock file directly,
  // or a previous release already ran): preserve the legacy pid-based
  // behavior so we never unlink a malformed lock and never unlink a
  // lock owned by another pid.
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    let existing: LockInfo | null = null;
    try {
      existing = parseLockFile(fs.readFileSync(LOCK_FILE, "utf8"));
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (!existing) return;
    if (existing.pid !== process.pid) return;
    fs.unlinkSync(LOCK_FILE);
  } catch {
    return;
  }
}

// ── Step management ──────────────────────────────────────────────

export function filterSafeUpdates(updates: SessionUpdates): Partial<Session> {
  const safe: Partial<Session> = {};
  if (!isObject(updates)) return safe;
  if (typeof updates.sandboxName === "string") safe.sandboxName = updates.sandboxName;
  if (typeof updates.provider === "string") safe.provider = updates.provider;
  if (typeof updates.model === "string") safe.model = updates.model;
  if (typeof updates.endpointUrl === "string") safe.endpointUrl = redactUrl(updates.endpointUrl);
  if (typeof updates.credentialEnv === "string") safe.credentialEnv = updates.credentialEnv;
  if (typeof updates.preferredInferenceApi === "string")
    safe.preferredInferenceApi = updates.preferredInferenceApi;
  if (typeof updates.nimContainer === "string") safe.nimContainer = updates.nimContainer;
  if (isObject(updates.webSearchConfig) && updates.webSearchConfig.fetchEnabled === true) {
    safe.webSearchConfig = { fetchEnabled: true };
  } else if (updates.webSearchConfig === null) {
    safe.webSearchConfig = null;
  }
  if (Array.isArray(updates.policyPresets)) {
    safe.policyPresets = updates.policyPresets.filter((value) => typeof value === "string");
  }
  if (Array.isArray(updates.messagingChannels)) {
    safe.messagingChannels = updates.messagingChannels.filter((value) => typeof value === "string");
  }
  if (isObject(updates.migratedLegacyValueHashes)) {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(updates.migratedLegacyValueHashes)) {
      if (typeof k === "string" && typeof v === "string") cleaned[k] = v;
    }
    safe.migratedLegacyValueHashes = cleaned;
  }
  if (updates.gpuPassthrough === true || updates.gpuPassthrough === false) {
    safe.gpuPassthrough = updates.gpuPassthrough;
  }
  if (isObject(updates.telegramConfig) && typeof updates.telegramConfig.requireMention === "boolean") {
    safe.telegramConfig = { requireMention: updates.telegramConfig.requireMention };
  } else if (updates.telegramConfig === null) {
    safe.telegramConfig = null;
  }
  if (isObject(updates.metadata) && typeof updates.metadata.gatewayName === "string") {
    safe.metadata = {
      gatewayName: updates.metadata.gatewayName,
      fromDockerfile:
        typeof updates.metadata.fromDockerfile === "string"
          ? updates.metadata.fromDockerfile
          : null,
    };
  }
  return safe;
}

export function updateSession(mutator: (session: Session) => Session | void): Session {
  const current = loadSession() || createSession();
  const next = typeof mutator === "function" ? mutator(current) || current : current;
  return saveSession(next);
}

export function markStepStarted(stepName: string): Session {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    step.status = "in_progress";
    step.startedAt = new Date().toISOString();
    step.completedAt = null;
    step.error = null;
    session.lastStepStarted = stepName;
    session.failure = null;
    session.status = "in_progress";
    return session;
  });
}

export function markStepComplete(stepName: string, updates: SessionUpdates = {}): Session {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    step.status = "complete";
    step.completedAt = new Date().toISOString();
    step.error = null;
    session.lastCompletedStep = stepName;
    session.failure = null;
    Object.assign(session, filterSafeUpdates(updates));
    return session;
  });
}

export function markStepSkipped(stepName: string): Session {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    if (step.status === "complete" || step.status === "failed") return session;
    step.status = "skipped";
    step.startedAt = null;
    step.completedAt = null;
    step.error = null;
    return session;
  });
}

export function markStepFailed(stepName: string, message: string | null = null): Session {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    step.status = "failed";
    step.completedAt = null;
    step.error = redactSensitiveText(message);
    session.failure = sanitizeFailure({
      step: stepName,
      message,
      recordedAt: new Date().toISOString(),
    });
    session.status = "failed";
    return session;
  });
}

export function completeSession(updates: SessionUpdates = {}): Session {
  return updateSession((session) => {
    Object.assign(session, filterSafeUpdates(updates));
    session.status = "complete";
    session.resumable = false;
    session.failure = null;
    return session;
  });
}

export function summarizeForDebug(
  session: Session | null = loadSession(),
): DebugSessionSummary | null {
  if (!session) return null;
  return {
    version: session.version,
    sessionId: session.sessionId,
    status: session.status,
    resumable: session.resumable,
    mode: session.mode,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    sandboxName: session.sandboxName,
    provider: session.provider,
    model: session.model,
    endpointUrl: redactUrl(session.endpointUrl),
    credentialEnv: session.credentialEnv,
    preferredInferenceApi: session.preferredInferenceApi,
    nimContainer: session.nimContainer,
    policyPresets: session.policyPresets,
    gpuPassthrough: session.gpuPassthrough,
    lastStepStarted: session.lastStepStarted,
    lastCompletedStep: session.lastCompletedStep,
    failure: sanitizeFailure(session.failure),
    steps: Object.fromEntries(
      Object.entries(session.steps).map(([name, step]) => [
        name,
        {
          status: step.status,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
          error: step.error,
        },
      ]),
    ),
  };
}
