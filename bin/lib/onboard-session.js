// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");

const SESSION_VERSION = 1;
const SESSION_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
const SESSION_FILE = path.join(SESSION_DIR, "onboard-session.json");
const LOCK_FILE = path.join(SESSION_DIR, "onboard.lock");
const VALID_STEP_STATES = new Set(["pending", "in_progress", "complete", "failed", "skipped"]);

function ensureSessionDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

function sessionPath() {
  return SESSION_FILE;
}

function lockPath() {
  return LOCK_FILE;
}

function defaultSteps() {
  return {
    preflight: { status: "pending", startedAt: null, completedAt: null, error: null },
    gateway: { status: "pending", startedAt: null, completedAt: null, error: null },
    sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
    provider_selection: { status: "pending", startedAt: null, completedAt: null, error: null },
    inference: { status: "pending", startedAt: null, completedAt: null, error: null },
    openclaw: { status: "pending", startedAt: null, completedAt: null, error: null },
    policies: { status: "pending", startedAt: null, completedAt: null, error: null },
  };
}

function createSession(overrides = {}) {
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
    sandboxName: overrides.sandboxName || null,
    provider: overrides.provider || null,
    model: overrides.model || null,
    endpointUrl: overrides.endpointUrl || null,
    credentialEnv: overrides.credentialEnv || null,
    preferredInferenceApi: overrides.preferredInferenceApi || null,
    nimContainer: overrides.nimContainer || null,
    policyPresets: Array.isArray(overrides.policyPresets) ? overrides.policyPresets.filter((value) => typeof value === "string") : null,
    metadata: {
      gatewayName: overrides.metadata?.gatewayName || "nemoclaw",
    },
    steps: {
      ...defaultSteps(),
      ...(overrides.steps || {}),
    },
  };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSensitiveText(value) {
  if (typeof value !== "string") return null;
  return value
    .replace(/(NVIDIA_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|COMPATIBLE_API_KEY|COMPATIBLE_ANTHROPIC_API_KEY)=\S+/gi, "$1=<REDACTED>")
    .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>")
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, "<REDACTED>")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "<REDACTED>")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "<REDACTED>")
    .slice(0, 240);
}

function sanitizeFailure(input) {
  if (!input) return null;
  const step = typeof input.step === "string" ? input.step : null;
  const message = redactSensitiveText(input.message);
  const recordedAt = typeof input.recordedAt === "string" ? input.recordedAt : new Date().toISOString();
  return step || message ? { step, message, recordedAt } : null;
}

function validateStep(step) {
  if (!isObject(step)) return false;
  if (!VALID_STEP_STATES.has(step.status)) return false;
  return true;
}

function redactUrl(value) {
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

// eslint-disable-next-line complexity
function normalizeSession(data) {
  if (!isObject(data) || data.version !== SESSION_VERSION) return null;
  const normalized = createSession({
    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
    mode: typeof data.mode === "string" ? data.mode : undefined,
    startedAt: typeof data.startedAt === "string" ? data.startedAt : undefined,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined,
    sandboxName: typeof data.sandboxName === "string" ? data.sandboxName : null,
    provider: typeof data.provider === "string" ? data.provider : null,
    model: typeof data.model === "string" ? data.model : null,
    endpointUrl: typeof data.endpointUrl === "string" ? redactUrl(data.endpointUrl) : null,
    credentialEnv: typeof data.credentialEnv === "string" ? data.credentialEnv : null,
    preferredInferenceApi: typeof data.preferredInferenceApi === "string" ? data.preferredInferenceApi : null,
    nimContainer: typeof data.nimContainer === "string" ? data.nimContainer : null,
    policyPresets: Array.isArray(data.policyPresets) ? data.policyPresets.filter((value) => typeof value === "string") : null,
    lastStepStarted: typeof data.lastStepStarted === "string" ? data.lastStepStarted : null,
    lastCompletedStep: typeof data.lastCompletedStep === "string" ? data.lastCompletedStep : null,
    failure: sanitizeFailure(data.failure),
    metadata: isObject(data.metadata) ? data.metadata : undefined,
  });
  normalized.resumable = data.resumable !== false;
  normalized.status = typeof data.status === "string" ? data.status : normalized.status;

  if (isObject(data.steps)) {
    for (const [name, step] of Object.entries(data.steps)) {
      if (Object.prototype.hasOwnProperty.call(normalized.steps, name) && validateStep(step)) {
        normalized.steps[name] = {
          status: step.status,
          startedAt: typeof step.startedAt === "string" ? step.startedAt : null,
          completedAt: typeof step.completedAt === "string" ? step.completedAt : null,
          error: redactSensitiveText(step.error),
        };
      }
    }
  }

  return normalized;
}

function loadSession() {
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

function saveSession(session) {
  const normalized = normalizeSession(session) || createSession();
  normalized.updatedAt = new Date().toISOString();
  ensureSessionDir();
  const tmpFile = path.join(
    SESSION_DIR,
    `.onboard-session.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tmpFile, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, SESSION_FILE);
  return normalized;
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {
    return;
  }
}

function parseLockFile(contents) {
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireOnboardLock(command = null) {
  ensureSessionDir();
  const payload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: typeof command === "string" ? command : null,
    },
    null,
    2
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(fd, payload);
      fs.closeSync(fd);
      return { acquired: true, lockFile: LOCK_FILE, stale: false };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      let existing;
      try {
        existing = parseLockFile(fs.readFileSync(LOCK_FILE, "utf8"));
      } catch (readError) {
        if (readError?.code === "ENOENT") {
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
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }

  return { acquired: false, lockFile: LOCK_FILE, stale: true };
}

function releaseOnboardLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    let existing = null;
    try {
      existing = parseLockFile(fs.readFileSync(LOCK_FILE, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!existing) return;
    if (existing.pid !== process.pid) return;
    fs.unlinkSync(LOCK_FILE);
  } catch {
    return;
  }
}

function updateSession(mutator) {
  const current = loadSession() || createSession();
  const next = typeof mutator === "function" ? mutator(current) || current : current;
  return saveSession(next);
}

function markStepStarted(stepName) {
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

function markStepComplete(stepName, updates = {}) {
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

function markStepFailed(stepName, message = null) {
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

function completeSession(updates = {}) {
  return updateSession((session) => {
    Object.assign(session, filterSafeUpdates(updates));
    session.status = "complete";
    session.resumable = false;
    session.failure = null;
    return session;
  });
}

function filterSafeUpdates(updates) {
  const safe = {};
  if (!isObject(updates)) return safe;
  if (typeof updates.sandboxName === "string") safe.sandboxName = updates.sandboxName;
  if (typeof updates.provider === "string") safe.provider = updates.provider;
  if (typeof updates.model === "string") safe.model = updates.model;
  if (typeof updates.endpointUrl === "string") safe.endpointUrl = redactUrl(updates.endpointUrl);
  if (typeof updates.credentialEnv === "string") safe.credentialEnv = updates.credentialEnv;
  if (typeof updates.preferredInferenceApi === "string") safe.preferredInferenceApi = updates.preferredInferenceApi;
  if (typeof updates.nimContainer === "string") safe.nimContainer = updates.nimContainer;
  if (Array.isArray(updates.policyPresets)) {
    safe.policyPresets = updates.policyPresets.filter((value) => typeof value === "string");
  }
  if (isObject(updates.metadata) && typeof updates.metadata.gatewayName === "string") {
    safe.metadata = {
      gatewayName: updates.metadata.gatewayName,
    };
  }
  return safe;
}

function summarizeForDebug(session = loadSession()) {
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
      ])
    ),
  };
}

module.exports = {
  LOCK_FILE,
  SESSION_DIR,
  SESSION_FILE,
  SESSION_VERSION,
  acquireOnboardLock,
  clearSession,
  completeSession,
  createSession,
  loadSession,
  markStepComplete,
  markStepFailed,
  markStepStarted,
  lockPath,
  redactUrl,
  saveSession,
  releaseOnboardLock,
  sessionPath,
  redactSensitiveText,
  summarizeForDebug,
  updateSession,
};
