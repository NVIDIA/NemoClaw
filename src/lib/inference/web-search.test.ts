// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BRAVE_API_KEY_ENV,
  DEFAULT_WEB_SEARCH_PROVIDER,
  normalizeWebSearchConfig,
  parseExplicitWebSearchProvider,
  TAVILY_API_KEY_ENV,
  WEB_SEARCH_PROVIDER_ENV,
  webSearchConfigsEqual,
  webSearchEnvFor,
  webSearchProviderForConfig,
} from "./web-search";

describe("web-search module", () => {
  it("exports BRAVE_API_KEY_ENV constant", () => {
    expect(BRAVE_API_KEY_ENV).toBe("BRAVE_API_KEY");
  });

  it("exports Tavily and explicit-provider environment names", () => {
    expect(TAVILY_API_KEY_ENV).toBe("TAVILY_API_KEY");
    expect(WEB_SEARCH_PROVIDER_ENV).toBe("NEMOCLAW_WEB_SEARCH_PROVIDER");
  });

  it("maps providers to their credential environment names", () => {
    expect(webSearchEnvFor("brave")).toBe(BRAVE_API_KEY_ENV);
    expect(webSearchEnvFor("tavily")).toBe(TAVILY_API_KEY_ENV);
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
    expect(parseExplicitWebSearchProvider("off")).toEqual({
      specified: true,
      provider: null,
    });
    expect(() => parseExplicitWebSearchProvider("google")).toThrow(
      /Valid values: brave, tavily, none/,
    );
  });
});
