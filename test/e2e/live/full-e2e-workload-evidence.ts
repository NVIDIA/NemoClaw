// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type FullE2eColdWorkloadEvidence =
  | {
      readonly kind: "legacy-dockerfile";
      readonly reference: string | null;
    }
  | {
      readonly kind: "managed-image";
      readonly reference: string;
      readonly sourceCohort: string;
      readonly sourceRevision: string;
    };

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveFullE2eColdWorkloadEvidence(input: {
  readonly registry: unknown;
  readonly sandboxName: string;
  readonly usedBuildKitPrebuild: boolean;
}): FullE2eColdWorkloadEvidence {
  const registry = record(input.registry, "sandbox registry");
  const sandboxes = record(registry.sandboxes, "sandbox registry sandboxes");
  const sandbox = record(sandboxes[input.sandboxName], `sandbox registry row ${input.sandboxName}`);
  const workload = record(sandbox.workload, `sandbox workload receipt ${input.sandboxName}`);

  if (workload.schemaVersion !== 1) {
    throw new Error("sandbox workload receipt must use schema version 1");
  }

  if (workload.kind === "legacy-dockerfile") {
    if (
      workload.shared !== false ||
      (workload.reference !== null && !nonEmptyString(workload.reference))
    ) {
      throw new Error("legacy Dockerfile workload receipt is invalid");
    }
    if (!input.usedBuildKitPrebuild) {
      throw new Error("legacy Dockerfile cold onboarding must use the local BuildKit prebuild");
    }
    return {
      kind: "legacy-dockerfile",
      reference: workload.reference as string | null,
    };
  }

  if (workload.kind !== "managed-image") {
    throw new Error(`unsupported cold onboarding workload kind: ${String(workload.kind)}`);
  }
  if (workload.shared !== true) {
    throw new Error("managed-image workload receipt must be shared");
  }
  if (
    !nonEmptyString(workload.reference) ||
    !/^[^@\s]+@sha256:[0-9a-f]{64}$/u.test(workload.reference)
  ) {
    throw new Error("managed-image workload receipt must select an exact digest reference");
  }
  if (sandbox.imageTag !== workload.reference) {
    throw new Error("managed-image workload reference must match the registered sandbox image tag");
  }
  if (!nonEmptyString(workload.sourceCohort)) {
    throw new Error("managed-image workload receipt must identify its publication cohort");
  }
  if (
    !nonEmptyString(workload.sourceRevision) ||
    !/^[0-9a-f]{40}$/u.test(workload.sourceRevision)
  ) {
    throw new Error("managed-image workload receipt must identify its exact source revision");
  }
  if (input.usedBuildKitPrebuild) {
    throw new Error("managed-image cold onboarding must not use a local BuildKit prebuild");
  }

  return {
    kind: "managed-image",
    reference: workload.reference,
    sourceCohort: workload.sourceCohort,
    sourceRevision: workload.sourceRevision,
  };
}
