// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN,
  HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN,
  buildHttpsPinRouteBaseUrl,
  buildHttpsPinRouteLoopbackBaseUrl,
  computeHttpsPinRouteId,
  isHttpsPinRuntimeEligible,
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

  it("never contains the endpoint hostname or path (safe to persist and log)", () => {
    const id = computeHttpsPinRouteId(
      "gw",
      "compatible-endpoint",
      "https://api.example.com/some/secret/path",
    );
    expect(id).not.toContain("api.example.com");
    expect(id).not.toContain("secret");
    expect(id).toMatch(/^[0-9a-f]{20}$/);
  });
});

describe("buildHttpsPinRouteBaseUrl / buildHttpsPinRouteLoopbackBaseUrl (#6141)", () => {
  it("builds the sandbox-facing origin with the route id and the endpoint's path preserved", () => {
    const url = buildHttpsPinRouteBaseUrl("routeid1234567890abc", "https://api.example.com/v1/");
    expect(url).toBe(`${HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN}/route/routeid1234567890abc/v1`);
  });

  it("builds the host-side loopback equivalent for the same route", () => {
    const url = buildHttpsPinRouteLoopbackBaseUrl(
      "routeid1234567890abc",
      "https://api.example.com/v1/",
    );
    expect(url).toBe(`${HTTPS_PIN_RUNTIME_ADAPTER_LOOPBACK_ORIGIN}/route/routeid1234567890abc/v1`);
  });

  it("omits the suffix entirely for a root-path endpoint", () => {
    expect(buildHttpsPinRouteBaseUrl("routeid1234567890abc", "https://api.example.com/")).toBe(
      `${HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN}/route/routeid1234567890abc`,
    );
  });

  it("does not leak the real hostname into either base URL", () => {
    const sandboxUrl = buildHttpsPinRouteBaseUrl(
      "routeid1234567890abc",
      "https://api.example.com/v1",
    );
    const loopbackUrl = buildHttpsPinRouteLoopbackBaseUrl(
      "routeid1234567890abc",
      "https://api.example.com/v1",
    );
    expect(sandboxUrl).not.toContain("api.example.com");
    expect(loopbackUrl).not.toContain("api.example.com");
  });
});
