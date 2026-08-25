// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

const BASE_ENV = baseOpenClawGenerationEnv();

function buildWebSearchConfig(env: Record<string, string>) {
  return buildConfig({ ...BASE_ENV, ...env });
}

describe("generate-openclaw-config.mts: Tavily web search", () => {
  it("emits the bundled plugin's credential path", () => {
    const config = buildWebSearchConfig({
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
    });

    expect(config.tools?.web?.search).toEqual({ enabled: true, provider: "tavily" });
    expect(config.plugins?.entries?.tavily).toEqual({
      enabled: true,
      config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
    });
    expect(config.plugins?.entries?.brave).toBeUndefined();
    expect(config.plugins?.allow).toContain("tavily");
    expect(config.tools?.web?.search?.apiKey).toBeUndefined();
    expect(config.tools?.web?.fetch).toEqual({ enabled: true, useTrustedEnvProxy: true });
  });

  it("allows the enabled Brave plugin (#8975)", () => {
    const config = buildWebSearchConfig({
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "brave",
    });

    expect(config.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: { webSearch: { apiKey: "openshell:resolve:env:BRAVE_API_KEY" } },
    });
    expect(config.plugins?.allow).toContain("brave");
    expect(config.plugins?.allow).not.toContain("tavily");
  });

  it("rejects an unknown provider instead of silently selecting one", () => {
    expect(() =>
      buildWebSearchConfig({
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "unknown",
      }),
    ).toThrow('NEMOCLAW_WEB_SEARCH_PROVIDER must be "brave" or "tavily"');
  });
});
