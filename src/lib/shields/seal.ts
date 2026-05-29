// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared helpers for the shields-up content seal. Centralised so the lock
// path that writes the seal and the status path that re-checks it share
// the same input contract (sha256sum output shape, hex normalisation).

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function parseSha256Output(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const token = trimmed.split(/\s+/, 1)[0];
  return SHA256_HEX.test(token) ? token.toLowerCase() : null;
}

// Issue-string prefixes the verifier emits for hash-related failures.
// Used by callers that need to classify whether drift is launderable
// (perms-only) or non-launderable (any hash-verification failure).
export const HASH_ISSUE_PATTERNS: readonly string[] = [
  "content drifted",
  "sha256sum failed",
  "sha256sum output unparsable",
  "no seal recorded",
];

export function isHashVerificationIssue(entry: string): boolean {
  return HASH_ISSUE_PATTERNS.some((p) => entry.includes(p));
}
