// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assertBraveConfig } from "../live/brave-search-helpers.ts";

const VERSIONED_PLACEHOLDER = "openshell:resolve:env:v12590243949725316565_BRAVE_API_KEY";
const UNVERSIONED_PLACEHOLDER = "openshell:resolve:env:BRAVE_API_KEY";

function openClawConfig(apiKey?: unknown, retiredApiKey?: unknown): string {
  return JSON.stringify({
    tools: {
      web: {
        search: { enabled: true, provider: "brave", apiKey: retiredApiKey },
      },
    },
    plugins: { entries: { brave: { config: { webSearch: { apiKey } } } } },
  });
}

describe("Brave Search E2E configuration assertion", () => {
  it.each([
    ["versioned", VERSIONED_PLACEHOLDER],
    ["unversioned", UNVERSIONED_PLACEHOLDER],
  ])("returns a %s credential placeholder from the Brave plugin configuration", (_case, value) => {
    expect(assertBraveConfig(openClawConfig(value))).toBe(value);
  });

  it.each([
    ["missing", undefined],
    ["raw", "test-raw-brave-key"],
    ["wrong-provider", "openshell:resolve:env:TAVILY_API_KEY"],
    ["noncanonical-prefix", "openshell:resolve:env:OTHER_BRAVE_API_KEY"],
    ["malformed-version-prefix", "openshell:resolve:env:vABC_BRAVE_API_KEY"],
  ])("rejects a %s Brave Search credential value", (_case, apiKey) => {
    expect(() => assertBraveConfig(openClawConfig(apiKey))).toThrow();
  });

  it("rejects a credential from the retired inline search configuration", () => {
    expect(() =>
      assertBraveConfig(openClawConfig(VERSIONED_PLACEHOLDER, "test-raw-brave-key")),
    ).toThrow();
  });

});
