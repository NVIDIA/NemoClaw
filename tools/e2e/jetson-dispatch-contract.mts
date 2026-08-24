// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const JETSON_DISPATCH_CONTRACT_VERSION = "2.0.0";
export const JETSON_DISPATCH_V1_SHA256 =
  "d50e381860ec131e92f78c25272bfdcbacb790adc9552c3aaf0778427171314c";
export const JETSON_DISPATCH_V2_SHA256 =
  "fbf173a23db958caa74e0b32aaf362c604caf4c86204fc0a4ce7a1865b41eeb9";
export const JETSON_DISPATCH_AUDIENCE = "nemoclaw-jetson-dispatch";
export const JETSON_DISPATCH_TARGET = "jetson-nvmap-gpu";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const JOB_ID_PATTERN = /^[a-f0-9]{64}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const DISPATCH_CONCLUSIONS: readonly string[] = [
  "cancelled",
  "cleanup-failed",
  "failure",
  "success",
  "timed-out",
];
const COMPLETED_CLEANUP_STATES: readonly string[] = ["failed", "succeeded"];
const MAX_ERROR_CHARACTERS = 500;
const MAX_DEVICE_IDENTITY_CHARACTERS = 500;
export const MAX_JETSON_DISPATCH_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_JETSON_ARTIFACT_ARCHIVE_BYTES = 1024 * 1024;
const MAX_JETSON_ARTIFACT_ARCHIVE_BASE64_CHARACTERS =
  Math.ceil(MAX_JETSON_ARTIFACT_ARCHIVE_BYTES / 3) * 4;
const MAX_JETSON_DISPATCH_ARTIFACT_JSON_OVERHEAD_BYTES = 256 * 1024;
export const MAX_JETSON_DISPATCH_ARTIFACT_RESPONSE_BYTES =
  MAX_JETSON_DISPATCH_LOG_BYTES * 6 +
  MAX_JETSON_ARTIFACT_ARCHIVE_BASE64_CHARACTERS +
  MAX_JETSON_DISPATCH_ARTIFACT_JSON_OVERHEAD_BYTES;

export interface JetsonDispatchRequestV1 {
  schemaVersion: 1;
  target: typeof JETSON_DISPATCH_TARGET;
  candidateSha: string;
  workflowRunId: string;
  workflowRunAttempt: number;
}

export interface JetsonDispatchRequestV2 {
  schemaVersion: 2;
  target: typeof JETSON_DISPATCH_TARGET;
  candidateSha: string;
  managedImageRevision: string;
  workflowRunId: string;
  workflowRunAttempt: number;
}

export type JetsonDispatchRequest = JetsonDispatchRequestV1 | JetsonDispatchRequestV2;

export type JetsonDispatchConclusion =
  | "cancelled"
  | "cleanup-failed"
  | "failure"
  | "success"
  | "timed-out";

export interface JetsonDeviceIdentity {
  model: string;
  jetpackVersion: string;
  jetsonLinuxRelease: string;
  kernel: string;
}

export interface JetsonDispatchStatus {
  schemaVersion: 1 | 2;
  jobId: string;
  request: JetsonDispatchRequest;
  state: "queued" | "running" | "completed";
  conclusion?: JetsonDispatchConclusion;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  device?: JetsonDeviceIdentity;
  cleanup: "pending" | "succeeded" | "failed";
  error?: string;
}

export interface JetsonDispatchArtifact {
  status: JetsonDispatchStatus;
  log: string;
  artifactArchiveBase64?: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireFields(
  value: Record<string, unknown>,
  name: string,
  required: string[],
  optional: string[] = [],
  contractVersion = JETSON_DISPATCH_CONTRACT_VERSION,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !allowed.has(field))
  ) {
    throw new Error(
      `${name} fields do not match Jetson dispatch contract ${contractVersion}`,
    );
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function positiveIntegerString(value: unknown, name: string): string {
  if (typeof value !== "string" || !POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new Error(`${name} must be a positive decimal integer`);
  }
  return value;
}

export function parseJetsonDispatchRequest(value: unknown): JetsonDispatchRequest {
  const request = record(value, "dispatch request");
  const baseFields = [
    "candidateSha",
    "schemaVersion",
    "target",
    "workflowRunAttempt",
    "workflowRunId",
  ];
  if (request.schemaVersion === 1) {
    requireFields(request, "dispatch request", baseFields, [], "1.0.0");
  } else if (request.schemaVersion === 2) {
    requireFields(request, "dispatch request", [...baseFields, "managedImageRevision"]);
  } else {
    throw new Error("dispatch request schemaVersion must be 1 or 2");
  }
  if (request.target !== JETSON_DISPATCH_TARGET) {
    throw new Error(`dispatch target must be ${JETSON_DISPATCH_TARGET}`);
  }
  if (typeof request.candidateSha !== "string" || !SHA_PATTERN.test(request.candidateSha)) {
    throw new Error("candidateSha must be a lowercase 40-character commit SHA");
  }
  const shared = {
    target: JETSON_DISPATCH_TARGET,
    candidateSha: request.candidateSha,
    workflowRunId: positiveIntegerString(request.workflowRunId, "workflowRunId"),
    workflowRunAttempt: positiveInteger(request.workflowRunAttempt, "workflowRunAttempt"),
  } as const;
  if (request.schemaVersion === 1) return { schemaVersion: 1, ...shared };
  if (
    typeof request.managedImageRevision !== "string" ||
    !SHA_PATTERN.test(request.managedImageRevision)
  ) {
    throw new Error("managedImageRevision must be a lowercase 40-character commit SHA");
  }
  return {
    schemaVersion: 2,
    ...shared,
    managedImageRevision: request.managedImageRevision,
  };
}

function expectedJobId(request: JetsonDispatchRequest): string {
  const managedImageRevision =
    request.schemaVersion === 2 ? `:${request.managedImageRevision}` : "";
  return createHash("sha256")
    .update(
      `${request.schemaVersion}:${request.target}:${request.candidateSha}${managedImageRevision}:${request.workflowRunId}:${request.workflowRunAttempt}`,
      "utf8",
    )
    .digest("hex");
}

function parseTimestamp(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return value;
}

function parseDeviceIdentity(value: unknown): JetsonDeviceIdentity {
  const device = record(value, "Jetson device identity");
  requireFields(device, "Jetson device identity", [
    "jetpackVersion",
    "jetsonLinuxRelease",
    "kernel",
    "model",
  ]);
  for (const field of ["jetpackVersion", "jetsonLinuxRelease", "kernel", "model"]) {
    const entry = device[field];
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_DEVICE_IDENTITY_CHARACTERS ||
      /[\u0000-\u001f\u007f]/u.test(entry)
    ) {
      throw new Error(`Jetson device ${field} is invalid`);
    }
  }
  return {
    model: device.model as string,
    jetpackVersion: device.jetpackVersion as string,
    jetsonLinuxRelease: device.jetsonLinuxRelease as string,
    kernel: device.kernel as string,
  };
}

export function parseJetsonDispatchStatus(value: unknown): JetsonDispatchStatus {
  const status = record(value, "Jetson dispatch status");
  const baseFields = ["cleanup", "createdAt", "jobId", "request", "schemaVersion", "state"];
  const request = parseJetsonDispatchRequest(status.request);
  if (
    status.schemaVersion !== request.schemaVersion ||
    typeof status.jobId !== "string" ||
    !JOB_ID_PATTERN.test(status.jobId) ||
    status.jobId !== expectedJobId(request)
  ) {
    throw new Error("Jetson dispatch status does not match its request and job ID");
  }
  const createdAt = parseTimestamp(status.createdAt, "createdAt");
  if (status.state === "queued") {
    requireFields(
      status,
      "queued Jetson dispatch status",
      baseFields,
      [],
      request.schemaVersion === 1 ? "1.0.0" : JETSON_DISPATCH_CONTRACT_VERSION,
    );
    if (status.cleanup !== "pending") {
      throw new Error("queued Jetson dispatch cleanup must be pending");
    }
    return {
      schemaVersion: request.schemaVersion,
      jobId: status.jobId,
      request,
      state: "queued",
      createdAt,
      cleanup: "pending",
    };
  }
  if (status.state === "running") {
    requireFields(
      status,
      "running Jetson dispatch status",
      [...baseFields, "startedAt"],
      [],
      request.schemaVersion === 1 ? "1.0.0" : JETSON_DISPATCH_CONTRACT_VERSION,
    );
    const startedAt = parseTimestamp(status.startedAt, "startedAt");
    if (status.cleanup !== "pending" || startedAt < createdAt) {
      throw new Error("running Jetson dispatch status is invalid");
    }
    return {
      schemaVersion: request.schemaVersion,
      jobId: status.jobId,
      request,
      state: "running",
      createdAt,
      startedAt,
      cleanup: "pending",
    };
  }
  if (status.state !== "completed") {
    throw new Error("Jetson dispatch status state is invalid");
  }
  requireFields(
    status,
    "completed Jetson dispatch status",
    [...baseFields, "completedAt", "conclusion", "startedAt"],
    ["device", "error"],
    request.schemaVersion === 1 ? "1.0.0" : JETSON_DISPATCH_CONTRACT_VERSION,
  );
  if (
    typeof status.conclusion !== "string" ||
    !DISPATCH_CONCLUSIONS.includes(status.conclusion) ||
    typeof status.cleanup !== "string" ||
    !COMPLETED_CLEANUP_STATES.includes(status.cleanup) ||
    (status.cleanup === "failed" && status.conclusion !== "cleanup-failed")
  ) {
    throw new Error("completed Jetson dispatch result is invalid");
  }
  const startedAt = parseTimestamp(status.startedAt, "startedAt");
  const completedAt = parseTimestamp(status.completedAt, "completedAt");
  if (startedAt < createdAt || completedAt < startedAt) {
    throw new Error("completed Jetson dispatch timestamps are invalid");
  }
  if (
    status.error !== undefined &&
    (typeof status.error !== "string" ||
      status.error.length === 0 ||
      status.error.length > MAX_ERROR_CHARACTERS ||
      /[\u0000-\u001f\u007f]/u.test(status.error))
  ) {
    throw new Error("completed Jetson dispatch error is invalid");
  }
  const device = status.device === undefined ? undefined : parseDeviceIdentity(status.device);
  if (status.conclusion === "success" && device === undefined) {
    throw new Error("successful Jetson dispatch must include device identity");
  }
  return {
    schemaVersion: request.schemaVersion,
    jobId: status.jobId,
    request,
    state: "completed",
    conclusion: status.conclusion as JetsonDispatchConclusion,
    createdAt,
    startedAt,
    completedAt,
    ...(device === undefined ? {} : { device }),
    cleanup: status.cleanup as "failed" | "succeeded",
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

export function parseJetsonDispatchStatusResponse(
  value: unknown,
  expectedRequest?: JetsonDispatchRequest,
): JetsonDispatchStatus {
  const response = record(value, "Jetson dispatcher response");
  requireFields(response, "Jetson dispatcher response", ["job"]);
  const status = parseJetsonDispatchStatus(response.job);
  if (expectedRequest !== undefined && status.jobId !== expectedJobId(expectedRequest)) {
    throw new Error("Jetson dispatcher response does not match the submitted request");
  }
  return status;
}

export function decodeJetsonArtifactArchive(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_JETSON_ARTIFACT_ARCHIVE_BASE64_CHARACTERS ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error("Jetson artifact archive must be bounded canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > MAX_JETSON_ARTIFACT_ARCHIVE_BYTES || decoded.toString("base64") !== value) {
    throw new Error("Jetson artifact archive must be bounded canonical base64");
  }
  return decoded;
}

export function parseJetsonDispatchArtifact(
  value: unknown,
  expectedArtifactJobId: string,
): JetsonDispatchArtifact {
  const artifact = record(value, "Jetson dispatch artifact");
  const status = parseJetsonDispatchStatus(artifact.status);
  requireFields(
    artifact,
    "Jetson dispatch artifact",
    ["log", "status"],
    ["artifactArchiveBase64"],
    status.schemaVersion === 1 ? "1.0.0" : JETSON_DISPATCH_CONTRACT_VERSION,
  );
  if (status.jobId !== expectedArtifactJobId || status.state !== "completed") {
    throw new Error("Jetson dispatch artifact does not match its completed job");
  }
  if (
    typeof artifact.log !== "string" ||
    Buffer.byteLength(artifact.log) > MAX_JETSON_DISPATCH_LOG_BYTES
  ) {
    throw new Error("Jetson dispatch artifact log is invalid");
  }
  if (artifact.artifactArchiveBase64 !== undefined) {
    decodeJetsonArtifactArchive(artifact.artifactArchiveBase64);
  }
  if (status.conclusion === "success" && artifact.artifactArchiveBase64 === undefined) {
    throw new Error("successful Jetson dispatch must include its artifact archive");
  }
  return {
    status,
    log: artifact.log,
    ...(artifact.artifactArchiveBase64 === undefined
      ? {}
      : { artifactArchiveBase64: artifact.artifactArchiveBase64 as string }),
  };
}
