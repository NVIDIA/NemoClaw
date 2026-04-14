// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Onboard session management — create, load, save, and update the
 * onboarding session file (~/.nemoclaw/onboard-session.json) with
 * step-level progress tracking and file-based locking.
 */

import fs from "node:fs";
import path from "node:path";

import type { WebSearchConfig } from "./web-search";

export const SESSION_VERSION = 1;
export const SESSION_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
export const SESSION_FILE = path.join(SESSION_DIR, "onboard-session.json");
export const LOCK_FILE = path.join(SESSION_DIR, "onboard.lock");
const VALID_STEP_STATES = new Set(["pending", "in_progress", "complete", "failed", "skipped"]);

// ── Types ────────────────────────────────────────────────────────

export interface StepState {
  status: string;
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
  metadata: SessionMetadata;
  steps: Record<string, StepState>;
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
  metadata?: { gatewayName?: string; fromDockerfile?: string | null };
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

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactSensitiveText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value
    .replace(
      /(NVIDIA_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|COMPATIBLE_API_KEY|COMPATIBLE_ANTHROPIC_API_KEY|BRAVE_API_KEY)=\S+/gi,
      "$1=<REDACTED>",
    )
    .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>")
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, "<REDACTED>")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "<REDACTED>")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "<REDACTED>")
    .slice(0, 240);
}

export function sanitizeFailure(
  input: { step?: unknown; message?: unknown; recordedAt?: unknown } | null | undefined,
): SessionFailure | null {
  if (!input) return null;
  const step = typeof input.step === "string" ? input.step : null;
  const message = redactSensitiveText(input.message);
  const recordedAt =
    typeof input.recordedAt === "string" ? input.recordedAt : new Date().toISOString();
  return step || message ? { step, message, recordedAt } : null;
}

export function validateStep(step: unknown): boolean {
  if (!isObject(step)) return false;
  if (!VALID_STEP_STATES.has(step.status as string)) return false;
  return true;
}

export function redactUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/(^|[-_])(?:signature|sig|token|auth|access_token)$/i.test(key)) {
        url.searchParams.set(key, "<REDACTED>");
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return redactSensitiveText(value);
  }
}

// ── Session CRUD ─────────────────────────────────────────────────

export function createSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    version: SESSION_VERSION,
    sessionId: overrides.sessionId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    resumable: true,
    status: "in_progress",
    mode: overrides.mode || "interactive",
    startedAt: overrides.startedAt || now,
    updatedAt: overrides.updatedAt || now,
    lastStepStarted: overrides.lastStepStarted || null,
    lastCompletedStep: overrides.lastCompletedStep || null,
    failure: overrides.failure || null,
    agent: overrides.agent || null,
    sandboxName: overrides.sandboxName || null,
    provider: overrides.provider || null,
    model: overrides.model || null,
    endpointUrl: overrides.endpointUrl || null,
    credentialEnv: overrides.credentialEnv || null,
    preferredInferenceApi: overrides.preferredInferenceApi || null,
    nimContainer: overrides.nimContainer || null,
    webSearchConfig:
      overrides.webSearchConfig && overrides.webSearchConfig.fetchEnabled === true
        ? { fetchEnabled: true }
        : null,
    policyPresets: Array.isArray(overrides.policyPresets)
      ? overrides.policyPresets.filter((value) => typeof value === "string")
      : null,
    metadata: {
      gatewayName: overrides.metadata?.gatewayName || "nemoclaw",
      fromDockerfile: overrides.metadata?.fromDockerfile || null,
    },
    steps: {
      ...defaultSteps(),
      ...(overrides.steps || {}),
    },
  };
}

// eslint-disable-next-line complexity
export function normalizeSession(data: unknown): Session | null {
  if (!isObject(data) || (data as Record<string, unknown>).version !== SESSION_VERSION) return null;
  const d = data as Record<string, unknown>;
  const normalized = createSession({
    sessionId: typeof d.sessionId === "string" ? d.sessionId : undefined,
    mode: typeof d.mode === "string" ? d.mode : undefined,
    startedAt: typeof d.startedAt === "string" ? d.startedAt : undefined,
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : undefined,
    agent: typeof d.agent === "string" ? d.agent : null,
    sandboxName: typeof d.sandboxName === "string" ? d.sandboxName : null,
    provider: typeof d.provider === "string" ? d.provider : null,
    model: typeof d.model === "string" ? d.model : null,
    endpointUrl: typeof d.endpointUrl === "string" ? redactUrl(d.endpointUrl) : null,
    credentialEnv: typeof d.credentialEnv === "string" ? d.credentialEnv : null,
    preferredInferenceApi:
      typeof d.preferredInferenceApi === "string" ? d.preferredInferenceApi : null,
    nimContainer: typeof d.nimContainer === "string" ? d.nimContainer : null,
    webSearchConfig:
      isObject(d.webSearchConfig) &&
      (d.webSearchConfig as Record<string, unknown>).fetchEnabled === true
        ? { fetchEnabled: true }
        : null,
    policyPresets: Array.isArray(d.policyPresets)
      ? (d.policyPresets as unknown[]).filter((value) => typeof value === "string") as string[]
      : null,
    lastStepStarted: typeof d.lastStepStarted === "string" ? d.lastStepStarted : null,
    lastCompletedStep: typeof d.lastCompletedStep === "string" ? d.lastCompletedStep : null,
    failure: sanitizeFailure(d.failure as Record<string, unknown> | null),
    metadata: isObject(d.metadata)
      ? ({
          gatewayName: (d.metadata as Record<string, unknown>).gatewayName,
          fromDockerfile: (d.metadata as Record<string, unknown>).fromDockerfile || null,
        } as SessionMetadata)
      : undefined,
  } as Partial<Session>);
  normalized.resumable = d.resumable !== false;
  normalized.status = typeof d.status === "string" ? d.status : normalized.status;

  if (isObject(d.steps)) {
    for (const [name, step] of Object.entries(d.steps as Record<string, unknown>)) {
      if (
        Object.prototype.hasOwnProperty.call(normalized.steps, name) &&
        validateStep(step)
      ) {
        const s = step as Record<string, unknown>;
        normalized.steps[name] = {
          status: s.status as string,
          startedAt: typeof s.startedAt === "string" ? s.startedAt : null,
          completedAt: typeof s.completedAt === "string" ? s.completedAt : null,
          error: redactSensitiveText(s.error),
        };
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
    const parsed = JSON.parse(contents);
    if (typeof parsed?.pid !== "number") return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      command: typeof parsed.command === "string" ? parsed.command : null,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, payload, { flag: "wx", mode: 0o600 });
      return { acquired: true, lockFile: LOCK_FILE, stale: false };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }

      let existing: LockInfo | null;
      try {
        existing = parseLockFile(fs.readFileSync(LOCK_FILE, "utf8"));
      } catch (readError: unknown) {
        if ((readError as NodeJS.ErrnoException)?.code === "ENOENT") {
          continue;
        }
        throw readError;
      }
      if (!existing) {
        continue;
      }
      if (existing && isProcessAlive(existing.pid)) {
        return {
          acquired: false,
          lockFile: LOCK_FILE,
          stale: false,
          holderPid: existing.pid,
          holderStartedAt: existing.startedAt,
          holderCommand: existing.command,
        };
      }

      try {
        fs.unlinkSync(LOCK_FILE);
      } catch (unlinkError: unknown) {
        if ((unlinkError as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }

  return { acquired: false, lockFile: LOCK_FILE, stale: true };
}

export function releaseOnboardLock(): void {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    let existing: LockInfo | null = null;
    try {
      existing = parseLockFile(fs.readFileSync(LOCK_FILE, "utf8"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
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
  if (isObject(updates.metadata) && typeof updates.metadata.gatewayName === "string") {
    safe.metadata = {
      gatewayName: updates.metadata.gatewayName,
      fromDockerfile: (typeof updates.metadata.fromDockerfile === "string" ? updates.metadata.fromDockerfile : null),
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

export function summarizeForDebug(session: Session | null = loadSession()): Record<
  string,
  unknown
> | null {
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
    lastStepStarted: session.lastStepStarted,
    lastCompletedStep: session.lastCompletedStep,
    failure: session.failure,
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
