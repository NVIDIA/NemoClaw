// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

type SnapshotCommandFailure = Error & {
  exitCode: number;
  lines: readonly string[];
};
export function snapshotCommandError(error: unknown): SnapshotCommandFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<SnapshotCommandFailure>;
  if (
    candidate.name === "SnapshotCommandError" &&
    typeof candidate.exitCode === "number" &&
    Array.isArray(candidate.lines)
  ) {
    return candidate as SnapshotCommandFailure;
  }
  return null;
}

export const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});
