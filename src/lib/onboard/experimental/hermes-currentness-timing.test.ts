// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HermesPortableCurrentnessTimingEvidence } from "./hermes-portable-lifecycle";

const NUMERIC_FIELDS = [
  "receiptReadMs",
  "receiptReadCount",
  "socketAuthorityMs",
  "socketAuthorityCount",
  "openshellExecutableMs",
  "openshellExecutableCount",
  "podmanExecutableMs",
  "podmanExecutableCount",
  "podmanPathResolutionMs",
  "podmanPathResolutionCount",
  "podmanCanonicalRealpathMs",
  "podmanCanonicalRealpathCount",
  "podmanDirectoryChainMs",
  "podmanDirectoryChainCount",
  "podmanExecutableMetadataMs",
  "podmanExecutableMetadataCount",
  "podmanContentReadMs",
  "podmanContentReadCount",
  "podmanContentHashMs",
  "podmanContentHashCount",
  "podmanAuthorityCompareMs",
  "podmanAuthorityCompareCount",
  "containerInspectMs",
  "containerInspectCount",
  "transactionCompareMs",
  "transactionCompareCount",
] as const satisfies readonly (keyof HermesPortableCurrentnessTimingEvidence)[];

describe("Hermes currentness timing evidence", () => {
  it("keeps the public evidence schema numeric and credential-free", () => {
    const evidence = Object.fromEntries(NUMERIC_FIELDS.map((field, index) => [field, index]));

    expect(Object.keys(evidence).sort()).toEqual([...NUMERIC_FIELDS].sort());
    expect(Object.values(evidence).every(Number.isFinite)).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(
      /argv|authorization|bearer|endpoint|env|stderr|stdout|token/iu,
    );
  });

  it("allows a timing callback to reject evidence without exposing operation data", () => {
    const callback = vi.fn((_evidence: HermesPortableCurrentnessTimingEvidence) => {
      throw new Error("timing sink failed");
    });
    const evidence = Object.fromEntries(
      NUMERIC_FIELDS.map((field) => [field, 0]),
    ) as unknown as HermesPortableCurrentnessTimingEvidence;

    expect(() => callback(evidence)).toThrow("timing sink failed");
    expect(callback).toHaveBeenCalledWith(evidence);
  });
});
