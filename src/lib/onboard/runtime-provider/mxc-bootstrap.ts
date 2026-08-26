// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";

import { parseNativeArtifactWorkloadReceiptV1 } from "../workload/native-artifact";
import {
  RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_CONTRACT_VERSION,
  RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_PLAN_SCHEMA_VERSION,
  type RuntimeProviderNativeArtifactBootstrapInput,
  type RuntimeProviderNativeArtifactBootstrapOperations,
  type RuntimeProviderNativeArtifactBootstrapPlan,
  type RuntimeProviderNativeArtifactBootstrapResult,
  type RuntimeProviderNativeArtifactBootstrapSurface,
} from "./contract";

const MXC_PROVIDER_ID = "mxc";
const SANDBOX_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_PATH_BYTES = 4096;

export class MxcNativeArtifactBootstrapError extends Error {
  constructor(message: string) {
    super(`Invalid MXC native artifact bootstrap: ${message}`);
    this.name = "MxcNativeArtifactBootstrapError";
  }
}

function frozen<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function canonicalWindowsPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !path.win32.isAbsolute(value) ||
    path.win32.normalize(value) !== value
  ) {
    throw new MxcNativeArtifactBootstrapError(`${label} must be a canonical absolute path`);
  }
  return value;
}

function requireDriveRoot(value: unknown): string {
  const driveRoot = canonicalWindowsPath(value, "drive root");
  if (path.win32.parse(driveRoot).root !== driveRoot || !/^[A-Za-z]:\\$/u.test(driveRoot)) {
    throw new MxcNativeArtifactBootstrapError("drive root must name one Windows drive root");
  }
  return driveRoot;
}

function requireDirectChild(
  root: string,
  value: unknown,
  label: string,
  parentLabel: string,
): string {
  const child = canonicalWindowsPath(value, label);
  const relative = path.win32.relative(root, child);
  if (
    relative.length === 0 ||
    path.win32.isAbsolute(relative) ||
    relative.startsWith("..") ||
    relative.includes("\\") ||
    relative.includes("/") ||
    relative.endsWith(".") ||
    relative.endsWith(" ")
  ) {
    throw new MxcNativeArtifactBootstrapError(
      `${label} must be a direct child of the ${parentLabel}`,
    );
  }
  return child;
}

function providerOwnedShareDirectory(
  driveRoot: string,
  sandboxName: string,
  lifecycleGeneration: string,
): string {
  const generationSha256 = createHash("sha256").update(lifecycleGeneration, "utf8").digest("hex");
  return path.win32.join(driveRoot, `nemoclaw-${sandboxName}-${generationSha256.slice(0, 12)}`);
}

function planAuthoritySha256(
  input: Omit<RuntimeProviderNativeArtifactBootstrapPlan, "authoritySha256">,
): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function preparePlan(
  input: RuntimeProviderNativeArtifactBootstrapInput,
): RuntimeProviderNativeArtifactBootstrapPlan {
  if (input.providerId !== MXC_PROVIDER_ID) {
    throw new MxcNativeArtifactBootstrapError("provider identity does not match 'mxc'");
  }
  if (!SANDBOX_NAME_PATTERN.test(input.sandboxName)) {
    throw new MxcNativeArtifactBootstrapError("sandbox name is not a canonical OpenShell name");
  }
  if (
    typeof input.lifecycleGeneration !== "string" ||
    input.lifecycleGeneration.length === 0 ||
    input.lifecycleGeneration.length > 256 ||
    CONTROL_CHARACTER_PATTERN.test(input.lifecycleGeneration)
  ) {
    throw new MxcNativeArtifactBootstrapError("lifecycle generation is not a bounded identity");
  }
  const workload = parseNativeArtifactWorkloadReceiptV1(input.workload);
  const requiredEnvironmentNames = [
    "HOME",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ] as const;
  const environmentNames = new Set(workload.launch.environmentNames);
  if (requiredEnvironmentNames.some((name) => !environmentNames.has(name))) {
    throw new MxcNativeArtifactBootstrapError(
      "workload launch must bind OpenClaw home, state, config, TEMP, and TMP to the writable share",
    );
  }
  const driveRoot = requireDriveRoot(input.driveRoot);
  const artifactRoot = requireDirectChild(
    driveRoot,
    input.artifactRoot,
    "artifact root",
    "drive root",
  );
  const shareDirectory = providerOwnedShareDirectory(
    driveRoot,
    input.sandboxName,
    input.lifecycleGeneration,
  );
  if (
    path.win32.resolve(artifactRoot).toLowerCase() ===
    path.win32.resolve(shareDirectory).toLowerCase()
  ) {
    throw new MxcNativeArtifactBootstrapError(
      "artifact root and provider-owned writable share must remain separate",
    );
  }
  const homeDirectory = path.win32.join(shareDirectory, "home");
  const stateDirectory = path.win32.join(shareDirectory, "openclaw-state");
  const temporaryDirectory = path.win32.join(shareDirectory, "temp");
  const executablePath = path.win32.join(
    artifactRoot,
    workload.launch.executable.relativePath.replaceAll("/", "\\"),
  );
  const workingDirectory =
    workload.launch.workingDirectory === "."
      ? artifactRoot
      : path.win32.join(artifactRoot, workload.launch.workingDirectory.replaceAll("/", "\\"));
  const authority = {
    schemaVersion: RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_PLAN_SCHEMA_VERSION,
    providerId: MXC_PROVIDER_ID,
    sandboxName: input.sandboxName,
    lifecycleGeneration: input.lifecycleGeneration,
    driveRoot,
    artifactRoot,
    shareDirectory,
    homeDirectory,
    stateDirectory,
    temporaryDirectory,
    executablePath,
    workingDirectory,
    environment: {
      HOME: homeDirectory,
      OPENCLAW_CONFIG_PATH: path.win32.join(stateDirectory, "openclaw.json"),
      OPENCLAW_HOME: homeDirectory,
      OPENCLAW_STATE_DIR: stateDirectory,
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      USERPROFILE: homeDirectory,
    },
    workload,
  } as const;
  return frozen({ ...authority, authoritySha256: planAuthoritySha256(authority) });
}

function result(
  plan: RuntimeProviderNativeArtifactBootstrapPlan,
  outcome: RuntimeProviderNativeArtifactBootstrapResult["outcome"],
  reason: RuntimeProviderNativeArtifactBootstrapResult["reason"],
  resourceState: RuntimeProviderNativeArtifactBootstrapResult["resourceState"],
): RuntimeProviderNativeArtifactBootstrapResult {
  return frozen({
    outcome,
    reason,
    authoritySha256: plan.authoritySha256,
    resourceState,
    cleanup: { attempted: false, resourceRemovalAuthorized: false },
  });
}

async function runMxcNativeArtifactBootstrap(
  input: RuntimeProviderNativeArtifactBootstrapInput,
  operations: RuntimeProviderNativeArtifactBootstrapOperations,
): Promise<RuntimeProviderNativeArtifactBootstrapResult> {
  if (
    typeof operations?.verifyAndCreate !== "function" ||
    typeof operations.verifyReadiness !== "function"
  ) {
    throw new MxcNativeArtifactBootstrapError(
      "atomic artifact verification and create plus readiness operations are required before bootstrap",
    );
  }
  const plan = preparePlan(input);
  try {
    const created = await operations.verifyAndCreate(plan);
    if (
      created?.status === "not-created" &&
      (created.reason === "artifact-verification-failed" || created.reason === "create-rejected")
    ) {
      return result(plan, "not-created", created.reason, "absent");
    }
    if (created?.status === "unknown") {
      return result(plan, "retained", "create-outcome-unknown", "possibly-retained");
    }
    if (created?.status !== "created") {
      return result(plan, "retained", "create-outcome-unknown", "possibly-retained");
    }
    if (
      !SHA256_PATTERN.test(created.authoritySha256) ||
      created.authoritySha256 !== plan.authoritySha256 ||
      created.artifactDigest !== plan.workload.artifact.digest ||
      created.executableDigest !== plan.workload.launch.executable.digest
    ) {
      return result(plan, "retained", "create-authority-mismatch", "possibly-retained");
    }
  } catch {
    return result(plan, "retained", "create-outcome-unknown", "possibly-retained");
  }
  try {
    const readiness = await operations.verifyReadiness(plan);
    if (
      readiness?.authoritySha256 !== plan.authoritySha256 ||
      readiness.lifecycleGeneration !== plan.lifecycleGeneration ||
      readiness.artifactDigest !== plan.workload.artifact.digest ||
      readiness.executableDigest !== plan.workload.launch.executable.digest ||
      readiness.ready !== true
    ) {
      return result(plan, "retained", "readiness-not-proven", "possibly-retained");
    }
  } catch {
    return result(plan, "retained", "readiness-not-proven", "possibly-retained");
  }
  return result(plan, "ready", null, "active");
}

export function createMxcNativeArtifactBootstrapSurface(): RuntimeProviderNativeArtifactBootstrapSurface {
  return {
    providerId: MXC_PROVIDER_ID,
    supported: true,
    bootstrapKind: "native-artifact",
    contractVersion: RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_CONTRACT_VERSION,
    run: runMxcNativeArtifactBootstrap,
  };
}
