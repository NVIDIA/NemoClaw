#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type GitHubRequestOptions, githubApi } from "../advisors/github.mts";
import * as privateFile from "./private-file.mts";

// Root .ts files are exposed as CommonJS under tsx and as ESM under Node's
// strip-types runtime. Normalize both forms so the workflow uses the same
// no-follow state-file helpers in either test or production execution.
const privateFileRuntime = (
  "default" in privateFile && privateFile.default ? privateFile.default : privateFile
) as typeof import("./private-file.mts");

export const REQUESTER_REPOSITORY = "NVIDIA/NemoClaw";
export const PRODUCER_REPOSITORY = "brevdev/nemoclaw-image";
export const PRODUCER_WORKFLOW_FILE = "build-qualification-image.yml";
export const PRODUCER_WORKFLOW_PATH = `.github/workflows/${PRODUCER_WORKFLOW_FILE}`;
export const PRODUCER_REF = "main";
export const GITHUB_API_VERSION = "2026-03-10";
export const MANIFEST_ARTIFACT_FILE = "nemoclaw-image-manifest.v1.json";
export const ARCHIVE_FILE = "nemoclaw-image-handoff.zip";
export const VALIDATED_MANIFEST_FILE = "validated-manifest.v1.json";
export const EVIDENCE_FILE = "qualification-evidence.v1.json";
export const STATE_FILE = "controller-state.json";
export const DISPATCH_INTENT_FILE = "dispatch-intent.v1.json";
export const DISPATCH_RECONCILIATION_FILE = "dispatch-reconciliation.v1.json";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GITHUB_LOGIN_PATTERN = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/u;
const MAX_REASON_BYTES = 500;
const MAX_STATE_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const API_REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 15_000;
const RECONCILIATION_POLL_INTERVAL_MS = 5_000;
const DISPATCH_RECONCILIATION_TIMEOUT_MS = 2 * 60_000;
const CANCEL_RESERVE_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const DISPATCH_CLOCK_SKEW_MS = 60_000;
const QUEUE_TIMEOUT_MS = 10 * 60_000;
const WARNING_AFTER_MS = 25 * 60_000;
const QUALIFICATION_TIMEOUT_MS = 45 * 60_000;
const ARTIFACT_PROPAGATION_TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = fs.constants.O_NONBLOCK ?? 0;

export type ExactImageQualificationFailureCode =
  | "REQUEST_INVALID"
  | "DISPATCH_FORBIDDEN"
  | "DISPATCH_AMBIGUOUS"
  | "RUN_QUEUE_TIMEOUT"
  | "QUALIFICATION_TIMEOUT"
  | "PRODUCER_RUN_FAILED"
  | "PROVENANCE_MISMATCH"
  | "ARTIFACT_PENDING"
  | "ARTIFACT_MISSING_OR_INVALID"
  | "ARTIFACT_DOWNLOAD_TRANSIENT"
  | "OUTPUT_WRITE_FAILED"
  | "UNKNOWN";

export class ExactImageQualificationError extends Error {
  readonly code: ExactImageQualificationFailureCode;

  constructor(code: ExactImageQualificationFailureCode, message: string) {
    super(message);
    this.name = "ExactImageQualificationError";
    this.code = code;
  }
}

type GitHubApiClient = <T>(
  apiPath: string,
  token: string,
  options?: GitHubRequestOptions,
) => Promise<T>;

type CommandResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: Buffer | string;
  stderr: Buffer | string;
  error?: Error;
};

type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

export type QualificationDependencies = {
  api?: GitHubApiClient;
  fetch?: typeof fetch;
  now?: () => number;
  randomUuid?: () => string;
  runCommand?: CommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  limits?: Partial<{
    artifactPropagationTimeoutMs: number;
    apiRequestTimeoutMs: number;
    cancelReserveMs: number;
    cleanupTimeoutMs: number;
    dispatchReconciliationTimeoutMs: number;
    downloadTimeoutMs: number;
    pollIntervalMs: number;
    qualificationTimeoutMs: number;
    queueTimeoutMs: number;
    reconciliationPollIntervalMs: number;
    warningAfterMs: number;
  }>;
};

export type ExactImageQualificationRequest = {
  actor: string;
  candidateSha: string;
  eventName: string;
  reason: string;
  ref: string;
  requesterRunAttempt: number;
  requesterRunId: string;
  workflowSha: string;
};

export type DispatchDetails = {
  workflowRunId: string;
  runUrl: string;
  htmlUrl: string;
};

export type ExactImageDispatchIntent = {
  schemaVersion: 1;
  kind: "nemoclaw-exact-image-dispatch-intent";
  requestStartedAt: string;
  request: {
    actor: string;
    candidateSha: string;
    correlationId: string;
    reason: string;
    requesterRunAttempt: number;
    requesterRunId: string;
    workflowSha: string;
  };
  producer: {
    repository: typeof PRODUCER_REPOSITORY;
    repositorySha: string;
    ref: typeof PRODUCER_REF;
    workflowId: string;
    workflowPath: typeof PRODUCER_WORKFLOW_PATH;
  };
};

export type QualificationWorkflowRun = {
  id: string;
  workflowId: string;
  headSha: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  url: string;
  htmlUrl: string;
};

export type QualificationArtifact = {
  id: string;
  name: string;
  digest: string;
  sizeInBytes: number;
  apiUrl: string;
  archiveDownloadUrl: string;
};

export type ExactImageQualificationState = {
  schemaVersion: 1;
  status: "dispatched" | "completed" | "downloaded" | "validated";
  dispatchedAt: string;
  request: {
    actor: string;
    candidateSha: string;
    correlationId: string;
    reason: string;
    requesterRunAttempt: number;
    requesterRunId: string;
    workflowSha: string;
  };
  producer: {
    repository: typeof PRODUCER_REPOSITORY;
    repositorySha: string;
    ref: typeof PRODUCER_REF;
    workflowPath: typeof PRODUCER_WORKFLOW_PATH;
    runId: string;
    runAttempt: 1;
    workflowId?: string;
    runUrl: string;
    htmlUrl: string;
    completedAt?: string;
  };
  artifact?: QualificationArtifact & {
    archiveSha256: string;
    manifestSha256: string;
  };
  validation?: {
    acceptedAt: string;
    manifestSha256: string;
    normalizedManifestSha256: string;
  };
};

type ControllerCommand =
  | { mode: "preflight"; request: ExactImageQualificationRequest }
  | {
      mode: "start";
      request: ExactImageQualificationRequest;
      workDir: string;
    }
  | { mode: "wait" | "download" | "finalize" | "cancel"; workDir: string };

function fail(code: ExactImageQualificationFailureCode, message: string): never {
  throw new ExactImageQualificationError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("PROVENANCE_MISMATCH", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecordFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const allowed = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      fail("PROVENANCE_MISMATCH", `${label} is missing ${field}`);
    }
  }
  const unexpected = Object.keys(value)
    .filter((field) => !allowed.has(field))
    .sort();
  if (unexpected.length > 0) {
    fail("PROVENANCE_MISMATCH", `${label} contains unexpected field ${unexpected[0]}`);
  }
}

function persistedString(
  value: Record<string, unknown>,
  field: string,
  label: string,
  pattern?: RegExp,
): string {
  const result = value[field];
  if (typeof result !== "string" || (pattern !== undefined && !pattern.test(result))) {
    fail("PROVENANCE_MISMATCH", `${label} has an invalid format`);
  }
  return result;
}

function persistedTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") {
    fail("PROVENANCE_MISMATCH", `${label} must be a timestamp string`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("PROVENANCE_MISMATCH", `${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function validatePersistedReason(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_REASON_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("PROVENANCE_MISMATCH", `${label} is invalid`);
  }
}

function safePositiveId(value: unknown, label: string): string {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("PROVENANCE_MISMATCH", `${label} must be a positive safe integer`);
  }
  return String(value);
}

function positiveInteger(value: string, label: string): number {
  if (!DECIMAL_ID_PATTERN.test(value)) fail("REQUEST_INVALID", `${label} must be positive`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("REQUEST_INVALID", `${label} is outside the safe range`);
  return parsed;
}

function requireExactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail("PROVENANCE_MISMATCH", `${label} did not match the trusted request`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function timestamp(now: () => number): string {
  return new Date(now()).toISOString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function limits(dependencies: QualificationDependencies) {
  return {
    artifactPropagationTimeoutMs:
      dependencies.limits?.artifactPropagationTimeoutMs ?? ARTIFACT_PROPAGATION_TIMEOUT_MS,
    apiRequestTimeoutMs: dependencies.limits?.apiRequestTimeoutMs ?? API_REQUEST_TIMEOUT_MS,
    cancelReserveMs: dependencies.limits?.cancelReserveMs ?? CANCEL_RESERVE_MS,
    cleanupTimeoutMs: dependencies.limits?.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
    dispatchReconciliationTimeoutMs:
      dependencies.limits?.dispatchReconciliationTimeoutMs ?? DISPATCH_RECONCILIATION_TIMEOUT_MS,
    downloadTimeoutMs: dependencies.limits?.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    pollIntervalMs: dependencies.limits?.pollIntervalMs ?? POLL_INTERVAL_MS,
    qualificationTimeoutMs: dependencies.limits?.qualificationTimeoutMs ?? QUALIFICATION_TIMEOUT_MS,
    queueTimeoutMs: dependencies.limits?.queueTimeoutMs ?? QUEUE_TIMEOUT_MS,
    reconciliationPollIntervalMs:
      dependencies.limits?.reconciliationPollIntervalMs ?? RECONCILIATION_POLL_INTERVAL_MS,
    warningAfterMs: dependencies.limits?.warningAfterMs ?? WARNING_AFTER_MS,
  };
}

function qualificationDeadline(
  state: ExactImageQualificationState,
  qualificationTimeoutMs: number,
): number {
  const dispatchedAt = Date.parse(state.dispatchedAt);
  if (!Number.isFinite(dispatchedAt)) {
    fail("PROVENANCE_MISMATCH", "controller state has an invalid dispatch timestamp");
  }
  return dispatchedAt + qualificationTimeoutMs;
}

function requireQualificationTimeRemaining(deadline: number, now: () => number): number {
  const remaining = deadline - now();
  if (remaining <= 0) {
    fail("QUALIFICATION_TIMEOUT", "qualification exceeded the shared 45-minute budget");
  }
  return remaining;
}

function boundedApiClient(
  api: GitHubApiClient,
  dependencies: QualificationDependencies,
  deadline?: number,
): GitHubApiClient {
  const now = dependencies.now ?? Date.now;
  const requestCap = limits(dependencies).apiRequestTimeoutMs;
  return async <T,>(apiPath: string, token: string, options: GitHubRequestOptions = {}) => {
    const remaining = deadline === undefined ? requestCap : deadline - now();
    if (remaining <= 0) {
      fail("QUALIFICATION_TIMEOUT", "no time remains for the bounded GitHub API request");
    }
    const controller = new AbortController();
    const timeout = Math.min(requestCap, remaining);
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      return await api<T>(apiPath, token, { ...options, signal });
    } catch (error) {
      if (controller.signal.aborted) {
        fail("QUALIFICATION_TIMEOUT", `GitHub API request exceeded its ${timeout}ms budget`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

function acceptanceDeadline(
  state: ExactImageQualificationState,
  dependencies: QualificationDependencies,
): number {
  const configured = limits(dependencies);
  return (
    qualificationDeadline(state, configured.qualificationTimeoutMs) - configured.cancelReserveMs
  );
}

export function validateExactImageQualificationRequest(
  request: ExactImageQualificationRequest,
): ExactImageQualificationRequest {
  if (request.eventName !== "workflow_dispatch" && request.eventName !== "schedule") {
    fail("REQUEST_INVALID", "qualification must be started by workflow_dispatch or schedule");
  }
  if (request.ref !== "refs/heads/main") {
    fail("REQUEST_INVALID", "qualification must run from the trusted main branch");
  }
  if (!Number.isSafeInteger(request.requesterRunAttempt) || request.requesterRunAttempt < 1) {
    fail("REQUEST_INVALID", "requester run attempt must be a positive integer");
  }
  if (!FULL_SHA_PATTERN.test(request.candidateSha)) {
    fail("REQUEST_INVALID", "candidate SHA must be a lowercase full commit SHA");
  }
  if (!FULL_SHA_PATTERN.test(request.workflowSha)) {
    fail("REQUEST_INVALID", "workflow SHA must be a lowercase full commit SHA");
  }
  if (request.candidateSha !== request.workflowSha) {
    fail("REQUEST_INVALID", "candidate SHA must equal the trusted main workflow SHA");
  }
  if (!DECIMAL_ID_PATTERN.test(request.requesterRunId)) {
    fail("REQUEST_INVALID", "requester run ID must be a positive decimal string");
  }
  if (!GITHUB_LOGIN_PATTERN.test(request.actor)) {
    fail("REQUEST_INVALID", "triggering actor has an invalid GitHub login");
  }
  if (
    request.reason.length === 0 ||
    request.reason !== request.reason.trim() ||
    Buffer.byteLength(request.reason, "utf8") > MAX_REASON_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(request.reason)
  ) {
    fail("REQUEST_INVALID", "reason must be trimmed, nonempty, bounded text without controls");
  }
  return request;
}

function validateRequesterRef(value: unknown, repository: string, expectedRef: string): string {
  const payload = record(value, `${repository} requester ref`);
  requireExactString(payload.ref, expectedRef, `${repository} ref`);
  const object = record(payload.object, `${repository} ref object`);
  requireExactString(object.type, "commit", `${repository} ref object type`);
  if (typeof object.sha !== "string" || !FULL_SHA_PATTERN.test(object.sha)) {
    fail("PROVENANCE_MISMATCH", `${repository} main did not resolve to a full commit SHA`);
  }
  return object.sha;
}

function validateMainRef(value: unknown, repository: string): string {
  return validateRequesterRef(value, repository, "refs/heads/main");
}

function validateProducerWorkflow(value: unknown): string {
  const workflow = record(value, "producer workflow");
  const workflowId = safePositiveId(workflow.id, "producer workflow ID");
  requireExactString(workflow.path, PRODUCER_WORKFLOW_PATH, "producer workflow path");
  requireExactString(workflow.state, "active", "producer workflow state");
  return workflowId;
}

async function authorizeRequest(
  request: ExactImageQualificationRequest,
  token: string,
  api: GitHubApiClient,
): Promise<void> {
  validateExactImageQualificationRequest(request);
  const branch = await api<unknown>(`repos/${REQUESTER_REPOSITORY}/git/ref/heads/main`, token);
  if (validateMainRef(branch, REQUESTER_REPOSITORY) !== request.workflowSha) {
    fail("DISPATCH_FORBIDDEN", "workflow SHA is no longer the trusted main branch head");
  }
  const candidate = record(
    await api<unknown>(`repos/${REQUESTER_REPOSITORY}/git/commits/${request.candidateSha}`, token),
    "candidate commit",
  );
  if (candidate.sha !== request.candidateSha) {
    fail("DISPATCH_FORBIDDEN", "candidate SHA does not identify an exact NemoClaw commit");
  }
  const permission = record(
    await api<unknown>(
      `repos/${REQUESTER_REPOSITORY}/collaborators/${encodeURIComponent(request.actor)}/permission`,
      token,
    ),
    "collaborator permission",
  );
  if (permission.permission !== "admin" && permission.role_name !== "maintain") {
    fail("DISPATCH_FORBIDDEN", "triggering actor must have maintain or admin permission");
  }
}

export async function preflightExactImageQualification(
  request: ExactImageQualificationRequest,
  token: string,
  dependencies: QualificationDependencies = {},
): Promise<void> {
  await authorizeRequest(
    request,
    token,
    boundedApiClient(dependencies.api ?? githubApi, dependencies),
  );
}

export function validateWorkflowDispatchDetails(value: unknown): DispatchDetails {
  const payload = record(value, "workflow dispatch response");
  const workflowRunId = safePositiveId(payload.workflow_run_id, "workflow_run_id");
  const runUrl = `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/runs/${workflowRunId}`;
  const htmlUrl = `https://github.com/${PRODUCER_REPOSITORY}/actions/runs/${workflowRunId}`;
  requireExactString(payload.run_url, runUrl, "dispatch run_url");
  requireExactString(payload.html_url, htmlUrl, "dispatch html_url");
  return { workflowRunId, runUrl, htmlUrl };
}

export function validateQualificationWorkflowRun(
  value: unknown,
  expected: {
    candidateSha: string;
    correlationId: string;
    producerSha: string;
    runId: string;
    runUrl: string;
    htmlUrl: string;
    workflowId?: string;
  },
): QualificationWorkflowRun {
  const run = record(value, "producer workflow run");
  const id = safePositiveId(run.id, "producer run ID");
  if (id !== expected.runId) fail("PROVENANCE_MISMATCH", "producer run ID changed");
  const workflowId = safePositiveId(run.workflow_id, "producer workflow ID");
  if (expected.workflowId !== undefined && workflowId !== expected.workflowId) {
    fail("PROVENANCE_MISMATCH", "producer workflow ID did not match the dispatch intent");
  }
  if (run.run_attempt !== 1) fail("PROVENANCE_MISMATCH", "producer run attempt must equal 1");
  requireExactString(run.event, "workflow_dispatch", "producer event");
  requireExactString(run.head_branch, PRODUCER_REF, "producer head branch");
  requireExactString(run.head_sha, expected.producerSha, "producer head SHA");
  requireExactString(run.path, PRODUCER_WORKFLOW_PATH, "producer workflow path");
  requireExactString(
    run.display_title,
    `Qualify NemoClaw ${expected.candidateSha} (${expected.correlationId})`,
    "producer display title",
  );
  requireExactString(run.url, expected.runUrl, "producer run URL");
  requireExactString(run.html_url, expected.htmlUrl, "producer HTML URL");
  requireExactString(
    record(run.repository, "producer repository").full_name,
    PRODUCER_REPOSITORY,
    "producer repository",
  );
  requireExactString(
    record(run.head_repository, "producer head repository").full_name,
    PRODUCER_REPOSITORY,
    "producer head repository",
  );
  const allowedStatuses = new Set([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]);
  if (typeof run.status !== "string" || !allowedStatuses.has(run.status)) {
    fail("PROVENANCE_MISMATCH", "producer run has an unsupported status");
  }
  if (run.conclusion !== null && typeof run.conclusion !== "string") {
    fail("PROVENANCE_MISMATCH", "producer conclusion must be a string or null");
  }
  return {
    id,
    workflowId,
    headSha: expected.producerSha,
    runAttempt: 1,
    status: run.status,
    conclusion: run.conclusion as string | null,
    url: expected.runUrl,
    htmlUrl: expected.htmlUrl,
  };
}

function validateCancellationWorkflowRun(
  value: unknown,
  state: ExactImageQualificationState,
): { status: string; conclusion: string | null } {
  const run = record(value, "producer cancellation workflow run");
  const observedHeadSha = persistedString(
    run,
    "head_sha",
    "producer cancellation head SHA",
    FULL_SHA_PATTERN,
  );
  const validated = validateQualificationWorkflowRun(value, {
    ...expectedRun(state),
    // A run whose producer ref moved after dispatch remains cleanup-owned but
    // can never become qualification evidence; all other identity must bind.
    producerSha: observedHeadSha,
  });
  return { status: validated.status, conclusion: validated.conclusion };
}

function statePath(workDir: string): string {
  return path.join(workDir, STATE_FILE);
}

function intentPath(workDir: string): string {
  return path.join(workDir, DISPATCH_INTENT_FILE);
}

function writeDispatchIntent(workDir: string, intent: ExactImageDispatchIntent): void {
  try {
    privateFileRuntime.writePrivateRegularFile(
      intentPath(workDir),
      `${JSON.stringify(intent, null, 2)}\n`,
    );
  } catch {
    fail("OUTPUT_WRITE_FAILED", "dispatch intent could not be written safely");
  }
}

function readDispatchIntent(workDir: string): ExactImageDispatchIntent | null {
  let contents: string | null;
  try {
    contents = privateFileRuntime.readPrivateRegularFile(intentPath(workDir), {
      allowMissing: true,
      maxBytes: MAX_STATE_BYTES,
    });
  } catch {
    fail("PROVENANCE_MISMATCH", "dispatch intent could not be read safely");
  }
  if (contents === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    fail("PROVENANCE_MISMATCH", "dispatch intent is not valid JSON");
  }
  const intent = record(parsed, "dispatch intent");
  requireExactRecordFields(
    intent,
    ["schemaVersion", "kind", "requestStartedAt", "request", "producer"],
    "dispatch intent",
  );
  if (intent.schemaVersion !== 1 || intent.kind !== "nemoclaw-exact-image-dispatch-intent") {
    fail("PROVENANCE_MISMATCH", "dispatch intent schema identity is invalid");
  }
  persistedTimestamp(intent.requestStartedAt, "dispatch intent requestStartedAt");

  const request = record(intent.request, "dispatch intent request");
  requireExactRecordFields(
    request,
    [
      "actor",
      "candidateSha",
      "correlationId",
      "reason",
      "requesterRunAttempt",
      "requesterRunId",
      "workflowSha",
    ],
    "dispatch intent request",
  );
  persistedString(request, "actor", "dispatch intent actor", GITHUB_LOGIN_PATTERN);
  persistedString(request, "candidateSha", "dispatch intent candidate SHA", FULL_SHA_PATTERN);
  persistedString(request, "correlationId", "dispatch intent correlation ID", UUID_V4_PATTERN);
  validatePersistedReason(request.reason, "dispatch intent reason");
  const requesterRunAttempt = request.requesterRunAttempt;
  if (
    typeof requesterRunAttempt !== "number" ||
    !Number.isSafeInteger(requesterRunAttempt) ||
    requesterRunAttempt < 1
  ) {
    fail("PROVENANCE_MISMATCH", "dispatch intent requester run attempt must be positive");
  }
  persistedString(
    request,
    "requesterRunId",
    "dispatch intent requester run ID",
    DECIMAL_ID_PATTERN,
  );
  persistedString(request, "workflowSha", "dispatch intent workflow SHA", FULL_SHA_PATTERN);

  const producer = record(intent.producer, "dispatch intent producer");
  requireExactRecordFields(
    producer,
    ["repository", "repositorySha", "ref", "workflowId", "workflowPath"],
    "dispatch intent producer",
  );
  requireExactString(producer.repository, PRODUCER_REPOSITORY, "dispatch intent repository");
  persistedString(producer, "repositorySha", "dispatch intent producer SHA", FULL_SHA_PATTERN);
  requireExactString(producer.ref, PRODUCER_REF, "dispatch intent producer ref");
  persistedString(producer, "workflowId", "dispatch intent workflow ID", DECIMAL_ID_PATTERN);
  requireExactString(
    producer.workflowPath,
    PRODUCER_WORKFLOW_PATH,
    "dispatch intent workflow path",
  );
  return intent as unknown as ExactImageDispatchIntent;
}

function requiredDispatchIntent(workDir: string): ExactImageDispatchIntent {
  const intent = readDispatchIntent(workDir);
  if (intent === null) fail("PROVENANCE_MISMATCH", "dispatch intent is missing");
  return intent;
}

function validateStateIntentBinding(
  state: ExactImageQualificationState,
  intent: ExactImageDispatchIntent,
): void {
  const comparisons: Array<[unknown, unknown, string]> = [
    [state.dispatchedAt, intent.requestStartedAt, "dispatch timestamp"],
    [state.request.actor, intent.request.actor, "actor"],
    [state.request.candidateSha, intent.request.candidateSha, "candidate SHA"],
    [state.request.correlationId, intent.request.correlationId, "correlation ID"],
    [state.request.reason, intent.request.reason, "reason"],
    [
      state.request.requesterRunAttempt,
      intent.request.requesterRunAttempt,
      "requester run attempt",
    ],
    [state.request.requesterRunId, intent.request.requesterRunId, "requester run ID"],
    [state.request.workflowSha, intent.request.workflowSha, "workflow SHA"],
    [state.producer.repository, intent.producer.repository, "producer repository"],
    [state.producer.repositorySha, intent.producer.repositorySha, "producer SHA"],
    [state.producer.ref, intent.producer.ref, "producer ref"],
    [state.producer.workflowId, intent.producer.workflowId, "producer workflow ID"],
    [state.producer.workflowPath, intent.producer.workflowPath, "producer workflow path"],
  ];
  for (const [actual, expected, label] of comparisons) {
    if (actual !== expected) {
      fail("PROVENANCE_MISMATCH", `controller state ${label} does not match dispatch intent`);
    }
  }
}

function readBoundExactImageQualificationState(workDir: string): ExactImageQualificationState {
  const state = readExactImageQualificationState(workDir);
  validateStateIntentBinding(state, requiredDispatchIntent(workDir));
  return state;
}

function writeDispatchReconciliation(
  workDir: string,
  intent: ExactImageDispatchIntent,
  runs: readonly QualificationWorkflowRun[],
  outcome: "none" | "recovered-one" | "multiple",
  now: () => number,
): void {
  const evidence = {
    schemaVersion: 1,
    kind: "nemoclaw-exact-image-dispatch-reconciliation",
    recordedAt: timestamp(now),
    outcome,
    correlationId: intent.request.correlationId,
    runIds: runs.map((run) => run.id),
    producerHeadShas: Object.fromEntries(runs.map((run) => [run.id, run.headSha])),
  };
  try {
    privateFileRuntime.writePrivateRegularFile(
      path.join(workDir, DISPATCH_RECONCILIATION_FILE),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  } catch {
    fail("OUTPUT_WRITE_FAILED", "dispatch reconciliation evidence could not be written safely");
  }
}

function writeAtomicPrivateRegularFile(file: string, contents: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    privateFileRuntime.writePrivateRegularFile(temporary, contents);
    if (fs.existsSync(file)) {
      const current = fs.lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
        fail("OUTPUT_WRITE_FAILED", "existing controller state is not one regular file");
      }
    }
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // A successfully renamed temporary path no longer exists; a failed
      // cleanup must not hide the original atomic-write error.
    }
  }
}

type PersistedQualificationStatus = ExactImageQualificationState["status"];

function validatePersistedRequest(value: unknown): void {
  const request = record(value, "controller state request");
  requireExactRecordFields(
    request,
    [
      "actor",
      "candidateSha",
      "correlationId",
      "reason",
      "requesterRunAttempt",
      "requesterRunId",
      "workflowSha",
    ],
    "controller state request",
  );
  persistedString(request, "actor", "controller state actor", GITHUB_LOGIN_PATTERN);
  persistedString(request, "candidateSha", "controller state candidate SHA", FULL_SHA_PATTERN);
  persistedString(request, "correlationId", "controller state correlation ID", UUID_V4_PATTERN);
  validatePersistedReason(request.reason, "controller state reason");
  const requesterRunAttempt = request.requesterRunAttempt;
  if (
    typeof requesterRunAttempt !== "number" ||
    !Number.isSafeInteger(requesterRunAttempt) ||
    requesterRunAttempt < 1
  ) {
    fail("PROVENANCE_MISMATCH", "controller state requester run attempt must be positive");
  }
  persistedString(
    request,
    "requesterRunId",
    "controller state requester run ID",
    DECIMAL_ID_PATTERN,
  );
  persistedString(request, "workflowSha", "controller state workflow SHA", FULL_SHA_PATTERN);
}

function validatePersistedProducer(
  value: unknown,
  status: PersistedQualificationStatus,
  dispatchedAt: number,
): { completedAt: number | null; runId: string } {
  const producer = record(value, "controller state producer");
  const completed = status !== "dispatched";
  requireExactRecordFields(
    producer,
    [
      "repository",
      "repositorySha",
      "ref",
      "workflowPath",
      "runId",
      "runAttempt",
      "workflowId",
      "runUrl",
      "htmlUrl",
      ...(completed ? ["completedAt"] : []),
    ],
    "controller state producer",
  );
  requireExactString(producer.repository, PRODUCER_REPOSITORY, "controller state repository");
  persistedString(producer, "repositorySha", "controller state producer SHA", FULL_SHA_PATTERN);
  requireExactString(producer.ref, PRODUCER_REF, "controller state producer ref");
  requireExactString(
    producer.workflowPath,
    PRODUCER_WORKFLOW_PATH,
    "controller state workflow path",
  );
  const runId = persistedString(
    producer,
    "runId",
    "controller state producer run ID",
    DECIMAL_ID_PATTERN,
  );
  if (producer.runAttempt !== 1) {
    fail("PROVENANCE_MISMATCH", "controller state producer run attempt must equal 1");
  }
  persistedString(
    producer,
    "workflowId",
    "controller state producer workflow ID",
    DECIMAL_ID_PATTERN,
  );
  const expectedUrls = canonicalDispatchDetails(runId);
  requireExactString(producer.runUrl, expectedUrls.runUrl, "controller state producer run URL");
  requireExactString(producer.htmlUrl, expectedUrls.htmlUrl, "controller state producer HTML URL");
  const completedAt = completed
    ? persistedTimestamp(producer.completedAt, "controller state completedAt")
    : null;
  if (completedAt !== null && completedAt < dispatchedAt) {
    fail("PROVENANCE_MISMATCH", "controller state completedAt precedes dispatchedAt");
  }
  if (completedAt !== null && completedAt > dispatchedAt + QUALIFICATION_TIMEOUT_MS) {
    fail("PROVENANCE_MISMATCH", "controller state completedAt exceeds qualification deadline");
  }
  return { completedAt, runId };
}

function validatePersistedArtifact(value: unknown, runId: string): string {
  const artifact = record(value, "controller state artifact");
  requireExactRecordFields(
    artifact,
    [
      "id",
      "name",
      "digest",
      "sizeInBytes",
      "apiUrl",
      "archiveDownloadUrl",
      "archiveSha256",
      "manifestSha256",
    ],
    "controller state artifact",
  );
  const id = persistedString(artifact, "id", "controller state artifact ID", DECIMAL_ID_PATTERN);
  requireExactString(
    artifact.name,
    `nemoclaw-image-handoff-v1-${runId}-1`,
    "controller state artifact name",
  );
  const digest = persistedString(
    artifact,
    "digest",
    "controller state artifact digest",
    ARTIFACT_DIGEST_PATTERN,
  );
  if (
    !Number.isSafeInteger(artifact.sizeInBytes) ||
    (artifact.sizeInBytes as number) < 1 ||
    (artifact.sizeInBytes as number) > MAX_ARCHIVE_BYTES
  ) {
    fail("PROVENANCE_MISMATCH", "controller state artifact size is invalid");
  }
  const apiUrl = `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/${id}`;
  requireExactString(artifact.apiUrl, apiUrl, "controller state artifact API URL");
  requireExactString(
    artifact.archiveDownloadUrl,
    `${apiUrl}/zip`,
    "controller state artifact archive URL",
  );
  const archiveSha256 = persistedString(
    artifact,
    "archiveSha256",
    "controller state archive hash",
    SHA256_PATTERN,
  );
  if (digest !== `sha256:${archiveSha256}`) {
    fail("PROVENANCE_MISMATCH", "controller state artifact digest does not match archive hash");
  }
  return persistedString(
    artifact,
    "manifestSha256",
    "controller state manifest hash",
    SHA256_PATTERN,
  );
}

function validatePersistedValidation(
  value: unknown,
  manifestSha256: string,
  completedAt: number,
  dispatchedAt: number,
): void {
  const validation = record(value, "controller state validation");
  requireExactRecordFields(
    validation,
    ["acceptedAt", "manifestSha256", "normalizedManifestSha256"],
    "controller state validation",
  );
  const acceptedAt = persistedTimestamp(validation.acceptedAt, "controller state acceptedAt");
  if (acceptedAt < completedAt) {
    fail("PROVENANCE_MISMATCH", "controller state acceptedAt precedes completedAt");
  }
  if (acceptedAt > dispatchedAt + QUALIFICATION_TIMEOUT_MS) {
    fail("PROVENANCE_MISMATCH", "controller state acceptedAt exceeds qualification deadline");
  }
  requireExactString(
    validation.manifestSha256,
    manifestSha256,
    "controller state accepted manifest hash",
  );
  persistedString(
    validation,
    "normalizedManifestSha256",
    "controller state normalized manifest hash",
    SHA256_PATTERN,
  );
}

function validatePersistedQualificationState(value: unknown): ExactImageQualificationState {
  const state = record(value, "controller state");
  const statuses = new Set<PersistedQualificationStatus>([
    "dispatched",
    "completed",
    "downloaded",
    "validated",
  ]);
  if (
    typeof state.status !== "string" ||
    !statuses.has(state.status as PersistedQualificationStatus)
  ) {
    fail("PROVENANCE_MISMATCH", "controller state status is invalid");
  }
  const status = state.status as PersistedQualificationStatus;
  const hasArtifact = status === "downloaded" || status === "validated";
  requireExactRecordFields(
    state,
    [
      "schemaVersion",
      "status",
      "dispatchedAt",
      "request",
      "producer",
      ...(hasArtifact ? ["artifact"] : []),
      ...(status === "validated" ? ["validation"] : []),
    ],
    "controller state",
  );
  if (state.schemaVersion !== 1) {
    fail("PROVENANCE_MISMATCH", "controller state schema version must equal 1");
  }
  const dispatchedAt = persistedTimestamp(state.dispatchedAt, "controller state dispatchedAt");
  validatePersistedRequest(state.request);
  const producer = validatePersistedProducer(state.producer, status, dispatchedAt);
  const manifestSha256 = hasArtifact
    ? validatePersistedArtifact(state.artifact, producer.runId)
    : null;
  if (status === "validated") {
    if (manifestSha256 === null || producer.completedAt === null) {
      fail("PROVENANCE_MISMATCH", "validated controller state is incomplete");
    }
    validatePersistedValidation(
      state.validation,
      manifestSha256,
      producer.completedAt,
      dispatchedAt,
    );
  }
  return state as unknown as ExactImageQualificationState;
}

function writeState(workDir: string, state: ExactImageQualificationState): void {
  try {
    const validated = validatePersistedQualificationState(state);
    writeAtomicPrivateRegularFile(statePath(workDir), `${JSON.stringify(validated, null, 2)}\n`);
  } catch {
    fail("OUTPUT_WRITE_FAILED", "controller state could not be written safely");
  }
}

function preserveUnreadableState(workDir: string): void {
  const file = statePath(workDir);
  if (!fs.existsSync(file)) return;
  const preserved = path.join(
    workDir,
    `controller-state.corrupt-${Date.now()}-${randomUUID()}.json`,
  );
  try {
    fs.renameSync(file, preserved);
  } catch {
    fail("OUTPUT_WRITE_FAILED", "unreadable controller state could not be preserved safely");
  }
}

export function readExactImageQualificationState(workDir: string): ExactImageQualificationState {
  let contents: string | null;
  try {
    contents = privateFileRuntime.readPrivateRegularFile(statePath(workDir), {
      maxBytes: MAX_STATE_BYTES,
    });
  } catch {
    fail("PROVENANCE_MISMATCH", "controller state could not be read safely");
  }
  if (contents === null) fail("PROVENANCE_MISMATCH", "controller state is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    fail("PROVENANCE_MISMATCH", "controller state is not valid JSON");
  }
  return validatePersistedQualificationState(parsed);
}

function canonicalDispatchDetails(runId: string): DispatchDetails {
  return {
    workflowRunId: runId,
    runUrl: `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/runs/${runId}`,
    htmlUrl: `https://github.com/${PRODUCER_REPOSITORY}/actions/runs/${runId}`,
  };
}

function dispatchCreationWindow(
  intent: ExactImageDispatchIntent,
  configured: ReturnType<typeof limits>,
): { earliest: number; latest: number } {
  const startedAt = Date.parse(intent.requestStartedAt);
  return {
    earliest: startedAt - DISPATCH_CLOCK_SKEW_MS,
    latest: startedAt + configured.apiRequestTimeoutMs + DISPATCH_CLOCK_SKEW_MS,
  };
}

function reconciledWorkflowRuns(
  value: unknown,
  intent: ExactImageDispatchIntent,
  configured: ReturnType<typeof limits>,
): QualificationWorkflowRun[] {
  const response = record(value, "workflow run reconciliation response");
  if (!Number.isSafeInteger(response.total_count) || (response.total_count as number) < 0) {
    fail("DISPATCH_AMBIGUOUS", "workflow run reconciliation count is invalid");
  }
  if (!Array.isArray(response.workflow_runs)) {
    fail("DISPATCH_AMBIGUOUS", "workflow run reconciliation list is missing");
  }
  if ((response.total_count as number) > response.workflow_runs.length) {
    fail("DISPATCH_AMBIGUOUS", "workflow run reconciliation was truncated");
  }
  const { earliest, latest } = dispatchCreationWindow(intent, configured);
  const title = `Qualify NemoClaw ${intent.request.candidateSha} (${intent.request.correlationId})`;
  const matches: QualificationWorkflowRun[] = [];
  for (const candidate of response.workflow_runs) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const run = candidate as Record<string, unknown>;
    const createdAt = typeof run.created_at === "string" ? Date.parse(run.created_at) : Number.NaN;
    const id = Number.isSafeInteger(run.id) && (run.id as number) > 0 ? String(run.id) : "";
    const headSha = typeof run.head_sha === "string" ? run.head_sha : "";
    const details = id ? canonicalDispatchDetails(id) : null;
    if (
      details === null ||
      run.workflow_id !== Number(intent.producer.workflowId) ||
      run.run_attempt !== 1 ||
      run.event !== "workflow_dispatch" ||
      run.head_branch !== PRODUCER_REF ||
      !FULL_SHA_PATTERN.test(headSha) ||
      run.path !== PRODUCER_WORKFLOW_PATH ||
      run.display_title !== title ||
      run.url !== details.runUrl ||
      run.html_url !== details.htmlUrl ||
      (run.repository as { full_name?: unknown } | undefined)?.full_name !== PRODUCER_REPOSITORY ||
      (run.head_repository as { full_name?: unknown } | undefined)?.full_name !==
        PRODUCER_REPOSITORY ||
      !Number.isFinite(createdAt) ||
      createdAt < earliest ||
      createdAt > latest
    ) {
      continue;
    }
    matches.push(
      validateQualificationWorkflowRun(candidate, {
        candidateSha: intent.request.candidateSha,
        correlationId: intent.request.correlationId,
        producerSha: headSha,
        workflowId: intent.producer.workflowId,
        runId: id,
        runUrl: details.runUrl,
        htmlUrl: details.htmlUrl,
      }),
    );
  }
  return matches;
}

function stateFromIntent(
  intent: ExactImageDispatchIntent,
  run: QualificationWorkflowRun,
): ExactImageQualificationState {
  return {
    schemaVersion: 1,
    status: "dispatched",
    dispatchedAt: intent.requestStartedAt,
    request: {
      actor: intent.request.actor,
      candidateSha: intent.request.candidateSha,
      correlationId: intent.request.correlationId,
      reason: intent.request.reason,
      requesterRunAttempt: intent.request.requesterRunAttempt,
      requesterRunId: intent.request.requesterRunId,
      workflowSha: intent.request.workflowSha,
    },
    producer: {
      repository: PRODUCER_REPOSITORY,
      repositorySha: run.headSha,
      ref: PRODUCER_REF,
      workflowPath: PRODUCER_WORKFLOW_PATH,
      runId: run.id,
      runAttempt: 1,
      workflowId: run.workflowId,
      runUrl: run.url,
      htmlUrl: run.htmlUrl,
    },
  };
}

async function cancelAndVerifyRecoveredRun(
  state: ExactImageQualificationState,
  initial: { status: string },
  token: string,
  api: GitHubApiClient,
  pause: (milliseconds: number) => Promise<void>,
  pollIntervalMs: number,
  deadline: number,
  now: () => number,
): Promise<boolean> {
  if (initial.status === "completed") return false;
  let cancellationError: unknown;
  try {
    await cancelRun(state, token, api);
  } catch (error) {
    cancellationError = error;
  }
  for (;;) {
    if (now() >= deadline) {
      fail("QUALIFICATION_TIMEOUT", "recovered producer run cancellation was not verified in time");
    }
    const run = validateCancellationWorkflowRun(
      await api<unknown>(
        `repos/${PRODUCER_REPOSITORY}/actions/runs/${state.producer.runId}`,
        token,
        { apiVersion: GITHUB_API_VERSION, expectedStatus: 200 },
      ),
      state,
    );
    if (run.status === "completed") return true;
    if (cancellationError !== undefined) throw cancellationError;
    await pause(pollIntervalMs);
  }
}

async function reconcileAmbiguousDispatch(
  options: {
    intent: ExactImageDispatchIntent;
    workDir: string;
    producerToken: string;
    mode: "start" | "cleanup";
  },
  dependencies: QualificationDependencies,
): Promise<boolean> {
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? sleep;
  const configured = limits(dependencies);
  const startedAt = now();
  const windowMs =
    options.mode === "cleanup"
      ? configured.cleanupTimeoutMs
      : configured.dispatchReconciliationTimeoutMs;
  const deadline = startedAt + windowMs;
  const api = boundedApiClient(dependencies.api ?? githubApi, dependencies, deadline);
  const creationWindow = dispatchCreationWindow(options.intent, configured);
  const earliestQuery = new Date(Math.floor(creationWindow.earliest / 1_000) * 1_000).toISOString();
  const latestQuery = new Date(Math.ceil(creationWindow.latest / 1_000) * 1_000).toISOString();
  const created = encodeURIComponent(
    `${earliestQuery.replace(".000Z", "Z")}..${latestQuery.replace(".000Z", "Z")}`,
  );
  const listPath =
    `repos/${PRODUCER_REPOSITORY}/actions/workflows/${PRODUCER_WORKFLOW_FILE}/runs` +
    `?event=workflow_dispatch&branch=${PRODUCER_REF}&created=${created}&per_page=100`;

  for (;;) {
    if (now() >= deadline) {
      writeDispatchReconciliation(options.workDir, options.intent, [], "none", now);
      fail(
        "DISPATCH_AMBIGUOUS",
        "no strict producer run match appeared before reconciliation timeout",
      );
    }
    const matches = reconciledWorkflowRuns(
      await api<unknown>(listPath, options.producerToken, {
        apiVersion: GITHUB_API_VERSION,
        expectedStatus: 200,
      }),
      options.intent,
      configured,
    );
    if (matches.length > 1) {
      const runIds = matches.map((run) => run.id);
      writeDispatchReconciliation(options.workDir, options.intent, matches, "multiple", now);
      for (const run of matches) {
        if (run.status !== "completed") {
          try {
            await api<unknown>(
              `repos/${PRODUCER_REPOSITORY}/actions/runs/${run.id}/cancel`,
              options.producerToken,
              { method: "POST", apiVersion: GITHUB_API_VERSION, expectedStatus: 202 },
            );
          } catch {
            // The retained exact IDs are mandatory manual-cleanup evidence.
          }
        }
      }
      fail(
        "DISPATCH_AMBIGUOUS",
        `multiple strict dispatch matches require cleanup: ${runIds.join(",")}`,
      );
    }
    if (matches.length === 1) {
      const recovered = matches[0];
      const state = stateFromIntent(options.intent, recovered);
      writeState(options.workDir, state);
      writeDispatchReconciliation(
        options.workDir,
        options.intent,
        [recovered],
        "recovered-one",
        now,
      );
      const cancelled = await cancelAndVerifyRecoveredRun(
        state,
        recovered,
        options.producerToken,
        api,
        pause,
        configured.reconciliationPollIntervalMs,
        deadline,
        now,
      );
      if (options.mode === "cleanup") return cancelled;
      fail(
        "DISPATCH_AMBIGUOUS",
        `recovered producer run ${recovered.id} was not accepted and was cleaned up`,
      );
    }
    await pause(configured.reconciliationPollIntervalMs);
  }
}

export async function startExactImageQualification(
  options: {
    request: ExactImageQualificationRequest;
    coreToken: string;
    producerToken: string;
    workDir: string;
  },
  dependencies: QualificationDependencies = {},
): Promise<ExactImageQualificationState> {
  const now = dependencies.now ?? Date.now;
  const initialApi = boundedApiClient(dependencies.api ?? githubApi, dependencies);
  await authorizeRequest(options.request, options.coreToken, initialApi);

  const producerRef = await initialApi<unknown>(
    `repos/${PRODUCER_REPOSITORY}/git/ref/heads/${PRODUCER_REF}`,
    options.producerToken,
    { apiVersion: GITHUB_API_VERSION, expectedStatus: 200 },
  );
  const producerSha = validateMainRef(producerRef, PRODUCER_REPOSITORY);
  const workflowId = validateProducerWorkflow(
    await initialApi<unknown>(
      `repos/${PRODUCER_REPOSITORY}/actions/workflows/${PRODUCER_WORKFLOW_FILE}`,
      options.producerToken,
      { apiVersion: GITHUB_API_VERSION, expectedStatus: 200 },
    ),
  );
  const correlationId = (dependencies.randomUuid ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(correlationId)) {
    fail("REQUEST_INVALID", "generated correlation ID was not a lowercase UUIDv4");
  }

  const intent: ExactImageDispatchIntent = {
    schemaVersion: 1,
    kind: "nemoclaw-exact-image-dispatch-intent",
    requestStartedAt: timestamp(now),
    request: {
      actor: options.request.actor,
      candidateSha: options.request.candidateSha,
      correlationId,
      reason: options.request.reason,
      requesterRunAttempt: options.request.requesterRunAttempt,
      requesterRunId: options.request.requesterRunId,
      workflowSha: options.request.workflowSha,
    },
    producer: {
      repository: PRODUCER_REPOSITORY,
      repositorySha: producerSha,
      ref: PRODUCER_REF,
      workflowId,
      workflowPath: PRODUCER_WORKFLOW_PATH,
    },
  };
  writeDispatchIntent(options.workDir, intent);
  const stateDeadline =
    Date.parse(intent.requestStartedAt) + limits(dependencies).qualificationTimeoutMs;
  const api = boundedApiClient(dependencies.api ?? githubApi, dependencies, stateDeadline);

  let dispatch: DispatchDetails;
  try {
    const dispatchResponse = await api<unknown>(
      `repos/${PRODUCER_REPOSITORY}/actions/workflows/${PRODUCER_WORKFLOW_FILE}/dispatches`,
      options.producerToken,
      {
        method: "POST",
        apiVersion: GITHUB_API_VERSION,
        expectedStatus: 200,
        body: {
          ref: PRODUCER_REF,
          inputs: {
            nemoclaw_sha: options.request.candidateSha,
            correlation_id: correlationId,
            requester_workflow_run_id: options.request.requesterRunId,
            requester_workflow_run_attempt: String(options.request.requesterRunAttempt),
          },
          return_run_details: true,
        },
      },
    );
    dispatch = validateWorkflowDispatchDetails(dispatchResponse);
  } catch {
    await reconcileAmbiguousDispatch(
      { intent, workDir: options.workDir, producerToken: options.producerToken, mode: "start" },
      dependencies,
    );
    fail("DISPATCH_AMBIGUOUS", "producer dispatch could not be bound safely");
  }

  const state: ExactImageQualificationState = {
    schemaVersion: 1,
    status: "dispatched",
    dispatchedAt: intent.requestStartedAt,
    request: {
      actor: options.request.actor,
      candidateSha: options.request.candidateSha,
      correlationId,
      reason: options.request.reason,
      requesterRunAttempt: options.request.requesterRunAttempt,
      requesterRunId: options.request.requesterRunId,
      workflowSha: options.request.workflowSha,
    },
    producer: {
      repository: PRODUCER_REPOSITORY,
      repositorySha: producerSha,
      ref: PRODUCER_REF,
      workflowPath: PRODUCER_WORKFLOW_PATH,
      runId: dispatch.workflowRunId,
      runAttempt: 1,
      runUrl: dispatch.runUrl,
      htmlUrl: dispatch.htmlUrl,
      workflowId,
    },
  };
  // Persist the returned ID before any further API call so the always-run
  // cleanup step can cancel exactly this run if identity validation fails.
  writeState(options.workDir, state);

  const run = validateQualificationWorkflowRun(
    await api<unknown>(
      `repos/${PRODUCER_REPOSITORY}/actions/runs/${dispatch.workflowRunId}`,
      options.producerToken,
      { apiVersion: GITHUB_API_VERSION, expectedStatus: 200 },
    ),
    {
      candidateSha: options.request.candidateSha,
      correlationId,
      producerSha,
      workflowId,
      runId: dispatch.workflowRunId,
      runUrl: dispatch.runUrl,
      htmlUrl: dispatch.htmlUrl,
    },
  );
  state.producer.workflowId = run.workflowId;
  writeState(options.workDir, state);
  return state;
}

function expectedRun(state: ExactImageQualificationState) {
  return {
    candidateSha: state.request.candidateSha,
    correlationId: state.request.correlationId,
    producerSha: state.producer.repositorySha,
    workflowId: state.producer.workflowId,
    runId: state.producer.runId,
    runUrl: state.producer.runUrl,
    htmlUrl: state.producer.htmlUrl,
  };
}

async function cancelRun(
  state: ExactImageQualificationState,
  token: string,
  api: GitHubApiClient,
): Promise<void> {
  await api<unknown>(
    `repos/${PRODUCER_REPOSITORY}/actions/runs/${state.producer.runId}/cancel`,
    token,
    { method: "POST", apiVersion: GITHUB_API_VERSION, expectedStatus: 202 },
  );
}

export async function waitForExactImageQualification(
  options: { workDir: string; producerToken: string },
  dependencies: QualificationDependencies = {},
): Promise<QualificationWorkflowRun> {
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? sleep;
  const configured = limits(dependencies);
  const state = readBoundExactImageQualificationState(options.workDir);
  if (state.status !== "dispatched") {
    fail("PROVENANCE_MISMATCH", "producer run may only be awaited from dispatched state");
  }
  const startedAt = Date.parse(state.dispatchedAt);
  const hardDeadline = qualificationDeadline(state, configured.qualificationTimeoutMs);
  const deadline = acceptanceDeadline(state, dependencies);
  const api = boundedApiClient(dependencies.api ?? githubApi, dependencies, deadline);
  const cancelApi = boundedApiClient(dependencies.api ?? githubApi, dependencies, hardDeadline);
  let warned = false;

  for (;;) {
    if (now() >= deadline) {
      const finalRun = validateQualificationWorkflowRun(
        await cancelApi<unknown>(
          `repos/${PRODUCER_REPOSITORY}/actions/runs/${state.producer.runId}`,
          options.producerToken,
          { apiVersion: GITHUB_API_VERSION, expectedStatus: 200 },
        ),
        expectedRun(state),
      );
      if (finalRun.status !== "completed") {
        await cancelRun(state, options.producerToken, cancelApi);
      }
      fail("QUALIFICATION_TIMEOUT", "qualification reached its cancellation reserve");
    }
    const run = validateQualificationWorkflowRun(
      await api<unknown>(
        `repos/${PRODUCER_REPOSITORY}/actions/runs/${state.producer.runId}`,
        options.producerToken,
        { apiVersion: GITHUB_API_VERSION, expectedStatus: 200 },
      ),
      expectedRun(state),
    );
    const observedAt = now();
    const elapsed = observedAt - startedAt;
    if (observedAt >= deadline) {
      if (run.status !== "completed") {
        await cancelRun(state, options.producerToken, cancelApi);
      }
      fail("QUALIFICATION_TIMEOUT", "qualification reached its cancellation reserve");
    }
    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        fail("PRODUCER_RUN_FAILED", `producer run completed with ${run.conclusion ?? "no result"}`);
      }
      state.status = "completed";
      state.producer.completedAt = timestamp(now);
      state.producer.workflowId = run.workflowId;
      writeState(options.workDir, state);
      return run;
    }

    if (run.status !== "in_progress" && elapsed >= configured.queueTimeoutMs) {
      await cancelRun(state, options.producerToken, cancelApi);
      fail("RUN_QUEUE_TIMEOUT", "producer run did not start within 10 minutes");
    }
    if (!warned && elapsed >= configured.warningAfterMs) {
      console.warn(
        "Qualification image build has exceeded 25 minutes; continuing to the hard limit.",
      );
      warned = true;
    }
    await pause(configured.pollIntervalMs);
  }
}

export function validateQualificationArtifactList(
  value: unknown,
  state: ExactImageQualificationState,
): QualificationArtifact | null {
  const response = record(value, "artifact list response");
  if (!Number.isSafeInteger(response.total_count) || (response.total_count as number) < 0) {
    fail("ARTIFACT_MISSING_OR_INVALID", "artifact total_count is invalid");
  }
  if (!Array.isArray(response.artifacts)) {
    fail("ARTIFACT_MISSING_OR_INVALID", "artifact list is missing artifacts");
  }
  if (response.total_count === 0 && response.artifacts.length === 0) return null;
  if (response.total_count !== 1 || response.artifacts.length !== 1) {
    fail("ARTIFACT_MISSING_OR_INVALID", "producer run must publish exactly one artifact");
  }
  const artifact = record(response.artifacts[0], "qualification artifact");
  const id = safePositiveId(artifact.id, "artifact ID");
  const expectedName = `nemoclaw-image-handoff-v1-${state.producer.runId}-${state.producer.runAttempt}`;
  requireExactString(artifact.name, expectedName, "artifact name");
  if (artifact.expired !== false) fail("ARTIFACT_MISSING_OR_INVALID", "artifact is expired");
  if (typeof artifact.digest !== "string" || !ARTIFACT_DIGEST_PATTERN.test(artifact.digest)) {
    fail("ARTIFACT_MISSING_OR_INVALID", "artifact digest must be a lowercase SHA-256 digest");
  }
  if (
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    (artifact.size_in_bytes as number) < 1 ||
    (artifact.size_in_bytes as number) > MAX_ARCHIVE_BYTES
  ) {
    fail("ARTIFACT_MISSING_OR_INVALID", "artifact archive size is outside the accepted range");
  }
  const apiUrl = `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/${id}`;
  const archiveDownloadUrl = `${apiUrl}/zip`;
  requireExactString(artifact.url, apiUrl, "artifact API URL");
  requireExactString(artifact.archive_download_url, archiveDownloadUrl, "artifact archive URL");
  const workflowRun = record(artifact.workflow_run, "artifact workflow run");
  if (safePositiveId(workflowRun.id, "artifact workflow run ID") !== state.producer.runId) {
    fail("PROVENANCE_MISMATCH", "artifact workflow run ID did not match the dispatched run");
  }
  requireExactString(
    workflowRun.head_sha,
    state.producer.repositorySha,
    "artifact workflow run head SHA",
  );
  return {
    id,
    name: expectedName,
    digest: artifact.digest,
    sizeInBytes: artifact.size_in_bytes as number,
    apiUrl,
    archiveDownloadUrl,
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const header = response.headers.get("content-length");
  if (header !== null && (!/^[0-9]+$/u.test(header) || Number(header) > maxBytes)) {
    fail("ARTIFACT_MISSING_OR_INVALID", "artifact response is larger than the accepted limit");
  }
  if (!response.body) fail("ARTIFACT_DOWNLOAD_TRANSIENT", "artifact response had no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      fail("ARTIFACT_MISSING_OR_INVALID", "artifact response exceeded the accepted limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function writePrivateBuffer(file: string, contents: Buffer): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW | NON_BLOCK,
      0o600,
    );
  } catch {
    fail("OUTPUT_WRITE_FAILED", "artifact output could not be created safely");
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      fail("OUTPUT_WRITE_FAILED", "artifact output must be one private regular file");
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function defaultCommandRunner(_command: string, args: readonly string[]): CommandResult {
  return spawnSync("/usr/bin/unzip", [...args], {
    encoding: null,
    env: {
      LANG: "C",
      LC_ALL: "C",
    },
    maxBuffer: MAX_MANIFEST_BYTES + 4096,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}

function successfulCommand(result: CommandResult, label: string): Buffer {
  if (result.error || result.status !== 0 || result.signal) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${label} rejected the artifact archive`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

export function extractExactManifestArchive(
  archivePath: string,
  outputPath: string,
  runCommand: CommandRunner = defaultCommandRunner,
): Buffer {
  const entries = successfulCommand(runCommand("unzip", ["-Z1", archivePath]), "ZIP inventory");
  if (!entries.equals(Buffer.from(`${MANIFEST_ARTIFACT_FILE}\n`, "utf8"))) {
    fail(
      "ARTIFACT_MISSING_OR_INVALID",
      `artifact ZIP must contain exactly ${MANIFEST_ARTIFACT_FILE} at its root`,
    );
  }
  const metadata = successfulCommand(
    runCommand("unzip", ["-Zl", archivePath, MANIFEST_ARTIFACT_FILE]),
    "ZIP metadata inspection",
  ).toString("utf8");
  const matchingMetadata = metadata
    .split(/\r?\n/u)
    .filter((line) => line.endsWith(` ${MANIFEST_ARTIFACT_FILE}`));
  if (matchingMetadata.length !== 1 || !matchingMetadata[0]?.startsWith("-")) {
    fail("ARTIFACT_MISSING_OR_INVALID", "artifact manifest ZIP entry must be a regular file");
  }
  const manifest = successfulCommand(
    runCommand("unzip", ["-p", archivePath, MANIFEST_ARTIFACT_FILE]),
    "ZIP extraction",
  );
  if (manifest.length === 0 || manifest.length > MAX_MANIFEST_BYTES) {
    fail("ARTIFACT_MISSING_OR_INVALID", "artifact manifest size is outside the accepted range");
  }
  writePrivateBuffer(outputPath, manifest);
  const stat = fs.lstatSync(outputPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size !== manifest.length
  ) {
    fail("ARTIFACT_MISSING_OR_INVALID", "extracted manifest is not one regular direct file");
  }
  return manifest;
}

export async function downloadExactImageManifest(
  options: { workDir: string; producerToken: string },
  dependencies: QualificationDependencies = {},
): Promise<QualificationArtifact> {
  const state = readBoundExactImageQualificationState(options.workDir);
  if (state.status !== "completed") {
    fail("PROVENANCE_MISMATCH", "producer run must complete before artifact download");
  }
  const pause = dependencies.sleep ?? sleep;
  const now = dependencies.now ?? Date.now;
  const configured = limits(dependencies);
  const deadline = qualificationDeadline(state, configured.qualificationTimeoutMs);
  const api = boundedApiClient(dependencies.api ?? githubApi, dependencies, deadline);
  requireQualificationTimeRemaining(deadline, now);
  const artifactStartedAt = now();
  const artifactDeadline = Math.min(
    artifactStartedAt + configured.artifactPropagationTimeoutMs,
    deadline,
  );
  let artifact: QualificationArtifact | null = null;
  while (artifact === null) {
    requireQualificationTimeRemaining(deadline, now);
    artifact = validateQualificationArtifactList(
      await api<unknown>(
        `repos/${PRODUCER_REPOSITORY}/actions/runs/${state.producer.runId}/artifacts?per_page=100`,
        options.producerToken,
        { apiVersion: GITHUB_API_VERSION, expectedStatus: 200 },
      ),
      state,
    );
    requireQualificationTimeRemaining(deadline, now);
    if (artifact !== null) break;
    if (now() >= artifactDeadline) {
      fail("ARTIFACT_PENDING", "qualification artifact did not appear within two minutes");
    }
    await pause(configured.pollIntervalMs);
  }

  const controller = new AbortController();
  const downloadBudget = Math.min(
    configured.downloadTimeoutMs,
    requireQualificationTimeRemaining(deadline, now),
  );
  const timer = setTimeout(() => controller.abort(), downloadBudget);
  let archive: Buffer;
  try {
    const response = await (dependencies.fetch ?? fetch)(artifact.archiveDownloadUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.producerToken}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      redirect: "follow",
      signal: controller.signal,
    });
    requireQualificationTimeRemaining(deadline, now);
    if (response.status !== 200) {
      fail("ARTIFACT_DOWNLOAD_TRANSIENT", `artifact archive download returned ${response.status}`);
    }
    archive = await readBoundedResponse(response, MAX_ARCHIVE_BYTES);
  } catch (error) {
    if (error instanceof ExactImageQualificationError) throw error;
    requireQualificationTimeRemaining(deadline, now);
    fail("ARTIFACT_DOWNLOAD_TRANSIENT", "artifact archive download failed");
  } finally {
    clearTimeout(timer);
  }
  requireQualificationTimeRemaining(deadline, now);
  if (archive.length !== artifact.sizeInBytes) {
    fail("ARTIFACT_MISSING_OR_INVALID", "downloaded archive size did not match artifact metadata");
  }
  const archiveHash = sha256(archive);
  if (`sha256:${archiveHash}` !== artifact.digest) {
    fail("ARTIFACT_MISSING_OR_INVALID", "downloaded archive digest did not match GitHub metadata");
  }

  const archivePath = path.join(options.workDir, ARCHIVE_FILE);
  const manifestPath = path.join(options.workDir, MANIFEST_ARTIFACT_FILE);
  writePrivateBuffer(archivePath, archive);
  const manifest = extractExactManifestArchive(
    archivePath,
    manifestPath,
    dependencies.runCommand ?? defaultCommandRunner,
  );
  requireQualificationTimeRemaining(deadline, now);
  state.artifact = {
    ...artifact,
    archiveSha256: archiveHash,
    manifestSha256: sha256(manifest),
  };
  state.status = "downloaded";
  writeState(options.workDir, state);
  return artifact;
}

function readPrivateBuffer(file: string, maxBytes: number): Buffer {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch {
    fail("PROVENANCE_MISMATCH", "qualification evidence file could not be opened safely");
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) {
      fail("PROVENANCE_MISMATCH", "qualification evidence file failed regular-file checks");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.nlink !== 1) {
      fail("PROVENANCE_MISMATCH", "qualification evidence file changed while it was read");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function finalizeExactImageQualification(
  workDir: string,
  dependencies: QualificationDependencies = {},
): ExactImageQualificationState {
  const state = readBoundExactImageQualificationState(workDir);
  if (state.status !== "downloaded" || !state.artifact) {
    fail("PROVENANCE_MISMATCH", "artifact must be digest-verified before finalization");
  }
  const now = dependencies.now ?? Date.now;
  const deadline = qualificationDeadline(state, limits(dependencies).qualificationTimeoutMs);
  requireQualificationTimeRemaining(deadline, now);
  const manifestHash = sha256(
    readPrivateBuffer(path.join(workDir, MANIFEST_ARTIFACT_FILE), MAX_MANIFEST_BYTES),
  );
  if (manifestHash !== state.artifact.manifestSha256) {
    fail("PROVENANCE_MISMATCH", "manifest changed after archive verification");
  }
  const normalizedHash = sha256(
    readPrivateBuffer(path.join(workDir, VALIDATED_MANIFEST_FILE), MAX_MANIFEST_BYTES),
  );
  requireQualificationTimeRemaining(deadline, now);
  state.validation = {
    acceptedAt: timestamp(now),
    manifestSha256: manifestHash,
    normalizedManifestSha256: normalizedHash,
  };
  state.status = "validated";
  const evidence = {
    schemaVersion: 1,
    kind: "nemoclaw-exact-image-qualification-evidence",
    qualificationStatus: "accepted",
    request: state.request,
    producer: state.producer,
    artifact: state.artifact,
    validation: state.validation,
  };
  // The state is the durable commit point for acceptance. Validate and persist
  // that transition before publishing an accepted receipt so a rejected state
  // can never leave accepted evidence behind.
  writeState(workDir, state);
  try {
    privateFileRuntime.writePrivateRegularFile(
      path.join(workDir, EVIDENCE_FILE),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  } catch {
    fail("OUTPUT_WRITE_FAILED", "qualification evidence could not be written safely");
  }
  return state;
}

export async function cancelActiveExactImageQualification(
  options: { workDir: string; producerToken: string },
  dependencies: QualificationDependencies = {},
): Promise<boolean> {
  let state: ExactImageQualificationState;
  try {
    state = readExactImageQualificationState(options.workDir);
  } catch (error) {
    if (!fs.existsSync(intentPath(options.workDir))) {
      if (fs.existsSync(statePath(options.workDir))) throw error;
      return false;
    }
    // State crosses independent workflow steps and is untrusted/damaged-disk input on every read.
    // Atomic replacement prevents ordinary partial writes, while this permanent defense-in-depth
    // path preserves interruption/filesystem-corruption evidence and reconciles only from the
    // separately validated durable intent.
    preserveUnreadableState(options.workDir);
    const intent = requiredDispatchIntent(options.workDir);
    return reconcileAmbiguousDispatch({ ...options, intent, mode: "cleanup" }, dependencies);
  }
  const now = dependencies.now ?? Date.now;
  const configured = limits(dependencies);
  const intent = requiredDispatchIntent(options.workDir);
  try {
    validateStateIntentBinding(state, intent);
  } catch {
    preserveUnreadableState(options.workDir);
    return reconcileAmbiguousDispatch({ ...options, intent, mode: "cleanup" }, dependencies);
  }
  const deadline = now() + configured.cleanupTimeoutMs;
  const api = boundedApiClient(dependencies.api ?? githubApi, dependencies, deadline);
  const initial = validateCancellationWorkflowRun(
    await api<unknown>(
      `repos/${PRODUCER_REPOSITORY}/actions/runs/${state.producer.runId}`,
      options.producerToken,
      { apiVersion: GITHUB_API_VERSION, expectedStatus: 200 },
    ),
    state,
  );
  return cancelAndVerifyRecoveredRun(
    state,
    initial,
    options.producerToken,
    api,
    dependencies.sleep ?? sleep,
    configured.reconciliationPollIntervalMs,
    deadline,
    now,
  );
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("REQUEST_INVALID", `${flag ?? "argument"} requires one value`);
    }
    if (flags.has(flag)) fail("REQUEST_INVALID", `${flag} may be provided only once`);
    flags.set(flag, value);
  }
  return flags;
}

function requiredFlag(flags: Map<string, string>, flag: string): string {
  const value = flags.get(flag);
  if (value === undefined) fail("REQUEST_INVALID", `${flag} is required`);
  return value;
}

export function parseExactImageQualificationCommand(argv: readonly string[]): ControllerCommand {
  const flags = parseFlags(argv);
  const mode = requiredFlag(flags, "--mode");
  if (["wait", "download", "finalize", "cancel"].includes(mode)) {
    const allowed = new Set(["--mode", "--work-dir"]);
    for (const flag of flags.keys()) {
      if (!allowed.has(flag)) fail("REQUEST_INVALID", `unknown argument ${flag}`);
    }
    return {
      mode: mode as "wait" | "download" | "finalize" | "cancel",
      workDir: requiredFlag(flags, "--work-dir"),
    };
  }
  if (mode !== "preflight" && mode !== "start") {
    fail("REQUEST_INVALID", `unsupported mode ${mode}`);
  }
  const allowed = new Set([
    "--mode",
    "--actor",
    "--candidate-sha",
    "--event-name",
    "--reason",
    "--ref",
    "--requester-run-attempt",
    "--requester-run-id",
    "--workflow-sha",
    ...(mode === "start" ? ["--work-dir"] : []),
  ]);
  for (const flag of flags.keys()) {
    if (!allowed.has(flag)) fail("REQUEST_INVALID", `unknown argument ${flag}`);
  }
  const request = validateExactImageQualificationRequest({
    actor: requiredFlag(flags, "--actor"),
    candidateSha: requiredFlag(flags, "--candidate-sha"),
    eventName: requiredFlag(flags, "--event-name"),
    reason: requiredFlag(flags, "--reason"),
    ref: requiredFlag(flags, "--ref"),
    requesterRunAttempt: positiveInteger(
      requiredFlag(flags, "--requester-run-attempt"),
      "requester run attempt",
    ),
    requesterRunId: requiredFlag(flags, "--requester-run-id"),
    workflowSha: requiredFlag(flags, "--workflow-sha"),
  });
  return mode === "preflight"
    ? { mode, request }
    : { mode, request, workDir: requiredFlag(flags, "--work-dir") };
}

function requiredToken(name: string): string {
  const token = process.env[name];
  if (!token) fail("REQUEST_INVALID", `${name} is required`);
  return token;
}

function writeOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(output, `${name}=${value}\n`, { encoding: "utf8", mode: 0o600 });
}

async function main(): Promise<void> {
  const command = parseExactImageQualificationCommand(process.argv.slice(2));
  if (command.mode === "preflight") {
    await preflightExactImageQualification(command.request, requiredToken("GITHUB_TOKEN"));
    console.log("Draft qualification request passed preflight.");
    return;
  }
  if (command.mode === "start") {
    const state = await startExactImageQualification({
      request: command.request,
      coreToken: requiredToken("GITHUB_TOKEN"),
      producerToken: requiredToken("NEMOCLAW_IMAGE_QUALIFICATION_TOKEN"),
      workDir: command.workDir,
    });
    writeOutput("correlation_id", state.request.correlationId);
    writeOutput("image_repository_sha", state.producer.repositorySha);
    writeOutput("producer_run_id", state.producer.runId);
    writeOutput("producer_run_attempt", String(state.producer.runAttempt));
    console.log(`Dispatched and bound producer run ${state.producer.runId}.`);
    return;
  }
  if (command.mode === "wait") {
    const run = await waitForExactImageQualification({
      workDir: command.workDir,
      producerToken: requiredToken("NEMOCLAW_IMAGE_QUALIFICATION_TOKEN"),
    });
    console.log(`Producer run ${run.id} completed successfully.`);
    return;
  }
  if (command.mode === "download") {
    const artifact = await downloadExactImageManifest({
      workDir: command.workDir,
      producerToken: requiredToken("NEMOCLAW_IMAGE_QUALIFICATION_TOKEN"),
    });
    console.log(`Verified and extracted artifact ${artifact.id}.`);
    return;
  }
  if (command.mode === "finalize") {
    const state = finalizeExactImageQualification(command.workDir);
    console.log(`Recorded accepted qualification evidence for run ${state.producer.runId}.`);
    return;
  }
  const cancelled = await cancelActiveExactImageQualification({
    workDir: command.workDir,
    producerToken: requiredToken("NEMOCLAW_IMAGE_QUALIFICATION_TOKEN"),
  });
  console.log(cancelled ? "Cancelled active producer run." : "No active producer run to cancel.");
}

export function exactImageQualificationFailureCode(
  error: unknown,
): ExactImageQualificationFailureCode {
  return error instanceof ExactImageQualificationError ? error.code : "UNKNOWN";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = exactImageQualificationFailureCode(error);
    const message = error instanceof Error ? error.message : "unexpected qualification error";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
