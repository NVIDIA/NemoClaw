// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact, redactFull, redactSensitiveText } from "../../security/redact";

export function redactOnboardDiagnosticText(message: string): string {
  return redactSensitiveText(message) ?? "";
}

export function redactOnboardCommandDiagnosticText(message: string): string {
  return redactSensitiveText(redact(redactFull(message))) ?? "";
}
