// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { tierIncludesPolicyPreset } from "./tiers";

describe("tierIncludesPolicyPreset", () => {
  it("checks an already-resolved tier without loading tier configuration", () => {
    expect(tierIncludesPolicyPreset({ presets: [{ name: "BrAvE" }] }, " BRAVE ")).toBe(true);
  });

  it("rejects an empty preset name and a missing or empty membership", () => {
    expect(tierIncludesPolicyPreset({ presets: [] }, "brave")).toBe(false);
    expect(tierIncludesPolicyPreset({ presets: [{ name: "brave" }] }, " ")).toBe(false);
    expect(tierIncludesPolicyPreset(null, "brave")).toBe(false);
  });
});
