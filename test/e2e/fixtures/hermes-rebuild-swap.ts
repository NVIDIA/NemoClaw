// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HERMES_REBUILD_SWAP_BYTES = 32 * 1024 * 1024 * 1024;
export const HERMES_REBUILD_SWAP_FILE = "/mnt/nemoclaw-hermes-rebuild.swap";

export function hermesRebuildSwapCleanupArgs(): string[] {
  return [
    "bash",
    "-c",
    `set -euo pipefail
swap_file="$1"
if swapon --show --noheadings --output NAME | grep -Fx -- "$swap_file" >/dev/null; then
  swapoff "$swap_file"
fi
rm -f -- "$swap_file"`,
    "hermes-rebuild-swap-cleanup",
    HERMES_REBUILD_SWAP_FILE,
  ];
}

export function parseActiveSwapBytes(output: string): number {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((total, line) => {
      const fields = line.split(/\s+/u);
      const isSwapRow =
        fields.length === 5 &&
        (fields[1] === "file" || fields[1] === "partition") &&
        /^\d+$/u.test(fields[2] ?? "") &&
        /^\d+$/u.test(fields[3] ?? "") &&
        /^-?\d+$/u.test(fields[4] ?? "");
      const size = fields.length === 1 ? fields[0] : isSwapRow ? fields[2] : undefined;
      if (!size || !/^\d+$/u.test(size)) return total;
      return total + Number.parseInt(size, 10);
    }, 0);
}

export function needsHermesRebuildSwap(input: {
  activeSwapBytes: number;
  githubActions: boolean;
}): boolean {
  return input.githubActions && input.activeSwapBytes < HERMES_REBUILD_SWAP_BYTES;
}
