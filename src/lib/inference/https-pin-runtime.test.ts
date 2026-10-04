// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildHttpsPinRouteBaseUrl,
  buildHttpsPinRouteLoopbackBaseUrl,
  computeHttpsPinRouteId,
  HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN,
  HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN,
  HTTPS_PIN_RUNTIME_ADAPTER_SANDBOX_HOST,
  isHttpsPinRuntimeEligible,
  parseHttpsPinRouteId,
  resolveHttpsPinCredentialHeader,
} from "./https-pin-runtime";

describe("isHttpsPinRuntimeEligible (#6141)", () => {
  it("is eligible for a DNS-backed HTTPS hostname", () => {
    expect(isHttpsPinRuntimeEligible("https://api.example.com/v1")).toBe(true);
  });

  it("is not eligible for HTTP, even with a DNS-backed hostname", () => {
    expect(isHttpsPinRuntimeEligible("http://api.example.com/v1")).toBe(false);
  });

  it("is not eligible for an HTTPS IPv4 literal", () => {
    expect(isHttpsPinRuntimeEligible("https://93.184.216.34/v1")).toBe(false);
  });

  it("is not eligible for an HTTPS IPv6 literal", () => {
    expect(isHttpsPinRuntimeEligible("https://[2001:db8::1]/v1")).toBe(false);
  });

  it("is not eligible for NemoClaw's own OpenShell-managed host alias", () => {
    expect(isHttpsPinRuntimeEligible("https://host.openshell.internal/v1")).toBe(false);
  });

  it("is not eligible for other OpenShell-managed aliases (inference.local, host.docker.internal)", () => {
    expect(isHttpsPinRuntimeEligible("https://inference.local/v1")).toBe(false);
    expect(isHttpsPinRuntimeEligible("https://host.docker.internal/v1")).toBe(false);
  });

  it("is not eligible for an unparseable URL", () => {
    expect(isHttpsPinRuntimeEligible("not-a-url")).toBe(false);
  });

  it("is not eligible for null/undefined/empty input", () => {
    expect(isHttpsPinRuntimeEligible(null)).toBe(false);
    expect(isHttpsPinRuntimeEligible(undefined)).toBe(false);
    expect(isHttpsPinRuntimeEligible("")).toBe(false);
  });

  it("accepts a URL instance the same as an equivalent string", () => {
    expect(isHttpsPinRuntimeEligible(new URL("https://api.example.com/v1"))).toBe(true);
  });
});

describe("resolveHttpsPinCredentialHeader (#6141)", () => {
  it("uses x-api-key for the anthropic provider type", () => {
    expect(resolveHttpsPinCredentialHeader("anthropic", "sk-ant-secret")).toEqual({
      name: "x-api-key",
      value: "sk-ant-secret",
    });
  });

  it("uses a Bearer authorization header for the openai provider type", () => {
    expect(resolveHttpsPinCredentialHeader("openai", "sk-secret")).toEqual({
      name: "authorization",
      value: "Bearer sk-secret",
    });
  });
});

describe("computeHttpsPinRouteId (#6141)", () => {
  it("is deterministic for the same (gateway, provider, endpoint) triple", () => {
    const a = computeHttpsPinRouteId("gw", "compatible-endpoint", "https://api.example.com/v1");
    const b = computeHttpsPinRouteId("gw", "compatible-endpoint", "https://api.example.com/v1");
    expect(a).toBe(b);
  });

  it("differs when any input differs", () => {
    const base = computeHttpsPinRouteId("gw", "compatible-endpoint", "https://api.example.com/v1");
    expect(
      computeHttpsPinRouteId("other-gw", "compatible-endpoint", "https://api.example.com/v1"),
    ).not.toBe(base);
    expect(
      computeHttpsPinRouteId("gw", "compatible-anthropic-endpoint", "https://api.example.com/v1"),
    ).not.toBe(base);
    expect(
      computeHttpsPinRouteId("gw", "compatible-endpoint", "https://api.other.com/v1"),
    ).not.toBe(base);
  });

  it("keeps component boundaries unambiguous", () => {
    expect(computeHttpsPinRouteId("a b", "c", "https://example.com/v1")).not.toBe(
      computeHttpsPinRouteId("a", "b c", "https://example.com/v1"),
    );
  });

  it("never contains the endpoint hostname or path (safe to persist and log)", () => {
    const id = computeHttpsPinRouteId(
      "gw",
      "compatible-endpoint",
      "https://api.example.com/some/secret/path",
    );
    expect(id).not.toContain("api.example.com");
    expect(id).not.toContain("secret");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildHttpsPinRouteBaseUrl / buildHttpsPinRouteLoopbackBaseUrl (#6141)", () => {
  it("builds an opaque sandbox-facing route with no source URL material", () => {
    const url = buildHttpsPinRouteBaseUrl("routeid1234567890abc");
    expect(url).toBe(`${HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN}/route/routeid1234567890abc`);
  });

  it("builds the host-side loopback equivalent for the same route", () => {
    const url = buildHttpsPinRouteLoopbackBaseUrl("routeid1234567890abc");
    expect(url).toBe(`${HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN}/route/routeid1234567890abc`);
  });

  it("parses only the exact opaque route base", () => {
    const id = "a".repeat(64);
    expect(parseHttpsPinRouteId(buildHttpsPinRouteBaseUrl(id))).toBe(id);
    expect(
      parseHttpsPinRouteId(`http://${HTTPS_PIN_RUNTIME_ADAPTER_SANDBOX_HOST}:22438/route/${id}`),
    ).toBe(id);
    expect(parseHttpsPinRouteId(`${buildHttpsPinRouteBaseUrl(id)}/v1`)).toBeNull();
    expect(parseHttpsPinRouteId(`${buildHttpsPinRouteBaseUrl(id)}?secret=1`)).toBeNull();
    expect(parseHttpsPinRouteId(`https://example.test/route/${id}`)).toBeNull();
  });
});
