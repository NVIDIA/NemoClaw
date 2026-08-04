// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildManagedTransportFailure,
  captureErrorBody,
  classifyManagedTransportPhase,
  collectSafeResponseHeaders,
  describeErrorCauseChain,
  formatManagedTransportFailure,
  newManagedTransportTraceId,
} from "./managed-transport.js";

function errorWith(fields: Record<string, unknown>, cause?: unknown): Error {
  const error = new Error(String(fields.message ?? "failed"));
  Object.assign(error, fields);
  if (cause !== undefined) Object.assign(error, { cause });
  return error;
}

describe("classifyManagedTransportPhase", () => {
  it("reports a policy denial ahead of the transport codes that accompany it (#7957)", () => {
    const error = errorWith(
      { message: "fetch failed" },
      errorWith({ code: "ECONNRESET", message: "CONNECT example.com:443 not permitted by policy" }),
    );

    expect(classifyManagedTransportPhase({ error })).toBe("policy");
  });

  it("treats a rejected CONNECT status as policy rather than a tunnel fault (#7957)", () => {
    const error = errorWith({ message: "CONNECT tunnel failed, response 403" });

    expect(classifyManagedTransportPhase({ error })).toBe("policy");
  });

  it("separates a failed tunnel from a denied one (#7957)", () => {
    const error = errorWith({ message: "CONNECT tunnel failed, response 502" });

    expect(classifyManagedTransportPhase({ error })).toBe("connect");
  });

  it("classifies certificate faults as the TLS phase (#7957)", () => {
    const error = errorWith(
      { message: "fetch failed" },
      errorWith({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    );

    expect(classifyManagedTransportPhase({ error })).toBe("tls");
  });

  it("classifies upstream connection refusal as the application connect phase (#7957)", () => {
    const error = errorWith({ message: "fetch failed" }, errorWith({ code: "ECONNREFUSED" }));

    expect(classifyManagedTransportPhase({ error })).toBe("app_connect");
  });

  it("separates a headers timeout from a body timeout (#7957)", () => {
    expect(
      classifyManagedTransportPhase({ error: errorWith({ code: "UND_ERR_HEADERS_TIMEOUT" }) }),
    ).toBe("response_headers");
    expect(
      classifyManagedTransportPhase({ error: errorWith({ code: "UND_ERR_BODY_TIMEOUT" }) }),
    ).toBe("response_stream");
  });

  it("uses a received status to place the failure at response headers (#7957)", () => {
    expect(classifyManagedTransportPhase({ httpStatus: 503 })).toBe("response_headers");
  });

  it("places a reset after streaming began in the response stream (#7957)", () => {
    const outcome = {
      error: errorWith({ code: "UND_ERR_SOCKET" }),
      httpStatus: 200,
      responseStreamStarted: true,
    };

    expect(classifyManagedTransportPhase(outcome)).toBe("response_stream");
  });

  it("falls back to the request phase when nothing else matches (#7957)", () => {
    expect(classifyManagedTransportPhase({ error: errorWith({ code: "UND_ERR_ABORTED" }) })).toBe(
      "request",
    );
  });
});

describe("describeErrorCauseChain", () => {
  it("keeps the safe transport fields and drops the peer address (#7957)", () => {
    const error = errorWith(
      { name: "TypeError", message: "fetch failed" },
      errorWith({
        code: "ECONNREFUSED",
        errno: -111,
        syscall: "connect",
        address: "10.42.0.7",
        family: 4,
        port: 8443,
      }),
    );

    const chain = describeErrorCauseChain(error);

    expect(chain[1]).toEqual({
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      family: 4,
      port: 8443,
      name: "Error",
      message: "failed",
    });
    expect(JSON.stringify(chain)).not.toContain("10.42.0.7");
  });

  it("redacts credentials carried in a cause message (#7957)", () => {
    const chain = describeErrorCauseChain(
      errorWith({ message: "upstream rejected authorization: Bearer sk-live-secret-value" }),
    );

    expect(chain[0].message).not.toContain("sk-live-secret-value");
    expect(chain[0].message).toContain("<REDACTED>");
  });

  it("stops at the depth bound and survives a cause cycle (#7957)", () => {
    const first = errorWith({ code: "E_ONE" });
    const second = errorWith({ code: "E_TWO" }, first);
    Object.assign(first, { cause: second });

    expect(describeErrorCauseChain(first)).toHaveLength(2);

    let deep = errorWith({ code: "E_LEAF" });
    for (let index = 0; index < 20; index += 1) deep = errorWith({ code: "E_WRAP" }, deep);

    expect(describeErrorCauseChain(deep)).toHaveLength(8);
  });
});

describe("collectSafeResponseHeaders", () => {
  it("keeps the allowed proxy diagnostics and drops everything else (#7957)", () => {
    const headers = collectSafeResponseHeaders({
      server: "envoy",
      via: "1.1 google",
      "x-request-id": "abc-123",
      "x-envoy-response-flags": "UF,URX",
      authorization: "Bearer secret",
      "set-cookie": "session=abc",
      "x-internal-route": "pool-7",
    });

    expect(headers).toEqual({
      server: "envoy",
      via: "1.1 google",
      "x-request-id": "abc-123",
      "x-envoy-response-flags": "UF,URX",
    });
  });

  it("accepts a fetch-style header iterator and rejects unbounded or non-printable values (#7957)", () => {
    const headers = collectSafeResponseHeaders(
      new Map([
        ["Server", "envoy"],
        ["Via", "x".repeat(300)],
        ["X-Request-Id", "line\nbreak"],
      ]),
    );

    expect(headers).toEqual({ server: "envoy" });
  });
});

describe("captureErrorBody", () => {
  it("captures a bounded redacted body only for a non-2xx text response (#7957)", () => {
    expect(captureErrorBody(200, "application/json", '{"ok":true}')).toBeUndefined();
    expect(captureErrorBody(503, "application/octet-stream", "binary")).toBeUndefined();
    expect(captureErrorBody(503, "text/plain; charset=utf-8", "upstream connect error")).toBe(
      "upstream connect error",
    );
  });

  it("bounds the captured body and removes credentials inside it (#7957)", () => {
    const body = `token=sk-live-secret-value ${"a".repeat(4000)}`;
    const captured = captureErrorBody(500, "application/json", body);

    expect(captured).toBeDefined();
    expect(captured).not.toContain("sk-live-secret-value");
    expect((captured ?? "").length).toBeLessThanOrEqual(2048);
  });
});

describe("buildManagedTransportFailure", () => {
  it("assembles the failure-only event a single failed probe has to explain (#7957)", () => {
    const failure = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "trusted_env_proxy",
      proxy: "127.0.0.1:3128",
      target: "mcp.example.com:443",
      httpStatus: 503,
      elapsedMs: 1512,
      responseHeaders: { server: "envoy", "x-envoy-response-flags": "UF" },
      error: errorWith({ code: "UND_ERR_SOCKET", message: "other side closed" }),
      sessionPresent: true,
    });

    expect(failure.phase).toBe("response_headers");
    expect(failure.causeCode).toBe("UND_ERR_SOCKET");
    expect(failure.proxy).toBe("127.0.0.1:3128");
    expect(failure.target).toBe("mcp.example.com:443");
    expect(failure.responseHeaders.server).toBe("envoy");
    expect(failure.sessionPresent).toBe(true);
    expect(failure.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("records only the presence of a session and never its value (#7957)", () => {
    const failure = buildManagedTransportFailure({
      consumer: "mcp",
      sessionPresent: true,
      error: errorWith({ message: "mcp-session-id 7f3c9a02-secret" }),
    });

    expect(failure.sessionPresent).toBe(true);
    expect(JSON.stringify(failure)).not.toContain("7f3c9a02-secret");
  });

  it("drops an endpoint that fails the terminal-output allowlist (#7957)", () => {
    const failure = buildManagedTransportFailure({
      consumer: "mcp",
      proxy: "not an endpoint",
      target: "mcp.example.com:99999",
    });

    expect(failure.proxy).toBeUndefined();
    expect(failure.target).toBeUndefined();
  });

  it("defaults the route to unknown so an uninstrumented consumer stays honest (#7957)", () => {
    expect(buildManagedTransportFailure({ consumer: "messaging" }).route).toBe("unknown");
  });

  it("serves a non-MCP consumer with the same schema (#7957)", () => {
    const failure = buildManagedTransportFailure({
      consumer: "messaging",
      operation: "webhook/post",
      route: "direct",
      target: "hooks.example.com:443",
      error: errorWith({ code: "ENOTFOUND" }),
    });

    expect(failure.consumer).toBe("messaging");
    expect(failure.phase).toBe("app_connect");
    expect(failure.event).toBe("managed_transport_failure");
  });
});

describe("formatManagedTransportFailure", () => {
  it("renders the documented key-value shape (#7957)", () => {
    const rendered = formatManagedTransportFailure(
      buildManagedTransportFailure({
        consumer: "mcp",
        operation: "tools/list",
        route: "trusted_env_proxy",
        target: "mcp.example.com:443",
        httpStatus: 503,
        elapsedMs: 1512,
        responseHeaders: { server: "envoy" },
        error: errorWith({ code: "UND_ERR_SOCKET" }),
        traceId: "0".repeat(32),
      }),
    );

    expect(rendered.split("\n")).toEqual(
      expect.arrayContaining([
        "managed_transport_failure",
        "consumer=mcp",
        "operation=tools/list",
        "route=trusted_env_proxy",
        "target=mcp.example.com:443",
        "phase=response_headers",
        "http_status=503",
        "elapsed_ms=1512",
        "cause_code=UND_ERR_SOCKET",
        "server=envoy",
        "session_present=false",
        `trace_id=${"0".repeat(32)}`,
      ]),
    );
  });
});

describe("newManagedTransportTraceId", () => {
  it("mints a distinct hex identifier per failure (#7957)", () => {
    const first = newManagedTransportTraceId();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(newManagedTransportTraceId());
  });
});
