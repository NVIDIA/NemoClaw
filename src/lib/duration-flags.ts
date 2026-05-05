// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Errors, Flags } from "@oclif/core";

import { parseDuration } from "./duration";

const LOGS_SINCE_DURATION_RE = /^[1-9]\d*(?:ms|s|m|h|d)$/i;

export function parseLogsSinceDuration(input: string): string {
  const trimmed = input.trim();
  if (!LOGS_SINCE_DURATION_RE.test(trimmed)) {
    throw new Errors.CLIError("--since requires a positive duration like 5m, 1h, or 30s");
  }
  return trimmed;
}

export function parseShieldsTimeoutDuration(input: string): string {
  const trimmed = input.trim();
  try {
    parseDuration(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Errors.CLIError(message);
  }
  return trimmed;
}

export const logsSinceDurationFlag = Flags.custom<string>({
  parse: async (input) => parseLogsSinceDuration(input),
});

export const shieldsTimeoutDurationFlag = Flags.custom<string>({
  parse: async (input) => parseShieldsTimeoutDuration(input),
});
