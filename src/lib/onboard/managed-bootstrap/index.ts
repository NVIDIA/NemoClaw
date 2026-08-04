// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  activateManagedBootstrapSequence,
  enforceManagedBootstrapRecoveryForSandbox,
  finalizeManagedBootstrapSequence,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapActivatedTransaction,
  type ManagedBootstrapAdapter,
  type ManagedBootstrapAuthorityStore,
  type ManagedBootstrapExpectedPlan,
  type ManagedBootstrapPreparedTransaction,
  ManagedBootstrapRecoveryBlockedError,
  type ManagedBootstrapRecoveryFailure,
  type ManagedBootstrapRecoveryReceipt,
  type ManagedBootstrapRecoveryReport,
  prepareManagedBootstrapSequence,
  recoverManagedBootstrapTransactions,
} from "./adapter";
export {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  parseManagedBootstrapEnvelope,
  parseManagedBootstrapImageCompletion,
  serializeManagedBootstrapEnvelope,
  serializeManagedBootstrapImageCompletion,
} from "./envelope";
export {
  applyManagedBootstrapEnvelope,
  type ManagedBootstrapEnvelopeClaimPaths,
  type ManagedBootstrapImageRuntimeExpected,
  main as mainManagedBootstrapImageRuntime,
  managedBootstrapEnvelopeClaimPaths,
  readManagedBootstrapEnvelope,
  recoverManagedBootstrapEnvelopeClaim,
  verifyManagedBootstrapImageCompletion,
} from "./image-runtime";
export type {
  ManagedBootstrapRuntimeCreateLifecycle,
  ManagedBootstrapRuntimePatch,
} from "./runtime-create";
