// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { UnknownRecord } from "../core/json-types";
import {
  fingerprintRebuildReplacement,
  matchesRebuildTargetRegistry,
} from "../rebuild-correlation";
import type {
  RebuildTransactionReceiptsV1,
  RebuildTransactionRecordV1,
} from "./rebuild-transaction";
import { getSandbox } from "./registry";

export type RebuildReplacementIdentityVerifier = (
  sandboxName: string,
  identityFingerprint: string,
  transaction: RebuildTransactionRecordV1,
) => boolean;

export const registeredRebuildReplacementMatches: RebuildReplacementIdentityVerifier = (
  sandboxName,
  identityFingerprint,
  transaction,
) => {
  const entry = getSandbox(sandboxName);
  return (
    entry !== null &&
    fingerprintRebuildReplacement(entry) === identityFingerprint &&
    matchesRebuildTargetRegistry(transaction, entry)
  );
};

export interface RebuildReceiptValidation {
  record(value: unknown, label: string, sandboxName: string): UnknownRecord;
  timestamp(value: unknown, label: string, sandboxName: string): string;
  backupTimestamp(value: unknown, sandboxName: string): string;
  fingerprint(value: unknown, label: string, sandboxName: string): string;
}

export function normalizeRebuildTransactionReceipts(
  value: unknown,
  sandboxName: string,
  validation: RebuildReceiptValidation,
): RebuildTransactionReceiptsV1 {
  const receipts = validation.record(value, "receipts", sandboxName);
  const backup = validation.record(receipts.backup, "receipts.backup", sandboxName);
  const oldSandboxDeletionValue = receipts.oldSandboxDeletion;
  const oldSandboxDeletion =
    oldSandboxDeletionValue === undefined
      ? undefined
      : validation.record(oldSandboxDeletionValue, "receipts.oldSandboxDeletion", sandboxName);
  const normalizedOldSandboxDeletion = oldSandboxDeletion
    ? {
        observedAt: validation.timestamp(
          oldSandboxDeletion.observedAt,
          "receipts.oldSandboxDeletion.observedAt",
          sandboxName,
        ),
      }
    : undefined;
  const replacementValue = receipts.replacement;
  const replacement =
    replacementValue === undefined
      ? undefined
      : validation.record(replacementValue, "receipts.replacement", sandboxName);
  const normalizedReplacement = replacement
    ? {
        identityFingerprint: validation.fingerprint(
          replacement.identityFingerprint,
          "receipts.replacement.identityFingerprint",
          sandboxName,
        ),
        observedAt: validation.timestamp(
          replacement.observedAt,
          "receipts.replacement.observedAt",
          sandboxName,
        ),
      }
    : undefined;
  return {
    backup: {
      manifestTimestamp: validation.backupTimestamp(backup.manifestTimestamp, sandboxName),
      manifestFingerprint: validation.fingerprint(
        backup.manifestFingerprint,
        "receipts.backup.manifestFingerprint",
        sandboxName,
      ),
    },
    ...(normalizedOldSandboxDeletion ? { oldSandboxDeletion: normalizedOldSandboxDeletion } : {}),
    ...(normalizedReplacement ? { replacement: normalizedReplacement } : {}),
  };
}
