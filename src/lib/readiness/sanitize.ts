// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactFullWithUrls } from "../security/redact.js";

const UNSAFE_TERMINAL_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

/** Redact and render terminal/bidirectional controls as inert visible text. */
export function sanitizeReadinessText(value: string, maxLength: number): string {
  return redactFullWithUrls(value)
    .replace(
      UNSAFE_TERMINAL_CONTROL_PATTERN,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .slice(0, maxLength);
}
