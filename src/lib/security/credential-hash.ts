// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

// SHA-256 hex digest of `value`. Used to fingerprint migrated legacy
// secrets in the persisted onboard session so a later `--resume` can
// detect when the legacy file value was edited between runs (or another
// session is on disk with stale entries) and refuse to inherit a stale
// "migrated" mark.
export function legacyValueHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashCredential(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  // This is a non-secret change detector for credential rotation, not a
  // password verifier or credential storage primitive.
  return crypto.createHash("sha256").update(normalized).digest("hex"); // codeql[js/insufficient-password-hash]
}
