// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  boundedErrorBodySnippet,
  buildManagedTransportFailure,
  classifyTransportPhase,
  emitManagedTransportFailure,
  encodeLogField,
  generateTransportTraceId,
  MANAGED_TRANSPORT_FAILURE_EVENT,
  pickSafeResponseHeaders,
  safeCauseChain,
  safeTargetRef,
} from "./managed-transport";

describe("safeTargetRef", () => {
  it("strips credentials, query string, and fragment from URLs", () => {
    expect(safeTargetRef("https://user:secret@api.example.com/v1/chat?api_key=k#frag")).toBe(
      "api.example.com:443/v1/chat",
    );
  });

  it("keeps host and explicit port", () => {
    expect(safeTargetRef("http://proxy.internal:3128/")).toBe("proxy.internal:3128/");
  });

  it("drops query and userinfo from non-URL values", () => {
    expect(safeTargetRef("user:secret@host:8080?token=x")).toBe("host:8080");
  });
});

describe("safeCauseChain", () => {
  it("keeps only safe fields across nested causes", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:443 key=abc"), {
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      port: 443,
      address: "10.0.0.9",
    });
    const outer = new Error("fetch failed https://api.example.com?token=zzz", { cause: inner });
    const chain = safeCauseChain(outer);

    expect(chain).toEqual([
      { name: "Error" },
      { name: "Error", code: "ECONNREFUSED", errno: -111, syscall: "connect", port: 443 },
    ]);
    const serialized = JSON.stringify(chain);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("10.0.0.9");
    expect(serialized).not.toContain("key=abc");
  });

  it("guards against cause cycles and unbounded depth", () => {
    const a: Record<string, unknown> = { name: "A" };
    const b: Record<string, unknown> = { name: "B", cause: a };
    a.cause = b;
    expect(safeCauseChain(a)).toEqual([{ name: "A" }, { name: "B" }]);

    let deep: Record<string, unknown> = { name: "leaf" };
    for (let index = 0; index < 20; index += 1) deep = { name: `n${index}`, cause: deep };
    expect(safeCauseChain(deep).length).toBeLessThanOrEqual(8);
  });
});

describe("pickSafeResponseHeaders", () => {
  it("keeps the diagnostic allowlist and drops content-bearing headers", () => {
    const picked = pickSafeResponseHeaders([
      ["Server", "envoy"],
      ["Via", "1.1 proxy"],
      ["X-Request-Id", "req-1"],
      ["X-Envoy-Response-Flags", "UF"],
      ["Set-Cookie", "session=secret"],
      ["Authorization", "Bearer token"],
      ["Location", "https://example.com?code=abc"],
    ]);
    expect(picked).toEqual({
      responseServer: "envoy",
      responseVia: "1.1 proxy",
      xRequestId: "req-1",
      xEnvoyResponseFlags: "UF",
    });
    expect(JSON.stringify(picked)).not.toContain("secret");
    expect(JSON.stringify(picked)).not.toContain("Bearer");
  });
});

describe("boundedErrorBodySnippet", () => {
  it("bounds textual bodies and refuses non-textual content types", () => {
    const long = "x".repeat(2000);
    const snippet = boundedErrorBodySnippet(long, "application/json");
    expect(snippet).toBeDefined();
    expect((snippet as string).length).toBeLessThanOrEqual(512);
    expect(boundedErrorBodySnippet(long, "application/octet-stream")).toBeUndefined();
    expect(boundedErrorBodySnippet(long, undefined)).toBeUndefined();
  });
});

describe("classifyTransportPhase", () => {
  it("is deterministic across the failure vocabulary", () => {
    expect(classifyTransportPhase({ policyDenied: true })).toBe("policy");
    expect(classifyTransportPhase({ tlsFailure: true })).toBe("tls");
    expect(classifyTransportPhase({ causeCode: "CERT_HAS_EXPIRED" })).toBe("tls");
    expect(classifyTransportPhase({ causeCode: "ECONNREFUSED" })).toBe("app_connect");
    expect(classifyTransportPhase({ causeCode: "UND_ERR_CONNECT_TIMEOUT" })).toBe("app_connect");
    expect(classifyTransportPhase({ httpStatus: 503 })).toBe("response_headers");
    expect(classifyTransportPhase({ causeCode: "UND_ERR_SOCKET" })).toBe("response_headers");
    expect(classifyTransportPhase({ causeCode: "UND_ERR_BODY_TIMEOUT" })).toBe("response_stream");
    expect(classifyTransportPhase({ streamInterrupted: true })).toBe("response_stream");
    expect(classifyTransportPhase({})).toBe("request");
  });
});

describe("buildManagedTransportFailure", () => {
  it("copies only allowlisted fields and sanitizes endpoints", () => {
    const event = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "trusted_env_proxy",
      phase: "response_headers",
      elapsedMs: 1512.6,
      traceId: "trace-1",
      proxy: "http://user:pw@proxy.internal:3128/?debug=1",
      target: "https://mcp.example.com/stream?session=abc",
      httpStatus: 503,
      error: Object.assign(new Error("boom"), { code: "UND_ERR_SOCKET" }),
      responseHeaders: [
        ["server", "envoy"],
        ["set-cookie", "sid=secret"],
      ],
      sessionIdPresent: true,
      errorBody: { body: '{"error":"upstream"}', contentType: "application/json" },
    });

    expect(event.proxy).toBe("proxy.internal:3128/");
    expect(event.target).toBe("mcp.example.com:443/stream");
    expect(event.causeCode).toBe("UND_ERR_SOCKET");
    expect(event.elapsedMs).toBe(1513);
    expect(event.sessionIdPresent).toBe(true);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("pw");
    expect(serialized).not.toContain("session=abc");
    expect(serialized).not.toContain("sid=secret");
    expect(serialized).not.toContain("debug=1");
  });

  it("generates a trace id when none is supplied", () => {
    const event = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "direct",
      phase: "request",
      elapsedMs: 10,
    });
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(generateTransportTraceId()).not.toBe(event.traceId);
  });
});

describe("emitManagedTransportFailure", () => {
  it("writes stable key=value lines under the shared event name", () => {
    const lines: string[] = [];
    emitManagedTransportFailure(
      buildManagedTransportFailure({
        consumer: "mcp",
        operation: "tools/list",
        route: "trusted_env_proxy",
        phase: "response_headers",
        elapsedMs: 1512,
        traceId: "0123456789abcdef0123456789abcdef",
        target: "https://mcp.example.com/stream",
        httpStatus: 503,
        error: Object.assign(new Error("reset"), { code: "UND_ERR_SOCKET", syscall: "read" }),
      }),
      (line) => lines.push(line),
    );

    expect(lines[0]).toBe(
      [
        MANAGED_TRANSPORT_FAILURE_EVENT,
        "consumer=mcp",
        "operation=tools/list",
        "route=trusted_env_proxy",
        "target=mcp.example.com:443/stream",
        "phase=response_headers",
        "http_status=503",
        "elapsed_ms=1512",
        "cause_code=UND_ERR_SOCKET",
        "trace_id=0123456789abcdef0123456789abcdef",
      ].join(" "),
    );
    expect(lines[1]).toContain("cause_chain=Error/UND_ERR_SOCKET/read");
  });

  it("neutralizes delimiter- and credential-bearing values in every emitted field", () => {
    const lines: string[] = [];
    emitManagedTransportFailure(
      buildManagedTransportFailure({
        consumer: "mcp",
        operation: "tools/list\nmanaged_transport_failure phase=policy",
        route: "trusted_env_proxy",
        phase: "response_headers",
        elapsedMs: 10,
        traceId: "trace-1",
        httpStatus: 503,
        responseHeaders: [
          ["server", "envoy value=forged"],
          ["x-request-id", "id\r\ninjected=1"],
          ["via", "Bearer sk-abcdef0123456789abcdef0123456789"],
        ],
      }),
      (line) => lines.push(line),
    );

    // One record: no injected line break reached the physical output.
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    // The genuine phase field is intact and appears once as a real top-level field.
    expect(line).toContain("phase=response_headers");
    // Delimiter-bearing values are JSON-quoted, so their `key=value` fragments
    // live inside a quoted token rather than as forged fields.
    expect(line).toContain('operation="tools/list\\nmanaged_transport_failure phase=policy"');
    expect(line).toContain('x_request_id="id\\r\\ninjected=1"');
    // A credential-shaped header value is redacted, not disclosed.
    expect(line).not.toContain("sk-abcdef0123456789abcdef0123456789");
  });
});

describe("encodeLogField", () => {
  it("quotes delimiter-bearing values and passes plain tokens through", () => {
    expect(encodeLogField("tools/list")).toBe("tools/list");
    expect(encodeLogField("1.1 proxy")).toBe('"1.1 proxy"');
    expect(encodeLogField("a\nb")).toBe('"a\\nb"');
    expect(encodeLogField(503)).toBe("503");
  });
});

describe("example non-MCP consumer", () => {
  it("reuses the contract for a webhook delivery failure without any MCP coupling", () => {
    const lines: string[] = [];
    const deliverWebhook = (url: string): void => {
      const started = 4200;
      const failedAt = 4907;
      try {
        throw Object.assign(new Error("fetch failed"), {
          cause: Object.assign(new Error("connect timed out"), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        });
      } catch (error) {
        const causeCode = safeCauseChain(error)[1]?.code;
        emitManagedTransportFailure(
          buildManagedTransportFailure({
            consumer: "webhook",
            operation: "deliver",
            route: "direct",
            phase: classifyTransportPhase({ causeCode }),
            elapsedMs: failedAt - started,
            target: url,
            error,
          }),
          (line) => lines.push(line),
        );
      }
    };

    deliverWebhook("https://hooks.example.com/pay?signature=secret");

    expect(lines[0]).toContain("consumer=webhook");
    expect(lines[0]).toContain("phase=app_connect");
    expect(lines[0]).toContain("target=hooks.example.com:443/pay");
    expect(lines.join("\n")).not.toContain("signature");
  });
});
