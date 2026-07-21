// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HERMES_REBUILD_SWAP_BYTES = 32 * 1024 * 1024 * 1024;

export function parseActiveSwapBytes(output: string): number {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((total, line) => {
      if (!/^\d+$/u.test(line)) return total;
      return total + Number.parseInt(line, 10);
    }, 0);
}

export function needsHermesRebuildSwap(input: {
  activeSwapBytes: number;
  githubActions: boolean;
}): boolean {
  return input.githubActions && input.activeSwapBytes < HERMES_REBUILD_SWAP_BYTES;
}
