// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { isolatedExecutableEnvironment, snapshotBoundedExecutable } from "../cua/bounded-file";
import {
  CUA_LIFECYCLE_SCHEMA_VERSION,
  type CuaAppliedPolicyIdentity,
  type CuaFailure,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
} from "../cua/contract";
import { parseCuaLifecycleRecord } from "../cua/schema";

export interface CuaSecurityAdapterRequest {
  schemaVersion: typeof CUA_LIFECYCLE_SCHEMA_VERSION;
  kind: "security-adapter-request";
  operation: "security.verify";
  sandboxName: string;
  appliedPolicy: CuaAppliedPolicyIdentity;
  runtime: CuaRuntimeReadiness;
  target: CuaTargetAttachment;
}

export type CuaSecurityAdapterResult = CuaSecurityAttestation | CuaFailure;

export interface CuaSecurityAdapter {
  readonly executableDigest?: string | null;
  execute(request: CuaSecurityAdapterRequest): CuaSecurityAdapterResult;
}

export class CuaSecurityAdapterInvocationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CuaSecurityAdapterInvocationError";
  }
}

export interface ProcessCuaSecurityAdapterOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  expectedDigest?: string;
  qualificationArtifactRunner?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_VERIFIER_BYTES = 64 * 1024 * 1024;

function parseAdapterResult(
  stdout: string,
  processStatus: number | null,
): CuaSecurityAdapterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CuaSecurityAdapterInvocationError(
      "the CUA security adapter returned invalid JSON",
      false,
    );
  }
  let record;
  try {
    record = parseCuaLifecycleRecord(parsed);
  } catch {
    throw new CuaSecurityAdapterInvocationError(
      "the CUA security adapter returned an invalid lifecycle record",
      false,
    );
  }
  if (record.kind !== "security-attestation" && record.kind !== "failure") {
    throw new CuaSecurityAdapterInvocationError(
      "the CUA security adapter returned an unsupported record",
      false,
    );
  }
  if (record.kind === "failure") {
    if (record.operation !== "security.verify" || record.family !== "policy_invalid") {
      throw new CuaSecurityAdapterInvocationError(
        "the CUA security adapter returned an invalid failure",
        false,
      );
    }
    return record;
  }
  if (processStatus !== 0) {
    throw new CuaSecurityAdapterInvocationError(
      "the CUA security adapter exited unsuccessfully without a failure record",
      true,
    );
  }
  return record;
}

/**
 * Invoke the trusted host-side CUA security verifier without a shell.
 *
 * The verifier owns private endpoint and authority inspection. NemoClaw sends
 * the sandbox name plus public runtime-readiness and target-attachment records;
 * it sends no private verifier authority and accepts only a content-free
 * attestation.
 */
export class ProcessCuaSecurityAdapter implements CuaSecurityAdapter {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly expectedDigest: string | undefined;
  readonly qualificationArtifactRunner: string | undefined;
  #executableDigest: string | null = null;

  get executableDigest(): string | null {
    return this.#executableDigest;
  }

  constructor(
    readonly executable: string,
    options: ProcessCuaSecurityAdapterOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.expectedDigest = options.expectedDigest;
    this.qualificationArtifactRunner = options.qualificationArtifactRunner;
  }

  execute(request: CuaSecurityAdapterRequest): CuaSecurityAdapterResult {
    if (!path.isAbsolute(this.executable)) {
      throw new CuaSecurityAdapterInvocationError(
        "the CUA security adapter path must be absolute",
        false,
      );
    }
    if (
      this.qualificationArtifactRunner !== undefined &&
      !path.isAbsolute(this.qualificationArtifactRunner)
    ) {
      throw new CuaSecurityAdapterInvocationError(
        "the CUA qualification artifact runner path must be absolute",
        false,
      );
    }
    let snapshot;
    try {
      snapshot = snapshotBoundedExecutable(this.executable, {
        label: "the CUA security adapter",
        minBytes: 1,
        maxBytes: MAX_VERIFIER_BYTES,
        temporaryDirectoryPrefix: "nemoclaw-cua-security-verifier-",
        expectedDigest: this.expectedDigest ?? request.runtime.components.securityVerifier.digest,
      });
    } catch (error) {
      this.#executableDigest = null;
      const digestMismatch =
        error instanceof Error && error.message.endsWith("does not match its expected digest");
      throw new CuaSecurityAdapterInvocationError(
        digestMismatch
          ? "the CUA security adapter does not match runtime readiness"
          : "the CUA security adapter is unavailable",
        false,
      );
    }
    this.#executableDigest = snapshot.executableDigest;
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(
        this.qualificationArtifactRunner ?? snapshot.executable,
        this.qualificationArtifactRunner
          ? [
              "--require-target-channel",
              "--artifact-sha256",
              snapshot.executableDigest.slice("sha256:".length),
              "--",
              snapshot.executable,
            ]
          : [],
        {
          cwd: snapshot.homeDirectory,
          encoding: "utf8",
          input: `${JSON.stringify(request)}\n`,
          maxBuffer: this.maxOutputBytes,
          env: isolatedExecutableEnvironment(snapshot),
          shell: false,
          timeout: this.timeoutMs,
          windowsHide: true,
        },
      );
    } finally {
      snapshot.cleanup();
    }
    if (result.error) {
      const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      throw new CuaSecurityAdapterInvocationError(
        timedOut ? "the CUA security adapter timed out" : "the CUA security adapter failed",
        timedOut,
      );
    }
    return parseAdapterResult(result.stdout.toString(), result.status);
  }
}
