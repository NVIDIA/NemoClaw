// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assertBraveConfig } from "../live/brave-search-helpers.ts";

const PLACEHOLDER = "openshell:resolve:env:v12590243949725316565_BRAVE_API_KEY";

function openClawConfig(apiKey?: unknown): string {
  return JSON.stringify({
    tools: { web: { search: { enabled: true, provider: "brave" } } },
    plugins: { entries: { brave: { config: { webSearch: { apiKey } } } } },
  });
}

describe("Brave Search E2E configuration assertion", () => {
  it("returns the credential placeholder from the current OpenClaw plugin configuration", () => {
    expect(assertBraveConfig(openClawConfig(PLACEHOLDER))).toBe(PLACEHOLDER);
  });

  it.each([
    ["missing", undefined],
    ["raw", "test-raw-brave-key"],
    ["wrong-provider", "openshell:resolve:env:TAVILY_API_KEY"],
  ])("rejects a %s Brave Search credential value", (_case, apiKey) => {
    expect(() => assertBraveConfig(openClawConfig(apiKey))).toThrow();
  });
});
