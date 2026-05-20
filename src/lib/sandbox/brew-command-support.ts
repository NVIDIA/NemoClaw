// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

type BrewCommandFailure = Error & {
  exitCode: number;
  lines: readonly string[];
};

export function brewCommandError(error: unknown): BrewCommandFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<BrewCommandFailure>;
  if (
    candidate.name === "BrewCommandError" &&
    typeof candidate.exitCode === "number" &&
    Array.isArray(candidate.lines)
  ) {
    return candidate as BrewCommandFailure;
  }
  return null;
}

export const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});
