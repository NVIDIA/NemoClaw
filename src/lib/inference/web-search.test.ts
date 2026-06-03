// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BRAVE_API_KEY_ENV,
  isWebSearchEnabled,
  isWebSearchProvider,
  normalizeWebSearchProvider,
} from "./web-search";

describe("web-search module", () => {
  it("exports BRAVE_API_KEY_ENV constant", () => {
    expect(BRAVE_API_KEY_ENV).toBe("BRAVE_API_KEY");
  });
});

describe("isWebSearchEnabled", () => {
  it("returns false for null or undefined", () => {
    expect(isWebSearchEnabled(null)).toBe(false);
    expect(isWebSearchEnabled(undefined)).toBe(false);
  });

  it("returns false when fetchEnabled is not literally true", () => {
    expect(isWebSearchEnabled({})).toBe(false);
    expect(isWebSearchEnabled({ fetchEnabled: false })).toBe(false);
    expect(isWebSearchEnabled({ fetchEnabled: null })).toBe(false);
  });

  it("returns true regardless of provider when fetchEnabled is true", () => {
    expect(isWebSearchEnabled({ fetchEnabled: true })).toBe(true);
    expect(
      isWebSearchEnabled({ fetchEnabled: true, provider: "duckduckgo" } as {
        fetchEnabled: boolean;
      }),
    ).toBe(true);
  });
});

describe("isWebSearchProvider", () => {
  it("accepts the known allowlist values", () => {
    expect(isWebSearchProvider("brave")).toBe(true);
    expect(isWebSearchProvider("duckduckgo")).toBe(true);
  });

  it("rejects unknown values, including realistic typos and rogue inputs", () => {
    expect(isWebSearchProvider("bing")).toBe(false);
    expect(isWebSearchProvider("Brave")).toBe(false);
    expect(isWebSearchProvider("")).toBe(false);
    expect(isWebSearchProvider(null)).toBe(false);
    expect(isWebSearchProvider(undefined)).toBe(false);
    expect(isWebSearchProvider(42)).toBe(false);
  });
});

describe("normalizeWebSearchProvider", () => {
  it("returns the value when valid", () => {
    expect(normalizeWebSearchProvider("brave")).toBe("brave");
    expect(normalizeWebSearchProvider("duckduckgo")).toBe("duckduckgo");
  });

  it("falls back to the default provider for invalid values", () => {
    expect(normalizeWebSearchProvider("bing")).toBe("brave");
    expect(normalizeWebSearchProvider("")).toBe("brave");
    expect(normalizeWebSearchProvider(null)).toBe("brave");
    expect(normalizeWebSearchProvider(undefined)).toBe("brave");
  });
});
