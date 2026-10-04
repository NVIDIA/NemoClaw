// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

/**
 * Build a string oclif flag that trims its input and rejects empty or
 * whitespace-only values. Shared by the global `inference set` command and its
 * sandbox-first mirror so both enforce the same non-empty contract at the
 * command boundary before delegating deeper validation to the shared inference
 * action layer.
 */
export function nonEmptyFlag(description: string) {
  return Flags.string({
    description,
    parse: async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) throw new Error(`${description} cannot be empty`);
      return trimmed;
    },
  });
}
