// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactFullWithUrls } from "../../security/redact";

/** Fully redact provider command output, including caller-known secret material. */
export function redactProviderDiagnostic(
  output: string,
  sensitiveValues: readonly string[] = [],
): string {
  let safe = output;
  for (const value of [...new Set(sensitiveValues.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  )) {
    safe = safe.replaceAll(value, "<REDACTED>");
  }
  return redactFullWithUrls(safe).trim();
}
