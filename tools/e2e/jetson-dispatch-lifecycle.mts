// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GitHubOidcIdentity, JetsonDispatchRequest } from "./jetson-dispatch-contract.mts";
import {
  createPrivateRegularFile,
  readPrivateRegularFile,
  writePrivateRegularFile,
} from "./private-file.mts";

const MAX_LOG_BYTES = 4 * 1024 * 1024;

export type JetsonDispatchConclusion =
  | "cancelled"
  | "failure"
  | "reset-failed"
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
}

export interface JetsonDispatchWorker {
  run(
    request: JetsonDispatchRequest,
    options: { jobId: string; signal: AbortSignal },
  ): Promise<JetsonWorkerResult>;
  reset(options: { signal: AbortSignal }): Promise<void>;
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
  reset: "pending" | "succeeded" | "failed";
  error?: string;
}

export interface JetsonDispatchArtifact {
  status: JetsonDispatchStatus;
  log: string;
}

export class JetsonDispatchBusyError extends Error {}

export class JetsonDispatchNotFoundError extends Error {}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Jetson dispatch failed";
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
}

function workerErrorLog(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("log" in error)) return undefined;
  const log = (error as { log?: unknown }).log;
  if (typeof log !== "string" || Buffer.byteLength(log) > MAX_LOG_BYTES) return undefined;
  return log;
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

function dispatchJobId(request: JetsonDispatchRequest): string {
  return createHash("sha256")
    .update(
      `${request.schemaVersion}:${request.target}:${request.candidateSha}:${request.workflowRunId}:${request.workflowRunAttempt}`,
      "utf8",
    )
    .digest("hex");
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
  readonly #resetTimeoutMs: number;
  readonly #jobs = new Map<string, JetsonDispatchStatus>();
  #activeJobId: string | undefined;
  #activeAbort: AbortController | undefined;
  #activeRun: Promise<void> | undefined;
  #cancelRequested = false;
  #initialized = false;

  constructor(options: {
    stateDirectory: string;
    worker: JetsonDispatchWorker;
    executionTimeoutMs: number;
    resetTimeoutMs: number;
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
      !Number.isSafeInteger(options.resetTimeoutMs) ||
      options.resetTimeoutMs < 10_000 ||
      options.resetTimeoutMs > 10 * 60_000
    ) {
      throw new Error("Jetson reset timeout must be between 10 seconds and 10 minutes");
    }
    this.#stateDirectory = options.stateDirectory;
    this.#lockPath = path.join(options.stateDirectory, "device.lock");
    this.#worker = options.worker;
    this.#executionTimeoutMs = options.executionTimeoutMs;
    this.#resetTimeoutMs = options.resetTimeoutMs;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    ensurePrivateDirectory(this.#stateDirectory);
    const staleLock = readPrivateRegularFile(this.#lockPath, {
      allowMissing: true,
      maxBytes: 1024,
    });
    if (staleLock !== null) {
      await withTimeout(this.#resetTimeoutMs, (signal) => this.#worker.reset({ signal }));
      fs.unlinkSync(this.#lockPath);
    }
    this.#initialized = true;
  }

  dispatch(request: JetsonDispatchRequest, identity: GitHubOidcIdentity): JetsonDispatchStatus {
    this.#requireInitialized();
    if (
      identity.runId !== request.workflowRunId ||
      identity.runAttempt !== request.workflowRunAttempt
    ) {
      throw new Error("dispatch identity does not match the workflow run");
    }
    const jobId = dispatchJobId(request);
    const existing = this.#jobs.get(jobId);
    if (existing) return structuredClone(existing);
    if (this.#activeJobId) {
      throw new JetsonDispatchBusyError("Jetson device is already running another job");
    }

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
      reset: "pending",
    };
    try {
      this.#persist(status);
    } catch (error) {
      fs.unlinkSync(this.#lockPath);
      throw error;
    }
    this.#jobs.set(jobId, status);
    this.#activeJobId = jobId;
    this.#activeRun = this.#run(status);
    return structuredClone(status);
  }

  status(jobId: string): JetsonDispatchStatus {
    this.#requireInitialized();
    const status = this.#jobs.get(jobId);
    if (!status) throw new JetsonDispatchNotFoundError("Jetson dispatch job was not found");
    return structuredClone(status);
  }

  request(jobId: string): JetsonDispatchRequest {
    return this.status(jobId).request;
  }

  cancel(jobId: string): JetsonDispatchStatus {
    const status = this.#jobs.get(jobId);
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
    if (
      readPrivateRegularFile(this.#lockPath, {
        allowMissing: true,
        maxBytes: 1024,
      }) !== null
    ) {
      throw new Error("Jetson device lock still requires reset recovery");
    }
  }

  artifact(jobId: string): JetsonDispatchArtifact {
    const status = this.status(jobId);
    if (status.state !== "completed")
      throw new JetsonDispatchBusyError("Jetson job is not complete");
    const log = readPrivateRegularFile(this.#logPath(jobId), { maxBytes: MAX_LOG_BYTES }) ?? "";
    return { status, log };
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
      if (Buffer.byteLength(result.log) > MAX_LOG_BYTES) {
        throw new Error(`Jetson log exceeds ${MAX_LOG_BYTES} bytes`);
      }
      writePrivateRegularFile(this.#logPath(status.jobId), result.log);
      status.device = result.device;
      conclusion = "success";
    } catch (error) {
      status.error = safeError(error);
      conclusion = timedOut ? "timed-out" : this.#cancelRequested ? "cancelled" : "failure";
      try {
        writePrivateRegularFile(this.#logPath(status.jobId), workerErrorLog(error) ?? "");
      } catch (logError) {
        status.error = `${status.error}; log persistence failed: ${safeError(logError)}`.slice(
          0,
          500,
        );
      }
    } finally {
      clearTimeout(timer);
      try {
        await withTimeout(this.#resetTimeoutMs, (signal) => this.#worker.reset({ signal }));
        status.reset = "succeeded";
        fs.unlinkSync(this.#lockPath);
      } catch (error) {
        status.reset = "failed";
        status.error = `Jetson reset failed: ${safeError(error)}`;
        conclusion = "reset-failed";
      }
      status.conclusion = conclusion;
      status.state = "completed";
      status.completedAt = new Date().toISOString();
      try {
        this.#persist(status);
      } catch (error) {
        status.error = `Final status persistence failed: ${safeError(error)}`;
        status.conclusion = "failure";
      } finally {
        this.#activeAbort = undefined;
        this.#activeRun = undefined;
        this.#activeJobId = undefined;
        this.#cancelRequested = false;
      }
    }
  }

  #persist(status: JetsonDispatchStatus): void {
    writePrivateRegularFile(this.#statusPath(status.jobId), `${JSON.stringify(status, null, 2)}\n`);
  }

  #statusPath(jobId: string): string {
    return path.join(this.#stateDirectory, `${jobId}.json`);
  }

  #logPath(jobId: string): string {
    return path.join(this.#stateDirectory, `${jobId}.log`);
  }

  #requireInitialized(): void {
    if (!this.#initialized) throw new Error("Jetson dispatcher is not initialized");
  }
}
