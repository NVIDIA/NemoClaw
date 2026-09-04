// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { shouldEnableWebSearch } from "./brave-provider-profile";

describe("shouldEnableWebSearch", () => {
  it("returns false for null/undefined web search config", () => {
    expect(shouldEnableWebSearch(null)).toBe(false);
    expect(shouldEnableWebSearch(undefined)).toBe(false);
  });

  it("returns false when fetchEnabled is missing or falsy", () => {
    // Regression for #3626: a `{ fetchEnabled: false }` config previously
    // tripped `if (webSearchConfig)` in createSandbox and pushed a Brave
    // provider/token plus the BRAVE_API_KEY abort even though the runtime
    // gate downstream is `fetchEnabled`.
    expect(shouldEnableWebSearch({})).toBe(false);
    expect(shouldEnableWebSearch({ fetchEnabled: false })).toBe(false);
    expect(shouldEnableWebSearch({ fetchEnabled: null })).toBe(false);
  });

  it("returns true only when fetchEnabled is explicitly true", () => {
    expect(shouldEnableWebSearch({ fetchEnabled: true })).toBe(true);
  });
});
