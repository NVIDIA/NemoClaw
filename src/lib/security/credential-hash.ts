// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export function hashCredential(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  // This is a non-secret change detector for credential rotation, not a
  // password verifier or credential storage primitive.
  return crypto.createHash("sha256").update(normalized).digest("hex"); // codeql[js/insufficient-password-hash]
}
