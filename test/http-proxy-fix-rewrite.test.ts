// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behavioural tests for the FORWARD-mode → CONNECT-tunnel rewrite in
// nemoclaw-blueprint/scripts/http-proxy-fix.js.
//
// The wrapper is a NODE_OPTIONS=--require preload installed at sandbox boot.
// In-process we exercise it by clearing the require cache, setting the env
// the wrapper inspects, requiring the file (its IIFE patches http.request),
// then calling http.request and asserting what the rewritten https.request
// receives. https.request is stubbed via vi.spyOn — http.request inside the
// wrapper grabs https with a fresh require('https') so the spy takes effect.
//
// These tests pin the regression deepinfra users hit on 0.0.24: the wrapper
// shallow-copied options, dragging the forward-proxy http.Agent and proxy
// basic-auth into the rewritten https.request and surfacing as
// "LLM request failed: network connection error" against non-NVIDIA
// upstreams. See the canonical wrapper for the per-field rationale.

import http from "node:http";
import https from "node:https";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIX_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "scripts",
  "http-proxy-fix.js",
);

const PROXY_URL = "http://10.200.0.1:3128";
const PROXY_HOST = "10.200.0.1";

type RewrittenOptions = http.RequestOptions & { protocol?: string };

function loadWrapper() {
  // Clear cached copies so the IIFE re-runs and reads our test env.
  delete require.cache[FIX_PATH];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(FIX_PATH);
}

describe("http-proxy-fix rewrite (deepinfra-style failure, follow-up to #2344)", () => {
  let origHttpRequest: typeof http.request;
  let httpsSpy: ReturnType<typeof vi.spyOn>;
  let captured: RewrittenOptions | null;

  beforeEach(() => {
    origHttpRequest = http.request;
    captured = null;
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("HTTPS_PROXY", PROXY_URL);
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    loadWrapper();
    // Wrapper grabs `https` via a fresh require inside the rewrite branch,
    // so spying on https.request after the wrapper installs is fine.
    httpsSpy = vi
      .spyOn(https, "request")
      // @ts-expect-error stubbed return — the wrapper just hands it back.
      .mockImplementation((options: RewrittenOptions) => {
        captured = options;
        return { on: () => undefined, end: () => undefined } as unknown as http.ClientRequest;
      });
  });

  afterEach(() => {
    httpsSpy.mockRestore();
    http.request = origHttpRequest;
    vi.unstubAllEnvs();
  });

  it("rewrites FORWARD-mode http.request to https.request against the target", () => {
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/openai/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(captured).not.toBeNull();
    expect(captured?.hostname).toBe("api.deepinfra.com");
    expect(captured?.host).toBe("api.deepinfra.com");
    expect(captured?.port).toBe(443);
    expect(captured?.path).toBe("/v1/openai/chat/completions");
    expect(captured?.protocol).toBe("https:");
    expect(captured?.method).toBe("POST");
  });

  it("strips a forward-proxy http.Agent that cannot speak TLS (root cause of deepinfra 'Connection error')", () => {
    const proxyAgent = new http.Agent({ keepAlive: true });
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/foo",
      agent: proxyAgent,
      headers: {},
    });

    expect(captured).not.toBeNull();
    expect("agent" in (captured ?? {})).toBe(false);
  });

  it("strips proxy-hop basic auth so it is not Basic-auth'd to the target", () => {
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/foo",
      auth: "proxyuser:proxypass",
      headers: {},
    });

    expect(captured).not.toBeNull();
    expect("auth" in (captured ?? {})).toBe(false);
  });

  it("strips Host / Proxy-* headers so Node regenerates Host for the target", () => {
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/foo",
      headers: {
        Host: `${PROXY_HOST}:3128`,
        "Proxy-Authorization": "Basic dXNlcjpwYXNz",
        "Proxy-Connection": "keep-alive",
        Authorization: "Bearer real-target-token",
        "Content-Type": "application/json",
      },
    });

    expect(captured).not.toBeNull();
    const headers = (captured?.headers ?? {}) as Record<string, string>;
    expect(headers.Host).toBeUndefined();
    expect(headers.host).toBeUndefined();
    expect(headers["Proxy-Authorization"]).toBeUndefined();
    expect(headers["Proxy-Connection"]).toBeUndefined();
    // Target Authorization / Content-Type must survive — those are caller
    // intent, not proxy-hop metadata.
    expect(headers.Authorization).toBe("Bearer real-target-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("preserves signal, timeout, and TLS fields the caller supplied", () => {
    const ac = new AbortController();
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/foo",
      signal: ac.signal,
      timeout: 12345,
      rejectUnauthorized: false,
      headers: {},
    } as http.RequestOptions);

    expect(captured).not.toBeNull();
    expect(captured?.signal).toBe(ac.signal);
    expect(captured?.timeout).toBe(12345);
    expect((captured as { rejectUnauthorized?: boolean })?.rejectUnauthorized).toBe(false);
  });

  it("uses the explicit target port when one is present in the URL", () => {
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://internal.example.com:8443/v1/x",
      headers: {},
    });

    expect(captured).not.toBeNull();
    expect(captured?.port).toBe("8443");
    expect(captured?.hostname).toBe("internal.example.com");
  });

  it("passes plain non-FORWARD requests through untouched", () => {
    // Abort immediately so the test does not attempt a real socket
    // connection to a port nothing is listening on.
    const ac = new AbortController();
    ac.abort();
    const req = http.request({
      hostname: "127.0.0.1",
      port: 4242,
      path: "/health",
      headers: {},
      signal: ac.signal,
    } as http.RequestOptions);
    req.on("error", () => undefined);
    req.destroy();

    expect(httpsSpy).not.toHaveBeenCalled();
  });
});
