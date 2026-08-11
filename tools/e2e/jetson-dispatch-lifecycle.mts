// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type GitHubOidcIdentity,
  type JetsonDispatchRequest,
  parseJetsonDispatchRequest,
} from "./jetson-dispatch-contract.mts";
import {
  createPrivateRegularFile,
  readPrivateRegularFile,
  writePrivateRegularFile,
} from "./private-file.mts";

export const MAX_JETSON_DISPATCH_LOG_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_JOB_STATUSES = 128;
const MAX_JETSON_DISPATCH_STATUS_BYTES = 16 * 1024;
const JOB_ID_PATTERN = /^[a-f0-9]{64}$/u;
const STATUS_FILE_PATTERN = /^([a-f0-9]{64})\.json$/u;
export const MAX_JETSON_ARTIFACT_ARCHIVE_BYTES = 1024 * 1024;
const MAX_JETSON_ARTIFACT_ARCHIVE_BASE64_CHARACTERS =
  Math.ceil(MAX_JETSON_ARTIFACT_ARCHIVE_BYTES / 3) * 4;
const MAX_JETSON_DISPATCH_ARTIFACT_JSON_OVERHEAD_BYTES = 256 * 1024;
export const MAX_JETSON_DISPATCH_ARTIFACT_RESPONSE_BYTES =
  MAX_JETSON_DISPATCH_LOG_BYTES * 6 +
  MAX_JETSON_ARTIFACT_ARCHIVE_BASE64_CHARACTERS +
  MAX_JETSON_DISPATCH_ARTIFACT_JSON_OVERHEAD_BYTES;

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

export interface JetsonWorkerResult {
  device: JetsonDeviceIdentity;
  log: string;
  artifactArchiveBase64?: string;
}

export interface JetsonDispatchWorker {
  run(
    request: JetsonDispatchRequest,
    options: { jobId: string; signal: AbortSignal },
  ): Promise<JetsonWorkerResult>;
  cleanup(options: { jobId: string; signal: AbortSignal }): Promise<void>;
}

export interface JetsonDispatchStatus {
  schemaVersion: 1;
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

export class JetsonDispatchBusyError extends Error {}

export class JetsonDispatchNotFoundError extends Error {}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Jetson dispatch failed";
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
}

function appendBoundedError(previous: string | undefined, newest: string): string {
  const latest = newest.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
  if (!previous) return latest;
  const separator = "; ";
  const available = 500 - separator.length - latest.length;
  if (available <= 0) return latest;
  const earlier = previous.replace(/[\u0000-\u001f\u007f]/gu, " ");
  const boundedEarlier =
    earlier.length <= available
      ? earlier
      : available > 3
        ? `${earlier.slice(0, available - 3)}...`
        : earlier.slice(0, available);
  return `${boundedEarlier}${separator}${latest}`;
}

function workerErrorLog(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("log" in error)) return undefined;
  const log = (error as { log?: unknown }).log;
  if (typeof log !== "string" || Buffer.byteLength(log) > MAX_JETSON_DISPATCH_LOG_BYTES) {
    return undefined;
  }
  return log;
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

function workerErrorArtifactArchive(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("artifactArchiveBase64" in error)) {
    return undefined;
  }
  const value = (error as { artifactArchiveBase64?: unknown }).artifactArchiveBase64;
  try {
    decodeJetsonArtifactArchive(value);
    return value as string;
  } catch {
    return undefined;
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${directory} must be a private directory`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`${directory} must be owned by the dispatcher user`);
  }
  fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fs.fstatSync(descriptor).isDirectory()) {
      throw new Error(`${directory} must be a directory`);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function dispatchJobId(request: JetsonDispatchRequest): string {
  return createHash("sha256")
    .update(
      `${request.schemaVersion}:${request.target}:${request.candidateSha}:${request.workflowRunId}:${request.workflowRunAttempt}`,
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

function parseDeviceIdentity(value: unknown): JetsonDeviceIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("device must be an object");
  }
  const device = value as Record<string, unknown>;
  const fields = ["jetpackVersion", "jetsonLinuxRelease", "kernel", "model"];
  if (fields.some((field) => typeof device[field] !== "string")) {
    throw new Error("device fields are invalid");
  }
  return {
    model: device.model as string,
    jetpackVersion: device.jetpackVersion as string,
    jetsonLinuxRelease: device.jetsonLinuxRelease as string,
    kernel: device.kernel as string,
  };
}

function parsePersistedStatus(contents: string, expectedJobId: string): JetsonDispatchStatus {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("persisted Jetson dispatch status is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted Jetson dispatch status must be an object");
  }
  const status = value as Record<string, unknown>;
  const request = parseJetsonDispatchRequest(status.request);
  if (
    status.schemaVersion !== 1 ||
    status.jobId !== expectedJobId ||
    dispatchJobId(request) !== expectedJobId
  ) {
    throw new Error("persisted Jetson dispatch status does not match its job ID");
  }
  const createdAt = parseTimestamp(status.createdAt, "createdAt");
  if (status.state === "queued" || status.state === "running") {
    if (status.cleanup !== "pending") {
      throw new Error("persisted incomplete Jetson dispatch cleanup is invalid");
    }
    return {
      schemaVersion: 1,
      jobId: expectedJobId,
      request,
      state: status.state,
      createdAt,
      ...(status.state === "running"
        ? { startedAt: parseTimestamp(status.startedAt, "startedAt") }
        : {}),
      cleanup: "pending",
    };
  }
  if (status.state !== "completed") {
    throw new Error("persisted Jetson dispatch status has an invalid state");
  }
  if (
    !["cancelled", "cleanup-failed", "failure", "success", "timed-out"].includes(
      status.conclusion as string,
    ) ||
    !["failed", "succeeded"].includes(status.cleanup as string) ||
    (status.error !== undefined && typeof status.error !== "string")
  ) {
    throw new Error("persisted Jetson dispatch result fields are invalid");
  }
  const startedAt = parseTimestamp(status.startedAt, "startedAt");
  const completedAt = parseTimestamp(status.completedAt, "completedAt");
  const device = parseDeviceIdentity(status.device);
  return {
    schemaVersion: 1,
    jobId: expectedJobId,
    request,
    state: "completed",
    conclusion: status.conclusion as JetsonDispatchConclusion,
    createdAt,
    startedAt,
    completedAt,
    ...(device === undefined ? {} : { device }),
    cleanup: status.cleanup as "failed" | "succeeded",
    ...(status.error === undefined ? {} : { error: status.error as string }),
  };
}

function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("operation timed out")), timeoutMs);
  timer.unref();
  return operation(controller.signal).finally(() => clearTimeout(timer));
}

export class JetsonDispatchCoordinator {
  readonly #stateDirectory: string;
  readonly #lockPath: string;
  readonly #worker: JetsonDispatchWorker;
  readonly #executionTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #jobs = new Map<string, JetsonDispatchStatus>();
  #activeJobId: string | undefined;
  #activeAbort: AbortController | undefined;
  #activeRun: Promise<void> | undefined;
  #cancelRequested = false;
  #initialized = false;
  #lockRecoveryRequired = false;

  constructor(options: {
    stateDirectory: string;
    worker: JetsonDispatchWorker;
    executionTimeoutMs: number;
    cleanupTimeoutMs: number;
  }) {
    if (!path.isAbsolute(options.stateDirectory)) {
      throw new Error("Jetson dispatcher state directory must be absolute");
    }
    if (
      !Number.isSafeInteger(options.executionTimeoutMs) ||
      options.executionTimeoutMs < 60_000 ||
      options.executionTimeoutMs > 55 * 60_000
    ) {
      throw new Error("Jetson execution timeout must be between 1 and 55 minutes");
    }
    if (
      !Number.isSafeInteger(options.cleanupTimeoutMs) ||
      options.cleanupTimeoutMs < 10_000 ||
      options.cleanupTimeoutMs > 10 * 60_000
    ) {
      throw new Error("Jetson cleanup timeout must be between 10 seconds and 10 minutes");
    }
    this.#stateDirectory = options.stateDirectory;
    this.#lockPath = path.join(options.stateDirectory, "device.lock");
    this.#worker = options.worker;
    this.#executionTimeoutMs = options.executionTimeoutMs;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    ensurePrivateDirectory(this.#stateDirectory);
    const staleLock = readPrivateRegularFile(this.#lockPath, {
      allowMissing: true,
      maxBytes: 1024,
    });
    if (staleLock !== null) {
      if (!/^[a-f0-9]{64}\n?$/u.test(staleLock)) {
        throw new Error("Jetson device lock contains an invalid job ID");
      }
      const jobId = staleLock.endsWith("\n") ? staleLock.slice(0, -1) : staleLock;
      await withTimeout(this.#cleanupTimeoutMs, (signal) =>
        this.#worker.cleanup({ jobId, signal }),
      );
      const recoveredStatus = this.#readStatus(jobId);
      if (recoveredStatus && recoveredStatus.state !== "completed") {
        recoveredStatus.state = "completed";
        recoveredStatus.conclusion = "failure";
        recoveredStatus.startedAt ??= recoveredStatus.createdAt;
        recoveredStatus.completedAt = new Date().toISOString();
        recoveredStatus.cleanup = "succeeded";
        recoveredStatus.error = "Jetson dispatcher restarted before terminal status was persisted";
        this.#persist(recoveredStatus);
      }
      this.#removeDeviceLock(jobId);
    }
    this.#restoreCompletedStatuses();
    this.#initialized = true;
  }

  dispatch(request: JetsonDispatchRequest, identity: GitHubOidcIdentity): JetsonDispatchStatus {
    this.#requireInitialized();
    if (this.#lockRecoveryRequired) {
      throw new JetsonDispatchBusyError("Jetson device lock requires recovery");
    }
    if (
      identity.runId !== request.workflowRunId ||
      identity.runAttempt !== request.workflowRunAttempt
    ) {
      throw new Error("dispatch identity does not match the workflow run");
    }
    const jobId = dispatchJobId(request);
    const existing = this.#findStatus(jobId);
    if (existing) return structuredClone(existing);
    if (this.#activeJobId) {
      throw new JetsonDispatchBusyError("Jetson device is already running another job");
    }
    this.#evictOldestCompletedJob();

    try {
      createPrivateRegularFile(this.#lockPath, `${jobId}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new JetsonDispatchBusyError("Jetson device lock requires recovery");
      }
      throw error;
    }
    const status: JetsonDispatchStatus = {
      schemaVersion: 1,
      jobId,
      request: structuredClone(request),
      state: "queued",
      createdAt: new Date().toISOString(),
      cleanup: "pending",
    };
    this.#clearPriorResultFiles(jobId);
    this.#persist(status);
    fsyncDirectory(this.#stateDirectory);
    this.#jobs.set(jobId, status);
    this.#activeJobId = jobId;
    this.#activeRun = this.#run(status);
    return structuredClone(status);
  }

  status(jobId: string): JetsonDispatchStatus {
    this.#requireInitialized();
    const status = this.#findStatus(jobId);
    if (!status) throw new JetsonDispatchNotFoundError("Jetson dispatch job was not found");
    return structuredClone(status);
  }

  request(jobId: string): JetsonDispatchRequest {
    return this.status(jobId).request;
  }

  cancel(jobId: string): JetsonDispatchStatus {
    this.#requireInitialized();
    const status = this.#findStatus(jobId);
    if (!status) throw new JetsonDispatchNotFoundError("Jetson dispatch job was not found");
    if (status.state !== "completed" && this.#activeJobId === jobId) {
      this.#cancelRequested = true;
      this.#activeAbort?.abort(new Error("dispatch cancelled"));
    }
    return structuredClone(status);
  }

  async shutdown(): Promise<void> {
    if (this.#activeJobId) this.cancel(this.#activeJobId);
    await this.#activeRun;
    if (this.#lockRecoveryRequired) {
      throw new Error("Jetson device lock state requires operator recovery");
    }
    if (
      readPrivateRegularFile(this.#lockPath, {
        allowMissing: true,
        maxBytes: 1024,
      }) !== null
    ) {
      throw new Error("Jetson device lock still requires cleanup recovery");
    }
  }

  artifact(jobId: string): JetsonDispatchArtifact {
    const status = this.status(jobId);
    if (status.state !== "completed")
      throw new JetsonDispatchBusyError("Jetson job is not complete");
    const log =
      readPrivateRegularFile(this.#logPath(jobId), {
        allowMissing: true,
        maxBytes: MAX_JETSON_DISPATCH_LOG_BYTES,
      }) ?? "";
    const artifactArchiveBase64 = readPrivateRegularFile(this.#artifactPath(jobId), {
      allowMissing: true,
      maxBytes: MAX_JETSON_ARTIFACT_ARCHIVE_BASE64_CHARACTERS,
    });
    if (artifactArchiveBase64 !== null) decodeJetsonArtifactArchive(artifactArchiveBase64);
    return {
      status,
      log,
      ...(artifactArchiveBase64 === null ? {} : { artifactArchiveBase64 }),
    };
  }

  async #run(status: JetsonDispatchStatus): Promise<void> {
    const controller = new AbortController();
    this.#activeAbort = controller;
    this.#cancelRequested = false;
    let timedOut = false;
    let conclusion: JetsonDispatchConclusion = "failure";
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Jetson execution timed out"));
    }, this.#executionTimeoutMs);
    timer.unref();

    try {
      status.state = "running";
      status.startedAt = new Date().toISOString();
      this.#persist(status);
      const result = await this.#worker.run(status.request, {
        jobId: status.jobId,
        signal: controller.signal,
      });
      if (Buffer.byteLength(result.log) > MAX_JETSON_DISPATCH_LOG_BYTES) {
        throw new Error(`Jetson log exceeds ${MAX_JETSON_DISPATCH_LOG_BYTES} bytes`);
      }
      writePrivateRegularFile(this.#logPath(status.jobId), result.log);
      if (result.artifactArchiveBase64 !== undefined) {
        decodeJetsonArtifactArchive(result.artifactArchiveBase64);
        writePrivateRegularFile(this.#artifactPath(status.jobId), result.artifactArchiveBase64);
      }
      status.device = result.device;
      conclusion = "success";
    } catch (error) {
      status.error = safeError(error);
      conclusion = timedOut ? "timed-out" : this.#cancelRequested ? "cancelled" : "failure";
      try {
        writePrivateRegularFile(this.#logPath(status.jobId), workerErrorLog(error) ?? "");
        const artifactArchiveBase64 = workerErrorArtifactArchive(error);
        if (artifactArchiveBase64 !== undefined) {
          writePrivateRegularFile(this.#artifactPath(status.jobId), artifactArchiveBase64);
        }
      } catch (resultError) {
        status.error = appendBoundedError(
          status.error,
          `Result persistence failed: ${safeError(resultError)}`,
        );
      }
    } finally {
      clearTimeout(timer);
      try {
        await withTimeout(this.#cleanupTimeoutMs, (signal) =>
          this.#worker.cleanup({ jobId: status.jobId, signal }),
        );
        status.cleanup = "succeeded";
      } catch (error) {
        status.cleanup = "failed";
        const cleanupError = `Jetson cleanup failed: ${safeError(error)}`;
        status.error = appendBoundedError(status.error, cleanupError);
        conclusion = "cleanup-failed";
      }
      status.conclusion = conclusion;
      status.state = "completed";
      status.completedAt = new Date().toISOString();
      let terminalStatusPersisted = false;
      try {
        this.#persist(status);
        terminalStatusPersisted = true;
      } catch (error) {
        const persistenceError = `Final status persistence failed: ${safeError(error)}`;
        status.error = appendBoundedError(status.error, persistenceError);
        if (status.conclusion !== "cleanup-failed") status.conclusion = "failure";
      }
      if (status.cleanup === "succeeded" && terminalStatusPersisted) {
        try {
          this.#removeDeviceLock(status.jobId);
        } catch (error) {
          const lockError = `Jetson lock removal failed: ${safeError(error)}`;
          status.error = appendBoundedError(status.error, lockError);
          status.conclusion = "cleanup-failed";
          try {
            this.#persist(status);
          } catch (persistError) {
            const persistenceError = `Lock failure persistence failed: ${safeError(persistError)}`;
            status.error = appendBoundedError(status.error, persistenceError);
          }
        }
      }
      this.#activeAbort = undefined;
      this.#activeRun = undefined;
      this.#activeJobId = undefined;
      this.#cancelRequested = false;
    }
  }

  #persist(status: JetsonDispatchStatus): void {
    writePrivateRegularFile(this.#statusPath(status.jobId), `${JSON.stringify(status, null, 2)}\n`);
  }

  #removeDeviceLock(jobId: string): void {
    fs.unlinkSync(this.#lockPath);
    try {
      fsyncDirectory(this.#stateDirectory);
    } catch (error) {
      try {
        this.#restoreDeviceLock(jobId);
      } catch (restoreError) {
        this.#lockRecoveryRequired = true;
        throw new Error(
          `Jetson lock directory persistence failed: ${safeError(error)}; lock restoration failed: ${safeError(restoreError)}`,
        );
      }
      throw error;
    }
  }

  #restoreDeviceLock(jobId: string): void {
    try {
      createPrivateRegularFile(this.#lockPath, `${jobId}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readPrivateRegularFile(this.#lockPath, { maxBytes: 1024 });
      if (existing !== `${jobId}\n`) {
        throw new Error("Jetson device lock changed while durability was restored");
      }
    }
    fsyncDirectory(this.#stateDirectory);
  }

  #statusPath(jobId: string): string {
    return path.join(this.#stateDirectory, `${jobId}.json`);
  }

  #logPath(jobId: string): string {
    return path.join(this.#stateDirectory, `${jobId}.log`);
  }

  #artifactPath(jobId: string): string {
    return path.join(this.#stateDirectory, `${jobId}.artifacts.tar.gz.b64`);
  }

  #clearPriorResultFiles(jobId: string): void {
    fs.rmSync(this.#logPath(jobId), { force: true });
    fs.rmSync(this.#artifactPath(jobId), { force: true });
  }

  #findStatus(jobId: string): JetsonDispatchStatus | undefined {
    const existing = this.#jobs.get(jobId);
    if (existing || !JOB_ID_PATTERN.test(jobId)) return existing;
    const restored = this.#readStatus(jobId);
    if (restored?.state === "completed") {
      this.#evictOldestCompletedJob();
      this.#jobs.set(jobId, restored);
    }
    return restored?.state === "completed" ? restored : undefined;
  }

  #readStatus(jobId: string): JetsonDispatchStatus | null {
    try {
      const contents = readPrivateRegularFile(this.#statusPath(jobId), {
        allowMissing: true,
        maxBytes: MAX_JETSON_DISPATCH_STATUS_BYTES,
      });
      return contents === null ? null : parsePersistedStatus(contents, jobId);
    } catch (error) {
      throw new Error(`Jetson dispatch status ${jobId}.json is invalid: ${safeError(error)}`);
    }
  }

  #restoreCompletedStatuses(): void {
    const completed = fs
      .readdirSync(this.#stateDirectory)
      .flatMap((name) => {
        const match = STATUS_FILE_PATTERN.exec(name);
        if (!match) return [];
        const status = this.#readStatus(match[1]!);
        return status?.state === "completed" ? [status] : [];
      })
      .sort((left, right) => left.completedAt!.localeCompare(right.completedAt!))
      .slice(-MAX_RETAINED_JOB_STATUSES);
    for (const status of completed) this.#jobs.set(status.jobId, status);
  }

  #evictOldestCompletedJob(): void {
    if (this.#jobs.size < MAX_RETAINED_JOB_STATUSES) return;
    for (const [jobId, status] of this.#jobs) {
      if (status.state === "completed") {
        this.#jobs.delete(jobId);
        return;
      }
    }
  }

  #requireInitialized(): void {
    if (!this.#initialized) throw new Error("Jetson dispatcher is not initialized");
  }
}
