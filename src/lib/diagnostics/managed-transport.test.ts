// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { OPENCLAW_MANAGED_TRANSPORT_PHASES } from "../../../scripts/patch-openclaw-managed-transport-diagnostics.mts";

import {
  boundedErrorBodySnippet,
  buildManagedTransportFailure,
  classifyTransportPhase,
  emitManagedTransportFailure,
  encodeLogField,
  generateTransportTraceId,
  MANAGED_TRANSPORT_FAILURE_EVENT,
  type ManagedTransportPhase,
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

  it("drops every userinfo segment before the final at sign", () => {
    const target = "user:secret@second:credential@host:8080?token=x";

    expect(safeTargetRef(target)).toBe("host:8080");
    expect(safeTargetRef(target)).not.toContain("credential");
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
    const chain = safeCauseChain(deep);
    expect(chain).toHaveLength(8);
    expect(chain[0]).toEqual({ name: "n19" });
    expect(chain[7]).toEqual({ name: "n12" });

    let empty: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) empty = { cause: empty };
    expect(safeCauseChain(empty)).toEqual([]);
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
    expect(classifyTransportPhase({ proxyConnectFailure: true, causeCode: "ECONNREFUSED" })).toBe(
      "connect",
    );
    expect(classifyTransportPhase({ causeCode: "ECONNREFUSED" })).toBe("app_connect");
    expect(classifyTransportPhase({ causeCode: "UND_ERR_CONNECT_TIMEOUT" })).toBe("app_connect");
    expect(classifyTransportPhase({ httpStatus: 503 })).toBe("response_headers");
    expect(classifyTransportPhase({ causeCode: "UND_ERR_SOCKET" })).toBe("response_headers");
    expect(classifyTransportPhase({ causeCode: "UND_ERR_BODY_TIMEOUT" })).toBe("response_stream");
    expect(classifyTransportPhase({ causeCode: "UND_ERR_BODY_TIMEOUT", httpStatus: 200 })).toBe(
      "response_stream",
    );
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
      sessionPresent: true,
      errorBody: { body: '{"error":"upstream"}', contentType: "application/json" },
    });

    expect(event.proxy).toBe("proxy.internal:3128/");
    expect(event.target).toBe("mcp.example.com:443/stream");
    expect(event.causeCode).toBe("UND_ERR_SOCKET");
    expect(event.elapsedMs).toBe(1513);
    expect(event.sessionPresent).toBe(true);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("pw");
    expect(serialized).not.toContain("session=abc");
    expect(serialized).not.toContain("sid=secret");
    expect(serialized).not.toContain("debug=1");
  });

  it("refuses an error body when the response succeeded", () => {
    const withSuccess = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "trusted_env_proxy",
      phase: "response_headers",
      elapsedMs: 12,
      httpStatus: 200,
      errorBody: { body: '{"ok":"payload"}', contentType: "application/json" },
    });
    expect(withSuccess.errorBodySnippet).toBeUndefined();
    expect(JSON.stringify(withSuccess)).not.toContain("payload");

    const withoutStatus = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "trusted_env_proxy",
      phase: "app_connect",
      elapsedMs: 12,
      errorBody: { body: '{"ok":"payload"}', contentType: "application/json" },
    });
    expect(withoutStatus.errorBodySnippet).toBeUndefined();

    const withFailure = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "trusted_env_proxy",
      phase: "response_headers",
      elapsedMs: 12,
      httpStatus: 502,
      errorBody: { body: '{"error":"upstream"}', contentType: "application/json" },
    });
    expect(withFailure.errorBodySnippet).toContain("upstream");
  });

  it("redacts untrusted fields in the built object before any formatting", () => {
    const token = "sk-abcdef0123456789abcdef0123456789";
    const event = buildManagedTransportFailure({
      consumer: "mcp",
      operation: `tools/list ${token}`,
      route: "trusted_env_proxy",
      phase: "response_headers",
      elapsedMs: 10,
      responseHeaders: [["x-request-id", `req ${token}`]],
    });

    // The event object itself is safe to serialize without the line formatter.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(token);
    expect(event.operation).not.toContain(token);
    expect(event.xRequestId).not.toContain(token);
  });

  it("constrains cause metadata and supplied trace ids in the built object", () => {
    const token = "sk-abcdef0123456789abcdef0123456789";
    const event = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "direct",
      phase: "request",
      elapsedMs: 10,
      traceId: `Bearer ${token}\nphase=policy`,
      error: Object.assign(new Error("x"), {
        name: `Leaky ${token}`,
        code: "ECONNRESET extra=1",
        syscall: "read\nwrite",
      }),
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("extra=1");
    expect(serialized).not.toContain("\\n");
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(event.causeChain[0]).toEqual({
      name: "<invalid>",
      code: "<invalid>",
      syscall: "<invalid>",
    });
  });

  it("keeps a well-formed supplied trace id", () => {
    const event = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "direct",
      phase: "request",
      elapsedMs: 10,
      traceId: "trace-0123456789",
    });
    expect(event.traceId).toBe("trace-0123456789");
  });

  it("replaces a credential-shaped supplied trace id before serialization", () => {
    const supplied = "sk-abcdef0123456789abcdef0123456789";
    const event = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "direct",
      phase: "request",
      elapsedMs: 10,
      traceId: supplied,
    });

    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(event)).not.toContain(supplied);
  });

  it("surfaces a nested transport cause code at the top level", () => {
    const event = buildManagedTransportFailure({
      consumer: "mcp",
      operation: "tools/list",
      route: "direct",
      phase: "app_connect",
      elapsedMs: 10,
      error: new Error("fetch failed", {
        cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
      }),
    });

    expect(event.causeCode).toBe("ECONNREFUSED");
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
        "transport_phase=response_headers",
        "http_status=503",
        "elapsed_ms=1512",
        "cause_code=UND_ERR_SOCKET",
        "trace_id=0123456789abcdef0123456789abcdef",
      ].join(" "),
    );
    expect(lines[1]).toContain("cause_chain=Error/UND_ERR_SOCKET/read");
  });

  it("encodes an error-body snippet on a directly constructed event", () => {
    const lines: string[] = [];
    emitManagedTransportFailure(
      {
        consumer: "mcp",
        operation: "tools/list",
        route: "trusted_env_proxy",
        phase: "response_stream",
        traceId: "trace-9",
        elapsedMs: 5,
        causeChain: [],
        errorBodySnippet:
          "authorization: Bearer sk-live-not-a-real-key\nmanaged_transport_failure phase=forged",
      },
      (line) => lines.push(line),
    );

    const emitted = lines.join("\n");
    expect(emitted).not.toContain("sk-live-not-a-real-key");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("error_body=");
    expect(lines[1]).not.toMatch(/\n/);
    expect(lines.filter((line) => line.startsWith("managed_transport_failure "))).toHaveLength(2);
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
    expect(line).toContain("transport_phase=response_headers");
    expect(line.match(/(?:^| )transport_phase=/g)).toHaveLength(1);
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
    expect(lines[0]).toContain("transport_phase=app_connect");
    expect(lines[0]).toContain("target=hooks.example.com:443/pay");
    expect(lines.join("\n")).not.toContain("signature");
  });
});

describe("shared vocabulary with the OpenClaw managed transport dist patch", () => {
  it("emits the key names the patch documents for shared fields", () => {
    const lines: string[] = [];
    emitManagedTransportFailure(
      buildManagedTransportFailure({
        consumer: "mcp",
        operation: "tools/list",
        route: "trusted_env_proxy",
        phase: "response_headers",
        elapsedMs: 100,
        httpStatus: 503,
        sessionPresent: true,
      }),
      (line) => lines.push(line),
    );

    for (const sharedKey of ["transport_phase", "session_present"]) {
      expect(lines[0]).toContain(`${sharedKey}=`);
    }
    // The superseded key names must be absent, not merely accompanied by the
    // new ones: an emitter writing both `phase=` and `transport_phase=` would
    // reintroduce the second vocabulary this change removes.
    expect(lines[0]).not.toMatch(/(^|\s)phase=/);
    expect(lines[0]).not.toContain("session_id_present");
    // trace_id stays distinct from the patch's diagnostic_id, which is
    // documented as a local identifier that does not correlate across
    // process boundaries.
    expect(lines[0]).toContain("trace_id=");
    expect(lines[0]).not.toContain("diagnostic_id=");
  });

  it("covers every phase the patch classifier can return", () => {
    const contractPhases: ManagedTransportPhase[] = [
      ...OPENCLAW_MANAGED_TRANSPORT_PHASES,
      "response_stream",
    ];
    for (const phase of contractPhases) {
      const lines: string[] = [];
      emitManagedTransportFailure(
        buildManagedTransportFailure({
          consumer: "mcp",
          operation: "tools/list",
          route: "direct",
          phase,
          elapsedMs: 1,
        }),
        (line) => lines.push(line),
      );
      expect(lines[0]).toContain(`transport_phase=${phase}`);
    }
  });
});
