// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { cloneAndDeepFreeze } from "../../core/immutable";
import type {
  RuntimeProviderNativeArtifactBootstrapPlan,
  RuntimeProviderNativeArtifactReadinessEvidence,
  RuntimeProviderNativeArtifactRecoveryOutcome,
  RuntimeProviderNativeArtifactVerifyAndCreateOutcome,
} from "./contract";
import { validateMxcNativeArtifactBootstrapPlan } from "./mxc-bootstrap";
import {
  MXC_NATIVE_ARTIFACT_CONTROL_PLANE_CONTRACT_VERSION,
  type MxcNativeArtifactControlPlane,
} from "./mxc-bootstrap-operations";

export const MXC_OPENSHELL_CREATE_REQUEST_CONTRACT_VERSION = 1 as const;

const ISSUED_REQUESTS = new WeakSet<object>();

export interface MxcOpenShellCreateRequest {
  readonly contractVersion: typeof MXC_OPENSHELL_CREATE_REQUEST_CONTRACT_VERSION;
  readonly providerId: "mxc";
  readonly requestSha256: string;
  readonly authoritySha256: string;
  readonly providerHandle: string;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly workload: {
    readonly agent: "openclaw";
    readonly platform: "windows/x64";
    readonly artifactRoot: string;
    readonly artifactDigest: string;
    readonly artifactVersion: string;
    readonly sourceRepository: "NVIDIA/NemoClaw";
    readonly sourceRevision: string;
    readonly executablePath: string;
    readonly executableDigest: string;
  };
  readonly writableShare: string;
  readonly driverConfigJson: string;
  /** Accepted environment names that the live adapter must resolve without placing values in argv. */
  readonly hostEnvironmentReferences: readonly string[];
  readonly environment: {
    readonly HOME: string;
    readonly OPENCLAW_CONFIG_PATH: string;
    readonly OPENCLAW_HOME: string;
    readonly OPENCLAW_STATE_DIR: string;
    readonly TEMP: string;
    readonly TMP: string;
    readonly USERPROFILE: string;
  };
}

export interface MxcOpenShellRequestScopedOperations {
  verifyAndCreate(
    request: MxcOpenShellCreateRequest,
  ): Promise<RuntimeProviderNativeArtifactVerifyAndCreateOutcome>;
  verifyReadiness(
    request: MxcOpenShellCreateRequest,
    created: Extract<RuntimeProviderNativeArtifactVerifyAndCreateOutcome, { status: "created" }>,
  ): Promise<RuntimeProviderNativeArtifactReadinessEvidence>;
  recoverCreate(
    request: MxcOpenShellCreateRequest,
  ): Promise<RuntimeProviderNativeArtifactRecoveryOutcome>;
}

export class MxcOpenShellCreateRequestError extends Error {
  constructor(message: string) {
    super(`Invalid OpenShell MXC create request: ${message}`);
    this.name = "MxcOpenShellCreateRequestError";
  }
}

/** Reject structurally valid request lookalikes that were not projected from a qualified plan. */
export function requireIssuedMxcOpenShellCreateRequest(value: MxcOpenShellCreateRequest): void {
  if (typeof value !== "object" || value === null || !ISSUED_REQUESTS.has(value)) {
    throw new MxcOpenShellCreateRequestError("request was not issued by the MXC provider");
  }
}

function sha256Json(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Project one qualified native-artifact plan into OpenShell's per-sandbox MXC request shape. */
export function projectMxcOpenShellCreateRequest(
  value: RuntimeProviderNativeArtifactBootstrapPlan,
): MxcOpenShellCreateRequest {
  const plan = validateMxcNativeArtifactBootstrapPlan(value);
  const command = [plan.executablePath, ...plan.workload.launch.arguments];
  const driverConfigJson = JSON.stringify({
    mxc: {
      command,
      cwd: plan.workingDirectory,
    },
  });
  const boundEnvironmentNames = new Set(Object.keys(plan.environment));
  const hostEnvironmentReferences = plan.workload.launch.environmentNames.filter(
    (name) => !boundEnvironmentNames.has(name),
  );
  const identity = {
    contractVersion: MXC_OPENSHELL_CREATE_REQUEST_CONTRACT_VERSION,
    providerId: "mxc" as const,
    authoritySha256: plan.authoritySha256,
    providerHandle: plan.providerHandle,
    sandboxName: plan.sandboxName,
    lifecycleGeneration: plan.lifecycleGeneration,
    workload: {
      agent: plan.workload.agent,
      platform: plan.workload.platform,
      artifactRoot: plan.artifactRoot,
      artifactDigest: plan.workload.artifact.digest,
      artifactVersion: plan.workload.artifact.version,
      sourceRepository: plan.workload.artifact.source.repository,
      sourceRevision: plan.workload.artifact.source.revision,
      executablePath: plan.executablePath,
      executableDigest: plan.workload.launch.executable.digest,
    },
    writableShare: plan.shareDirectory,
    driverConfigJson,
    hostEnvironmentReferences,
    environment: plan.environment,
  };
  const request = cloneAndDeepFreeze({ ...identity, requestSha256: sha256Json(identity) });
  ISSUED_REQUESTS.add(request);
  return request;
}

/**
 * Bind the generic MXC bootstrap contract to request-scoped OpenShell operations.
 *
 * The injected operations remain responsible for stable artifact verification, sandbox mutation,
 * readiness, and recovery. This adapter guarantees that all three receive the same canonical,
 * provenance-bound OpenShell request instead of caller-provided command or environment data.
 */
export function createMxcOpenShellRequestScopedControlPlane(
  operations: MxcOpenShellRequestScopedOperations,
): MxcNativeArtifactControlPlane {
  if (
    typeof operations?.verifyAndCreate !== "function" ||
    typeof operations.verifyReadiness !== "function" ||
    typeof operations.recoverCreate !== "function"
  ) {
    throw new MxcOpenShellCreateRequestError(
      "verify-and-create, readiness, and recovery operations are required",
    );
  }
  const verifyAndCreate = operations.verifyAndCreate.bind(operations);
  const verifyReadiness = operations.verifyReadiness.bind(operations);
  const recoverCreate = operations.recoverCreate.bind(operations);
  const controlPlane: MxcNativeArtifactControlPlane = {
    contractVersion: MXC_NATIVE_ARTIFACT_CONTROL_PLANE_CONTRACT_VERSION,
    providerId: "mxc",
    verifyAndCreate: (plan) => verifyAndCreate(projectMxcOpenShellCreateRequest(plan)),
    verifyReadiness: (plan, created) =>
      verifyReadiness(projectMxcOpenShellCreateRequest(plan), created),
    recoverCreate: (plan) => recoverCreate(projectMxcOpenShellCreateRequest(plan)),
  };
  return Object.freeze(controlPlane);
}
