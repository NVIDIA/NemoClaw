// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactSensitiveText } from "./redact";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

export { redactSensitiveText };

/** Redact, flatten, and UTF-8 bound untrusted text before durable diagnostics. */
export function boundedSecretFreeText(value: unknown, maxBytes: number, fallback: string): string {
  const redacted = (redactSensitiveText(value) ?? fallback)
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!redacted) return fallback;
  let result = "";
  for (const character of redacted) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result || fallback;
}
