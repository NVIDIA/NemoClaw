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

type RewrittenOptions = http.RequestOptions & {
  protocol?: string;
  servername?: string;
  checkServerIdentity?: unknown;
  socketPath?: string;
  localAddress?: string;
  lookup?: unknown;
  family?: number;
  hints?: number;
};

function loadWrapper() {
  // Clear cached copies so the IIFE re-runs and reads our test env.
  delete require.cache[FIX_PATH];
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
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("http_proxy", "");
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

  it("strips Host / Proxy-* / RFC-7230-§6.1 hop-by-hop headers; preserves target-intent headers", () => {
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/foo",
      headers: {
        Host: `${PROXY_HOST}:3128`,
        "Proxy-Authorization": "Basic dXNlcjpwYXNz",
        "Proxy-Connection": "keep-alive",
        "Proxy-Authenticate": "Basic realm=p",
        Connection: "close",
        "Keep-Alive": "timeout=5",
        TE: "trailers",
        Trailer: "Expires",
        "Transfer-Encoding": "chunked",
        Upgrade: "h2c",
        Authorization: "Bearer real-target-token",
        "Content-Type": "application/json",
      },
    });

    expect(captured).not.toBeNull();
    const headers = (captured?.headers ?? {}) as Record<string, string>;
    // RFC 7230 §6.1 hop-by-hop set + proxy-pointing Host all stripped.
    for (const k of [
      "Host",
      "host",
      "Proxy-Authorization",
      "Proxy-Connection",
      "Proxy-Authenticate",
      "Connection",
      "Keep-Alive",
      "TE",
      "Trailer",
      "Transfer-Encoding",
      "Upgrade",
    ]) {
      expect(headers[k]).toBeUndefined();
    }
    // Target intent (caller's Authorization to the upstream and content
    // negotiation) must survive.
    expect(headers.Authorization).toBe("Bearer real-target-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("strips tokens named in the Connection header (RFC 7230 §6.1 transitive hop-by-hop)", () => {
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/foo",
      headers: {
        Connection: "close, X-Hop-Token, X-Other-Hop",
        "X-Hop-Token": "leaks-without-strip",
        "X-Other-Hop": "also-leaks",
        "X-Keep-Me": "survives",
      },
    });

    expect(captured).not.toBeNull();
    const headers = (captured?.headers ?? {}) as Record<string, string>;
    expect(headers.Connection).toBeUndefined();
    expect(headers["X-Hop-Token"]).toBeUndefined();
    expect(headers["X-Other-Hop"]).toBeUndefined();
    expect(headers["X-Keep-Me"]).toBe("survives");
  });

  it("preserves signal, timeout, and TLS material the caller supplied", () => {
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

  it("strips proxy-hop TLS identity fields (servername, checkServerIdentity)", () => {
    const customCheck = (): undefined => undefined;
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/foo",
      servername: PROXY_HOST,
      checkServerIdentity: customCheck,
      headers: {},
    } as http.RequestOptions & { servername?: string; checkServerIdentity?: unknown });

    expect(captured).not.toBeNull();
    expect("servername" in (captured ?? {})).toBe(false);
    expect("checkServerIdentity" in (captured ?? {})).toBe(false);
  });

  it("strips proxy-hop transport hints (socketPath, localAddress, lookup, family, hints)", () => {
    http.request({
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://api.deepinfra.com/v1/foo",
      socketPath: "/var/run/cntlm.sock",
      localAddress: "10.0.0.42",
      lookup: () => undefined,
      family: 4,
      hints: 0,
      headers: {},
    } as http.RequestOptions & { socketPath?: string; localAddress?: string; lookup?: unknown; family?: number; hints?: number });

    expect(captured).not.toBeNull();
    for (const k of ["socketPath", "localAddress", "lookup", "family", "hints"]) {
      expect(k in (captured ?? {})).toBe(false);
    }
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

describe("http-proxy-fix bisect: control case for the bug class", () => {
  // Pins the regression independent of the wrapper itself. Constructs the
  // exact rewrite shape the *broken* pre-fix wrapper produced (no agent /
  // auth strip, hop-by-hop headers preserved) and asserts that
  // https.request rejects it. If a future maintainer reverts the strip,
  // this test still fails — the bug class doesn't depend on the wrapper.
  // Combined with the rewrite tests above (which prove the wrapper does
  // strip), this gives a two-sided proof of correctness without storing
  // a copy of the broken wrapper in the repo.
  it("https.request throws TypeError when a forward-proxy http.Agent rides into rewritten options (Node 22 surface)", () => {
    const proxyAgent = new http.Agent({ keepAlive: false });
    const callerOptions = {
      hostname: PROXY_HOST,
      port: 3128,
      path: "https://example.invalid/v1/x",
      method: "POST",
      agent: proxyAgent,
      auth: "proxyuser:proxypass",
      headers: {
        Host: `${PROXY_HOST}:3128`,
        "Proxy-Authorization": "Basic x",
      },
    };

    const target = new URL(callerOptions.path);
    // Reproduce the broken pre-fix wrapper's rewrite verbatim: shallow
    // Object.assign with no field strips and no header sanitization.
    const broken: http.RequestOptions = Object.assign({}, callerOptions, {
      method: callerOptions.method || "GET",
      hostname: target.hostname,
      host: target.hostname,
      port: Number.parseInt(target.port, 10) || 443,
      path: target.pathname + target.search,
      protocol: "https:",
    } as http.RequestOptions);

    // Node 22's _http_agent.js validates `agent.protocol` and throws
    // synchronously. Older Node falls through and fails the TLS handshake
    // instead — same root cause, different surface error. The wrapper's
    // job is to make sure neither path is reachable.
    expect(() => https.request(broken)).toThrow(/Protocol "https:" not supported/);
  });
});
