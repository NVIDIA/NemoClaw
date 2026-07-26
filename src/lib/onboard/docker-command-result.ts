// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Docker adapters use `status: null` when a process cannot start or times out.
 * Mutation and cleanup gates therefore accept only an explicit zero status.
 */
export function hasZeroDockerExitStatus(
  result: { status?: number | null } | null | undefined,
): boolean {
  return result?.status === 0;
}
