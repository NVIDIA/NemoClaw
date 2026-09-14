// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact, redactFull, redactFullWithUrls, redactSensitiveText } from "../../security/redact";

/** Redact complete secret blocks before bounding individual diagnostic lines. */
export function redactOnboardErrorText(message: string): string {
  return redactFullWithUrls(message).split("\n").map(redactOnboardDiagnosticText).join("\n");
}

/** Bound a diagnostic after removing recognized credential values. */
export function redactOnboardDiagnosticText(message: string): string {
  return redactSensitiveText(message) ?? "";
}

export function redactOnboardCommandDiagnosticText(message: string): string {
  return redactSensitiveText(redact(redactFull(message))) ?? "";
}
