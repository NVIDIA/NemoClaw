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
    "7423bdf7305efcdd6517eea722c0a7cd71a0a80f8c59dbcbed58c11458415b00",
    "cf8d9fef579b5d7dda1c366c4121fd987b48b0d0ec6284c0f530907df04a6316",
  ]),
});

export function acceptedCandidateReceiptDigests(agent: string): readonly string[] {
  return CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS[agent as CandidateManagedImageAgent] ?? [];
}
