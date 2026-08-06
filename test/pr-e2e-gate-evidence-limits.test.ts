// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { evidenceEntryLimit } from "../tools/e2e/pr-e2e-gate.mts";

describe("PR E2E gate evidence traversal limits", () => {
  it("scales the entry budget with expected signals under a hard ceiling", () => {
    expect(evidenceEntryLimit(1)).toBe(1_280);
    expect(evidenceEntryLimit(28)).toBe(8_192);
    expect(evidenceEntryLimit(1_000)).toBe(16_384);
    expect(() => evidenceEntryLimit(0)).toThrow(/signal count is invalid/u);
    expect(() => evidenceEntryLimit(Number.NaN)).toThrow(/signal count is invalid/u);
  });
});
