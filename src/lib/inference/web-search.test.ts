// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BRAVE_API_KEY_ENV,
  DEFAULT_WEB_SEARCH_PROVIDER,
  FIRECRAWL_API_KEY_ENV,
  isWebSearchProvider,
  normalizeWebSearchConfig,
  parseExplicitWebSearchProvider,
  TAVILY_API_KEY_ENV,
  WEB_SEARCH_PROVIDER_ENV,
  webSearchConfigsEqual,
  webSearchEnvFor,
  webSearchLabelFor,
  webSearchProviderForConfig,
  webSearchProviderForEnvKey,
} from "./web-search";

describe("web-search module", () => {
  it("exports BRAVE_API_KEY_ENV constant", () => {
    expect(BRAVE_API_KEY_ENV).toBe("BRAVE_API_KEY");
  });

  it("exports Tavily, Firecrawl, and explicit-provider environment names", () => {
    expect(TAVILY_API_KEY_ENV).toBe("TAVILY_API_KEY");
    expect(FIRECRAWL_API_KEY_ENV).toBe("FIRECRAWL_API_KEY");
    expect(WEB_SEARCH_PROVIDER_ENV).toBe("NEMOCLAW_WEB_SEARCH_PROVIDER");
  });

  it("maps providers to their credential environment names", () => {
    expect(webSearchEnvFor("brave")).toBe(BRAVE_API_KEY_ENV);
    expect(webSearchEnvFor("tavily")).toBe(TAVILY_API_KEY_ENV);
    expect(webSearchEnvFor("firecrawl")).toBe(FIRECRAWL_API_KEY_ENV);
  });

  it("maps providers to display labels and back from env keys", () => {
    expect(webSearchLabelFor("brave")).toBe("Brave Search");
    expect(webSearchLabelFor("tavily")).toBe("Tavily Search");
    expect(webSearchLabelFor("firecrawl")).toBe("Firecrawl Search");
    expect(webSearchProviderForEnvKey(FIRECRAWL_API_KEY_ENV)).toBe("firecrawl");
    expect(webSearchProviderForEnvKey("UNKNOWN_KEY")).toBeNull();
  });

  it("recognizes firecrawl as a valid provider", () => {
    expect(isWebSearchProvider("firecrawl")).toBe(true);
    expect(isWebSearchProvider("google")).toBe(false);
  });

  it("defaults legacy provider-less configs to Brave", () => {
    expect(DEFAULT_WEB_SEARCH_PROVIDER).toBe("brave");
    expect(webSearchProviderForConfig({})).toBe("brave");
    expect(normalizeWebSearchConfig({ fetchEnabled: true })).toEqual({
      fetchEnabled: true,
      provider: "brave",
    });
  });

  it("normalizes and compares provider-aware enabled state", () => {
    expect(normalizeWebSearchConfig({ fetchEnabled: true, provider: "tavily" })).toEqual({
      fetchEnabled: true,
      provider: "tavily",
    });
    expect(normalizeWebSearchConfig({ fetchEnabled: false, provider: "tavily" })).toBeNull();
    expect(
      normalizeWebSearchConfig({ fetchEnabled: true, provider: "invalid" as never }),
    ).toBeNull();
    expect(
      webSearchConfigsEqual({ fetchEnabled: true }, { fetchEnabled: true, provider: "brave" }),
    ).toBe(true);
    expect(
      webSearchConfigsEqual(
        { fetchEnabled: true, provider: "brave" },
        { fetchEnabled: true, provider: "tavily" },
      ),
    ).toBe(false);
  });

  it("parses explicit provider selection and disable aliases", () => {
    expect(parseExplicitWebSearchProvider(undefined)).toEqual({
      specified: false,
      provider: null,
    });
    expect(parseExplicitWebSearchProvider(" TAVILY ")).toEqual({
      specified: true,
      provider: "tavily",
    });
    expect(parseExplicitWebSearchProvider(" FIRECRAWL ")).toEqual({
      specified: true,
      provider: "firecrawl",
    });
    expect(parseExplicitWebSearchProvider("off")).toEqual({
      specified: true,
      provider: null,
    });
    expect(() => parseExplicitWebSearchProvider("google")).toThrow(
      /Valid values: brave, tavily, firecrawl, none/,
    );
  });
});
