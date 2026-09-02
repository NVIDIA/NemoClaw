// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Canonical failure classes retained in bounded E2E retry evidence. */
export const RETRY_FAILURE_CLASSES = [
  "authentication",
  "authorization",
  "cleanup",
  "deterministic",
  "malformed-input",
  "policy-denial",
  "transient-external",
  "ambiguous-mutation",
] as const;

export type RetryFailureClass = (typeof RETRY_FAILURE_CLASSES)[number];
export type RetryIdempotence = "read-only" | "idempotent" | "reconciled-mutation";

export interface RetryAttemptEvidence {
  attempt: number;
  outcome: "failed" | "passed";
  failureClass?: RetryFailureClass;
  reconciled?: boolean;
  retryScheduled: boolean;
}

export interface RetryEvidence {
  schemaVersion: 1;
  operation: string;
  owner: string;
  idempotence: RetryIdempotence;
  maxAttempts: number;
  outcome: "failed-no-retry" | "exhausted" | "passed-after-retry" | "passed-first-attempt";
  attempts: RetryAttemptEvidence[];
}
