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
    "1640b717b5bad4285a56307a3dd4430e179034520e659ed21012d7bae561b4d9",
    "6b0972516bcd99f1283c6c1c522d6b87a9da82690c0fd792aa07707674408514",
  ]),
});

export function acceptedCandidateReceiptDigests(agent: string): readonly string[] {
  return CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS[agent as CandidateManagedImageAgent] ?? [];
}
