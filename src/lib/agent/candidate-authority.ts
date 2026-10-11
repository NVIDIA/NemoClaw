// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CandidateManagedImageAgent } from "../onboard/managed-image/contract";

/**
 * Repository-controlled qualification authority for release candidates. A
 * candidate is reachable only through a qualification receipt whose SHA-256
 * appears here, so a caller can neither mint an accepted digest nor replace one
 * through environment configuration.
 */
export const CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS: Readonly<
  Record<CandidateManagedImageAgent, readonly string[]>
> = Object.freeze({
  pi: Object.freeze([
    "7930159b6151504624d3da6efff6cadf6dab5b6a80726265725fe583a5764995",
    "e71fca2781a1cd249c4fc587e61fed457c0723adf80283e37d667893d59fd690",
    "d9adcba3a974984d148ad91cf526fb27a9befdd43c43e7c1cff66c451c9ac82f",
    "0d492b45d1e30a504faf7ced63671a1fcb9ba7ac74a2c84bf8c6a2e7e72b8406",
  ]),
});

export function acceptedCandidateReceiptDigests(agent: string): readonly string[] {
  return CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS[agent as CandidateManagedImageAgent] ?? [];
}
