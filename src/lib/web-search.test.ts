// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildWebSearchConfigFragment,
  buildWebSearchDockerConfig,
  DEFAULT_GEMINI_WEB_SEARCH_MODEL,
  getWebSearchExposureWarningLines,
  normalizeWebSearchConfig,
} from "./web-search";

describe("web-search helpers", () => {
  it("emits empty docker config when web search is disabled", () => {
    expect(Buffer.from(buildWebSearchDockerConfig(null, null), "base64").toString("utf8")).toBe(
      "{}",
    );
  });

  it("emits empty docker config when fetchEnabled is false", () => {
    expect(
      Buffer.from(
        buildWebSearchDockerConfig({ provider: "brave", fetchEnabled: false }, null),
        "base64",
      ).toString("utf8"),
    ).toBe("{}");
  });

  it("normalizes legacy Brave configs without an explicit provider", () => {
    expect(normalizeWebSearchConfig({ fetchEnabled: true })).toEqual({
      provider: "brave",
      fetchEnabled: true,
    });
  });

  it("rejects persisted configs with unsupported providers", () => {
    expect(normalizeWebSearchConfig({ provider: "duckduckgo", fetchEnabled: true })).toBeNull();
  });

  it("builds the Brave Search OpenClaw config fragment", () => {
    expect(
      buildWebSearchConfigFragment({ provider: "brave", fetchEnabled: true }, "brv-x"),
    ).toEqual({
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "openshell:resolve:env:BRAVE_API_KEY",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
          },
          fetch: {
            enabled: true,
          },
        },
      },
    });
  });

  it("encodes Gemini Search docker config using the Google plugin entry", () => {
    const encoded = buildWebSearchDockerConfig({ provider: "gemini", fetchEnabled: true }, "g-x");
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      plugins: {
        entries: {
          google: {
            enabled: true,
            config: {
              webSearch: {
                model: DEFAULT_GEMINI_WEB_SEARCH_MODEL,
                apiKey: "openshell:resolve:env:GEMINI_API_KEY",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "gemini",
          },
          fetch: {
            enabled: true,
          },
        },
      },
    });
  });

  it("encodes Tavily Search docker config using the Tavily plugin entry", () => {
    const encoded = buildWebSearchDockerConfig(
      { provider: "tavily", fetchEnabled: true },
      "tvly-x",
    );
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      plugins: {
        entries: {
          tavily: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "openshell:resolve:env:TAVILY_API_KEY",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "tavily",
          },
          fetch: {
            enabled: true,
          },
        },
      },
    });
  });

  it("includes provider-specific exposure caveats in the warning text", () => {
    const warning = getWebSearchExposureWarningLines("tavily").join(" ");
    expect(warning).toContain("Tavily API key");
    expect(warning).toContain("sandbox OpenClaw config");
    expect(warning).toContain("OpenClaw agent will be able to resolve and read");
  });
});
