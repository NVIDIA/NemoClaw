// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedWorkloadRebuildPlan,
  PreparedManagedWorkloadReplacement,
  ReadyManagedWorkloadReplacement,
  ReboundManagedWorkloadReplacement,
  RestoredManagedWorkloadReplacement,
  StagedManagedWorkloadReplacement,
} from "./contract";

const MAX_PROVIDER_ARTIFACT_BYTES = 16 * 1024;

export class ManagedWorkloadRebuildArtifactError extends Error {
  constructor(message: string) {
    super(`Invalid managed workload rebuild artifact: ${message}`);
    this.name = "ManagedWorkloadRebuildArtifactError";
  }
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PROVIDER_ARTIFACT_BYTES
  ) {
    throw new ManagedWorkloadRebuildArtifactError(`${label} is missing or invalid`);
  }
  return value;
}

function requireBinding(
  plan: ManagedWorkloadRebuildPlan,
  value: {
    readonly schemaVersion: unknown;
    readonly providerId: unknown;
    readonly transactionId: unknown;
  },
  label: string,
): void {
  if (
    value.schemaVersion !== 1 ||
    value.providerId !== plan.providerId ||
    value.transactionId !== plan.transactionId
  ) {
    throw new ManagedWorkloadRebuildArtifactError(
      `${label} is not bound to '${plan.providerId}/${plan.transactionId}'`,
    );
  }
}

export function validatePreparedReplacement(
  plan: ManagedWorkloadRebuildPlan,
  value: PreparedManagedWorkloadReplacement,
): PreparedManagedWorkloadReplacement {
  requireBinding(plan, value, "prepared replacement");
  const previousRuntimeHandle = boundedText(value.previousRuntimeHandle, "previous runtime handle");
  const preparationHandle = boundedText(value.preparationHandle, "preparation handle");
  const previousLiveIdentityFingerprint = boundedText(
    value.previousLiveIdentityFingerprint,
    "previous live identity fingerprint",
  );
  if (previousLiveIdentityFingerprint !== plan.previousAuthority.liveIdentityFingerprint) {
    throw new ManagedWorkloadRebuildArtifactError(
      "prepared replacement does not prove the exact old live identity",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    providerId: plan.providerId,
    transactionId: plan.transactionId,
    previousRuntimeHandle,
    preparationHandle,
    previousLiveIdentityFingerprint,
  });
}

export function validateStagedReplacement(
  plan: ManagedWorkloadRebuildPlan,
  prepared: PreparedManagedWorkloadReplacement,
  value: StagedManagedWorkloadReplacement,
): StagedManagedWorkloadReplacement {
  requireBinding(plan, value, "staged replacement");
  const previousRuntimeHandle = boundedText(value.previousRuntimeHandle, "previous runtime handle");
  if (previousRuntimeHandle !== prepared.previousRuntimeHandle) {
    throw new ManagedWorkloadRebuildArtifactError(
      "staged replacement changed the exact old runtime handle",
    );
  }
  const stagingHandle = boundedText(value.stagingHandle, "staging handle");
  if (stagingHandle === previousRuntimeHandle) {
    throw new ManagedWorkloadRebuildArtifactError(
      "staged and authoritative runtime handles must be distinct",
    );
  }
  const lifecycleGeneration = boundedText(
    value.lifecycleGeneration,
    "replacement lifecycle generation",
  );
  if (lifecycleGeneration === plan.previousAuthority.lifecycleGeneration) {
    throw new ManagedWorkloadRebuildArtifactError(
      "replacement lifecycle generation must differ from the old authority",
    );
  }
  const liveIdentityFingerprint = boundedText(
    value.liveIdentityFingerprint,
    "replacement live identity fingerprint",
  );
  if (liveIdentityFingerprint === plan.previousAuthority.liveIdentityFingerprint) {
    throw new ManagedWorkloadRebuildArtifactError(
      "replacement live identity must differ from the old authority",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    providerId: plan.providerId,
    transactionId: plan.transactionId,
    previousRuntimeHandle,
    stagingHandle,
    lifecycleGeneration,
    liveIdentityFingerprint,
  });
}

function validateStagedContinuity(
  plan: ManagedWorkloadRebuildPlan,
  staged: StagedManagedWorkloadReplacement,
  value: StagedManagedWorkloadReplacement,
  label: string,
): void {
  requireBinding(plan, value, label);
  if (
    value.previousRuntimeHandle !== staged.previousRuntimeHandle ||
    value.stagingHandle !== staged.stagingHandle ||
    value.lifecycleGeneration !== staged.lifecycleGeneration ||
    value.liveIdentityFingerprint !== staged.liveIdentityFingerprint
  ) {
    throw new ManagedWorkloadRebuildArtifactError(
      `${label} changed provider-owned staging authority`,
    );
  }
}

export function validateReadyReplacement(
  plan: ManagedWorkloadRebuildPlan,
  staged: StagedManagedWorkloadReplacement,
  value: ReadyManagedWorkloadReplacement,
): ReadyManagedWorkloadReplacement {
  validateStagedContinuity(plan, staged, value, "ready replacement");
  return Object.freeze({
    ...staged,
    readinessReceipt: boundedText(value.readinessReceipt, "readiness receipt"),
  });
}

export function validateRestoredReplacement(
  plan: ManagedWorkloadRebuildPlan,
  ready: ReadyManagedWorkloadReplacement,
  value: RestoredManagedWorkloadReplacement,
): RestoredManagedWorkloadReplacement {
  validateStagedContinuity(plan, ready, value, "restored replacement");
  if (value.readinessReceipt !== ready.readinessReceipt) {
    throw new ManagedWorkloadRebuildArtifactError(
      "restore changed the validated readiness receipt",
    );
  }
  return Object.freeze({
    ...ready,
    restoreReceipt: boundedText(value.restoreReceipt, "state restore receipt"),
  });
}

export function validateReboundReplacement(
  plan: ManagedWorkloadRebuildPlan,
  restored: RestoredManagedWorkloadReplacement,
  value: ReboundManagedWorkloadReplacement,
): ReboundManagedWorkloadReplacement {
  validateStagedContinuity(plan, restored, value, "provider-rebound replacement");
  if (
    value.readinessReceipt !== restored.readinessReceipt ||
    value.restoreReceipt !== restored.restoreReceipt
  ) {
    throw new ManagedWorkloadRebuildArtifactError(
      "provider rebind changed readiness or restore authority",
    );
  }
  return Object.freeze({
    ...restored,
    providerRebindReceipt: boundedText(value.providerRebindReceipt, "provider rebind receipt"),
  });
}

export function validateNotReadyReason(value: unknown): string {
  return boundedText(value, "not-ready reason");
}
