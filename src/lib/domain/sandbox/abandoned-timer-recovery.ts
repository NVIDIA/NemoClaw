// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface AbandonedTimerGeneration {
  key: string;
  token: string;
}

/**
 * Admit recovery only for the snapshot that completed grace. A later marker
 * read that disagrees is a replacement generation and must wait again.
 */
export function decideAbandonedTimerRecoveryToken(
  aged: AbandonedTimerGeneration | null,
  current: AbandonedTimerGeneration | null,
): string | undefined {
  if (!aged || !current) return undefined;
  if (aged.key !== current.key || aged.token !== current.token) return undefined;
  return aged.token;
}
