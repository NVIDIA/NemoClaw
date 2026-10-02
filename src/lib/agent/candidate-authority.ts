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
    "9b70f7bf2252b41c3f3043be308dee7ce32be6f0e9b340b967902020a0eab1cb",
    "6ef59d99377edbcac8625e9626c044f78029cd567aefb5e25cc96c0d7ad615bd",
    "88bd95b7402d002e78b43dfbef559a030c05ae091c9cbfe41a2218cd71a67a57",
    "3f831b7593ec752a426d9078bee1f9ee497b8051f5e3c586b37957551d792610",
  ]),
});

export function acceptedCandidateReceiptDigests(agent: string): readonly string[] {
  return CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS[agent as CandidateManagedImageAgent] ?? [];
}
