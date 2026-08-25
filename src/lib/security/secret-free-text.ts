// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactSensitiveText } from "./redact";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

export { redactSensitiveText };

function flattenSecretFreeText(value: unknown): string {
  return (redactSensitiveText(value) ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

/** Redact, flatten, and UTF-8 bound untrusted text before durable diagnostics. */
export function boundedSecretFreeText(value: unknown, maxBytes: number, fallback: string): string {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  if (limit === 0) return "";
  const safeFallback = flattenSecretFreeText(fallback);
  const result = truncateUtf8(flattenSecretFreeText(value) || safeFallback, limit);
  return result || truncateUtf8(safeFallback, limit);
}
