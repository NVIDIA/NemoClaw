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
    "fc742f42bf0a6c51069574c9cc74e5bcf3c8d3ecb5274538efbd78254830ee23",
    "baaec32f991cc5bbb39cfa3da1dd94fc7d4d9543cfd8ff765ea98454d5541fae",
    "2b9656c3dd6f3da4b0c43b7538137c613344657aa3bad4b528e7e76cd6ba8aa2",
    "b9fa54c2cce90d5f6ee4b2786908441babbe84eb75ee4265e84779d9c5ea0fb8",
  ]),
});

export function acceptedCandidateReceiptDigests(agent: string): readonly string[] {
  return CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS[agent as CandidateManagedImageAgent] ?? [];
}
