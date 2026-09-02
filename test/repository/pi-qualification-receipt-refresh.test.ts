// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { missingPiQualificationReceiptRefreshes } from "../../scripts/checks/pi-qualification-receipt-refresh.mts";

const RECEIPTS = ["ci/pi-amd64.json", "ci/pi-arm64.json"];
const IMAGE_SOURCES = ["agents/pi/Dockerfile", "blueprint/"];

describe("Pi qualification receipt refresh", () => {
  it("requires both architecture receipts after an image input changes", () => {
    expect(
      missingPiQualificationReceiptRefreshes(
        ["blueprint/provider-profiles/example.yaml"],
        IMAGE_SOURCES,
        RECEIPTS,
      ),
    ).toEqual(RECEIPTS);
  });

  it("rejects a partial architecture receipt refresh", () => {
    expect(
      missingPiQualificationReceiptRefreshes(
        ["agents/pi/Dockerfile", RECEIPTS[0]!],
        IMAGE_SOURCES,
        RECEIPTS,
      ),
    ).toEqual([RECEIPTS[1]]);
  });

  it("accepts one cohort refresh for both architectures", () => {
    expect(
      missingPiQualificationReceiptRefreshes(
        ["blueprint/policy.yaml", ...RECEIPTS],
        IMAGE_SOURCES,
        RECEIPTS,
      ),
    ).toEqual([]);
  });

  it("does not require receipts for unrelated changes", () => {
    expect(
      missingPiQualificationReceiptRefreshes(["docs/reference/pi.mdx"], IMAGE_SOURCES, RECEIPTS),
    ).toEqual([]);
  });
});
