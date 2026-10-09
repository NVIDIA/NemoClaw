// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isValidDashboardExternalUrl,
  rebindLoopbackDashboardUrlPort,
  resolveExternalDashboardUrl,
  resolveExternalDashboardUrlForPort,
} from "./url";

describe("rebindLoopbackDashboardUrlPort", () => {
  it.each([
    ["http://127.0.0.2:18789/dashboard", "http://127.0.0.2:29443/dashboard"],
    ["http://localhost:18789/dashboard", "http://localhost:29443/dashboard"],
    ["https://secure-link.example/dashboard", "https://secure-link.example/dashboard"],
  ] as const)("applies the loopback port policy to %s", (input, expected) => {
    expect(rebindLoopbackDashboardUrlPort(input, 29_443)).toBe(expected);
  });
});

describe("resolveExternalDashboardUrl (#11439)", () => {
  it("returns a genuine external origin, trimming a trailing slash", () => {
    expect(resolveExternalDashboardUrl("https://dash.example.com:18789/")).toBe(
      "https://dash.example.com:18789",
    );
    expect(resolveExternalDashboardUrl("https://dash.example.com:18789")).toBe(
      "https://dash.example.com:18789",
    );
  });

  it("returns null for loopback dashboard URLs (loopback reported from dashboardPort)", () => {
    expect(resolveExternalDashboardUrl("http://127.0.0.1:18789")).toBeNull();
    expect(resolveExternalDashboardUrl("http://localhost:18789/")).toBeNull();
  });

  it("returns null for empty or malformed input", () => {
    expect(resolveExternalDashboardUrl(null)).toBeNull();
    expect(resolveExternalDashboardUrl(undefined)).toBeNull();
    expect(resolveExternalDashboardUrl("")).toBeNull();
    expect(resolveExternalDashboardUrl("not a url")).toBeNull();
  });

  it("returns null for non-http(s), credentialed, or over-long origins so a persisted value can be read back", () => {
    // These would otherwise be rejected at registry read time and brick list/status.
    expect(resolveExternalDashboardUrl("ws://proxy.example.com:18789")).toBeNull();
    expect(resolveExternalDashboardUrl("ftp://proxy.example.com:18789")).toBeNull();
    expect(resolveExternalDashboardUrl("https://user:pass@dash.example.com:18789")).toBeNull();
    expect(resolveExternalDashboardUrl(`https://dash.example.com/${"a".repeat(3000)}`)).toBeNull();
  });
});

describe("isValidDashboardExternalUrl shared write/read predicate (#11439)", () => {
  it("accepts absolute http(s) origins without credentials", () => {
    expect(isValidDashboardExternalUrl("https://dash.example.com:18789")).toBe(true);
    expect(isValidDashboardExternalUrl("http://dash.example.com/path")).toBe(true);
  });

  it("rejects non-http(s), credentialed, control-char, and over-long values", () => {
    expect(isValidDashboardExternalUrl("ws://dash.example.com:18789")).toBe(false);
    expect(isValidDashboardExternalUrl("https://user:pass@dash.example.com")).toBe(false);
    expect(isValidDashboardExternalUrl("https://dash.example.com/\u0000")).toBe(false);
    expect(isValidDashboardExternalUrl(`https://dash.example.com/${"a".repeat(3000)}`)).toBe(false);
    expect(isValidDashboardExternalUrl("")).toBe(false);
    expect(isValidDashboardExternalUrl("dash.example.com:18789")).toBe(false);
  });
});

describe("resolveExternalDashboardUrlForPort (#11439)", () => {
  it("rebinds the CHAT_UI_URL origin to the effective dashboard port", () => {
    expect(resolveExternalDashboardUrlForPort("https://dash.example.com:18789", 18790)).toBe(
      "https://dash.example.com:18790",
    );
  });

  it("adds a scheme to a bare host:port origin before rebinding", () => {
    expect(resolveExternalDashboardUrlForPort("dash.example.com:18789", 18790)).toBe(
      "http://dash.example.com:18790",
    );
  });

  it("returns null for a loopback or missing origin", () => {
    expect(resolveExternalDashboardUrlForPort("http://127.0.0.1:18789", 18790)).toBeNull();
    expect(resolveExternalDashboardUrlForPort(null, 18790)).toBeNull();
    expect(resolveExternalDashboardUrlForPort("", 18790)).toBeNull();
  });
});
