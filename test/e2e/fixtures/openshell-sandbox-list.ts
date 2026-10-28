// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function sandboxPhaseFromList(output: string, sandboxName: string): string | undefined {
  for (const line of output.replace(/\x1B\[[0-9;]*m/g, "").split("\n")) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === sandboxName) return parts.at(-1);
  }
  return undefined;
}

export function openshellListIncludesSandbox(output: string, sandboxName: string): boolean {
  return sandboxPhaseFromList(output, sandboxName) !== undefined;
}
