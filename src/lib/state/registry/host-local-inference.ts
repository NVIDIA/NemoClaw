// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const MAX_RECEIPT_BYTES = 32 * 1024;

/**
 * Clone the canonical, secret-free receipt transport without teaching the
 * state layer about any concrete runtime provider. Provider consumers still
 * parse the complete receipt schema and fail closed before lifecycle use.
 */
export function cloneSandboxHostLocalInferenceReceipt(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_RECEIPT_BYTES
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    `${JSON.stringify(parsed)}\n` !== value
  ) {
    return undefined;
  }
  return value;
}
