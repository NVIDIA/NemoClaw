// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  createOnboardLockOwner,
  inspectOnboardLock,
  observeOnboardLock,
  systemOnboardLockEvidence,
} from "./lock-observation";
export type {
  OnboardLockEvidence,
  OnboardLockFileSnapshot,
  OnboardLockInspection,
  OnboardLockObservation,
  OnboardLockOwner,
} from "./lock-observation";
export {
  listRetainedSandboxRecoveryRecords,
  recordRetainedSandboxRecovery,
  retainedSandboxRecoveryAuthorityIsCurrent,
  retainedSandboxRecoveryFile,
  resolveRetainedSandboxRecovery,
  validSafeEvidence,
} from "./retained-sandbox-recovery";
export type {
  RecordRetainedSandboxRecoveryInput,
  RetainedSandboxRecoveryRecord,
  RetainedSandboxRecoveryReason,
} from "./retained-sandbox-recovery";
