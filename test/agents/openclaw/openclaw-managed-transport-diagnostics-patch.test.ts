// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { webcrypto } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  INJECTED_DIAGNOSTIC_HELPER,
  MARKER,
  patchManagedTransportDiagnosticsText,
} from "../../../scripts/patch-openclaw-managed-transport-diagnostics.mts";

/**
 * Mirrors the reviewed `openclaw@2026.7.1`
 * `dist/agent-bundle-mcp-runtime-*.js` transport factory, including its tab
 * indentation, so the patch anchor is exercised against the real preimage.
 */
function bundleMcpRuntimeFixture(): string {
  return [
    'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";',
    'import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";',
    "function resolveMcpTransport(serverName, rawServer) {",
    '\tconst client = new Client({ name: "openclaw-bundle-mcp" });',
    "\tconst baseFetch = buildMcpHttpFetch({",
    "\t\tsslVerify: resolved.sslVerify,",
    "\t\tresourceUrl: resolved.url",
    "\t});",
    '\tconst headers = resolved.auth === "oauth" ? withoutMcpAuthorizationHeader(resolved.headers) : resolved.headers;',
    '\tconst httpFetch = resolved.auth === "oauth" ? withSameOriginMcpHttpHeaders({ fetchFn: baseFetch }) : baseFetch;',
    '\tif (resolved.transportType === "streamable-http") return {',
    "\t\ttransport: new StreamableHTTPClientTransport(new URL(resolved.url), {",
    '\t\t\trequestInit: resolved.auth === "oauth" || !headers ? void 0 : { headers },',
    "\t\t\tfetch: httpFetch,",
    "\t\t\tauthProvider",
    "\t\t}),",
    '\t\ttransportType: "streamable-http"',
    "\t};",
    "\treturn {",
    "\t\ttransport: new SSEClientTransport(new URL(resolved.url), {",
    "\t\t\tfetch: httpFetch,",
    "\t\t\tauthProvider",
    "\t\t}),",
    '\t\ttransportType: "sse"',
    "\t};",
    "}",
  ].join("\n");
}

interface HelperHarness {
  wrap: (
    inner: typeof fetch,
    serverUrl:
      | string
      | {
          serverName: string;
          serverUrl: string;
          connectionTimeoutMs: number;
          requestTimeoutMs: number;
          catalogListTimeoutMs: number;
        },
  ) => (input: unknown, init?: RequestInit) => Promise<Response>;
  stderr: string[];
}

function loadHelper(
  env: Record<string, string> = { OPENSHELL_SANDBOX: "1" },
  now: () => number = () => Date.now(),
  runtime: {
    crypto?: Pick<Crypto, "randomUUID">;
    writeStderr?: (chunk: string) => void;
  } = {},
): HelperHarness {
  const stderr: string[] = [];
  const context = vm.createContext({
    Headers,
    URL,
    Date: { now },
    TextDecoder,
    TextEncoder,
    Object,
    JSON,
    Number,
    Boolean,
    String,
    Set,
    clearTimeout,
    crypto: runtime.crypto ?? webcrypto,
    process: {
      env,
      stderr: { write: runtime.writeStderr ?? ((chunk: string) => stderr.push(chunk)) },
    },
    setTimeout,
  });
  const injectedWrap = vm.runInContext(
    `${INJECTED_DIAGNOSTIC_HELPER}\nnemoClawManagedTransportFetch;`,
    context,
  );
  const wrap: HelperHarness["wrap"] = (inner, serverUrl) =>
    injectedWrap(
      inner,
      typeof serverUrl === "string"
        ? {
            serverName: "remotedocs",
            serverUrl,
            connectionTimeoutMs: 30_000,
            requestTimeoutMs: 60_000,
            catalogListTimeoutMs: 1_500,
          }
        : serverUrl,
    );
  return { wrap, stderr };
}

function emittedEvent(stderr: string[]): Record<string, string> {
  return Object.fromEntries(
    stderr
      .join("")
      .split("\n")
      .map((line) => line.replace(/^\[nemoclaw\] /, ""))
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function emittedEvents(stderr: string[]): Array<Record<string, string>> {
  return stderr.map((chunk) => {
    const lines = chunk
      .split("\n")
      .map((line) => line.replace(/^\[nemoclaw\] /, ""))
      .filter(Boolean);
    return {
      event: lines[0],
      ...Object.fromEntries(
        lines
          .slice(1)
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      ),
    };
  });
}

async function waitForDiagnostic(stderr: string[]): Promise<void> {
  await expect.poll(() => stderr.length, { interval: 5, timeout: 1000 }).toBeGreaterThan(0);
}

describe("patchManagedTransportDiagnosticsText", () => {
  it("routes the Streamable HTTP fetch through the diagnostic wrapper (#7957)", () => {
    const result = patchManagedTransportDiagnosticsText(bundleMcpRuntimeFixture(), "fixture.js");

    expect(result.status).toBe("patched");
    expect(result.text).toContain(MARKER);
    expect(result.text).toContain("\t\t\tfetch: nemoClawManagedTransportFetch(httpFetch, {");
    expect(result.text).toContain("\t\t\t\tcatalogListTimeoutMs: getCatalogListTimeoutMs(");
  });

  it("leaves the SSE transport boundary untouched (#7957)", () => {
    const result = patchManagedTransportDiagnosticsText(bundleMcpRuntimeFixture(), "fixture.js");
    const sseBlock = result.text.slice(result.text.indexOf("new SSEClientTransport"));

    expect(sseBlock).toContain("\t\t\tfetch: httpFetch,");
    expect(sseBlock).not.toContain("nemoClawManagedTransportFetch");
  });

  it("reports an applied patch as stable rather than reapplying it (#7957)", () => {
    const once = patchManagedTransportDiagnosticsText(bundleMcpRuntimeFixture(), "fixture.js");
    const twice = patchManagedTransportDiagnosticsText(once.text, "fixture.js");

    expect(twice.status).toBe("already-patched");
    expect(twice.text).toBe(once.text);
  });

  it("fails closed when the reviewed fetch boundary is absent (#7957)", () => {
    const drifted = bundleMcpRuntimeFixture().replace(
      '\t\t\tfetch: httpFetch,\n\t\t\tauthProvider\n\t\t}),\n\t\ttransportType: "streamable-http"',
      '\t\t\tfetch: someOtherFetch,\n\t\t\tauthProvider\n\t\t}),\n\t\ttransportType: "streamable-http"',
    );

    expect(() => patchManagedTransportDiagnosticsText(drifted, "fixture.js")).toThrow(
      /expected exactly one Streamable HTTP MCP fetch boundary, found 0/,
    );
  });

  it("fails closed when a marked bundle still carries an unpatched boundary (#7957)", () => {
    const tampered = `${MARKER}\n${bundleMcpRuntimeFixture()}`;

    expect(() => patchManagedTransportDiagnosticsText(tampered, "fixture.js")).toThrow(
      /partial or ambiguous|unpatched target remains/,
    );
  });
});

describe("injected managed transport wrapper", () => {
  it("stays silent on a successful response (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const inner = async () => new Response("ok", { status: 200 });

    const response = await wrap(
      inner as unknown as typeof fetch,
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc");

    expect(response.status).toBe(200);
    expect(stderr).toEqual([]);
  });

  it("sends the request when diagnostic identifier generation fails (#7957)", async () => {
    let randomUuidCalls = 0;
    let innerCalls = 0;
    const { wrap, stderr } = loadHelper({ OPENSHELL_SANDBOX: "1" }, () => Date.now(), {
      crypto: {
        randomUUID: () => {
          randomUuidCalls += 1;
          throw new Error("entropy unavailable");
        },
      },
    });
    const inner = async () => {
      innerCalls += 1;
      return new Response("ok", { status: 200 });
    };

    const response = await wrap(
      inner as unknown as typeof fetch,
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc");

    expect(response.status).toBe(200);
    expect(innerCalls).toBe(1);
    expect(randomUuidCalls).toBeGreaterThan(0);
    expect(stderr).toEqual([]);
  });

  it("returns a successful response when shadow diagnostic emission fails (#7957)", async () => {
    let stderrWrites = 0;
    let innerCalls = 0;
    const { wrap } = loadHelper(
      {
        OPENSHELL_SANDBOX: "1",
        NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1",
      },
      () => Date.now(),
      {
        writeStderr: () => {
          stderrWrites += 1;
          throw new Error("stderr unavailable");
        },
      },
    );
    const expected = new Response("ok", { status: 200 });
    const inner = async () => {
      innerCalls += 1;
      return expected;
    };

    const response = await wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")(
      "https://mcp.test/rpc",
      {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
    );

    expect(response).toBe(expected);
    expect(innerCalls).toBe(1);
    expect(stderrWrites).toBeGreaterThan(0);
  });

  it("emits opt-in operation timing and a bounded shadow recommendation without changing responses (#7957)", async () => {
    let now = 0;
    const { wrap, stderr } = loadHelper(
      {
        OPENSHELL_SANDBOX: "1",
        NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1",
      },
      () => now,
    );
    const delays = [1_000, 1_600, 3_000, 6_000, 1_200];
    let call = 0;
    const inner = async () => {
      now += delays[call];
      call += 1;
      return new Response("ok", { status: 200 });
    };
    const wrapped = wrap(inner as unknown as typeof fetch, {
      serverName: "gitlab",
      serverUrl: "https://mcp.test/rpc",
      connectionTimeoutMs: 30_000,
      requestTimeoutMs: 60_000,
      catalogListTimeoutMs: 1_500,
    });

    for (let index = 0; index < delays.length; index += 1) {
      const response = await wrapped("https://mcp.test/rpc", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "tools/list" }),
      });
      expect(response.status).toBe(200);
    }

    const events = emittedEvents(stderr);
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({
      event: "managed_transport_shadow",
      mcp_server: "gitlab",
      operation: "tools/list",
      transport_generation: "1",
      request_sequence: "1",
      connection_timeout_ms: "30000",
      request_timeout_ms: "60000",
      catalog_list_timeout_ms: "1500",
      effective_timeout_ms: "1500",
      elapsed_ms: "1000",
      shadow_sample_count: "1",
    });
    expect(events[4]).toMatchObject({
      request_sequence: "5",
      shadow_sample_count: "5",
      shadow_p95_ms: "6000",
      shadow_recommended_timeout_ms: "9000",
    });
    events.slice(0, 4).forEach((event) => {
      expect(event.shadow_p95_ms).toBeUndefined();
      expect(event.shadow_recommended_timeout_ms).toBeUndefined();
    });
  });

  it("recommends a bounded larger catalog budget for an observed tools/list abort (#7957)", async () => {
    let now = 0;
    const { wrap, stderr } = loadHelper(
      {
        OPENSHELL_SANDBOX: "1",
        NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1",
      },
      () => now,
    );
    const error = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
      code: "UND_ERR_ABORTED",
    });
    const inner = async () => {
      now += 1_500;
      throw error;
    };

    await expect(
      wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    ).rejects.toBe(error);

    expect(emittedEvents(stderr)[0]).toMatchObject({
      event: "managed_transport_failure",
      operation: "tools/list",
      elapsed_ms: "1500",
      effective_timeout_ms: "1500",
      shadow_sample_count: "0",
      shadow_recommended_timeout_ms: "3000",
    });
  });

  it("never recommends a timeout below the active catalog budget (#7957)", async () => {
    let now = 0;
    const { wrap, stderr } = loadHelper(
      {
        OPENSHELL_SANDBOX: "1",
        NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1",
      },
      () => now,
    );
    const inner = async () => {
      now += 1_000;
      return new Response("ok", { status: 200 });
    };
    const wrapped = wrap(inner as unknown as typeof fetch, {
      serverName: "jira",
      serverUrl: "https://mcp.test/rpc",
      connectionTimeoutMs: 30_000,
      requestTimeoutMs: 60_000,
      catalogListTimeoutMs: 5_000,
    });

    for (let id = 0; id < 5; id += 1) {
      await wrapped("https://mcp.test/rpc", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
      });
    }

    expect(emittedEvents(stderr)[4].shadow_recommended_timeout_ms).toBe("5000");
  });

  it("keeps an explicit 503 separate from timeout recommendations and observes a later success (#7957)", async () => {
    let now = 0;
    const { wrap, stderr } = loadHelper(
      {
        OPENSHELL_SANDBOX: "1",
        NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1",
      },
      () => now,
    );
    let calls = 0;
    const inner = async () => {
      calls += 1;
      now += 200;
      return calls === 1
        ? new Response("upstream reset", { status: 503 })
        : new Response("ok", { status: 200 });
    };
    const wrapped = wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc");
    const init = {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    };

    expect((await wrapped("https://mcp.test/rpc", init)).status).toBe(503);
    await waitForDiagnostic(stderr);
    expect((await wrapped("https://mcp.test/rpc", init)).status).toBe(200);
    const events = emittedEvents(stderr);

    expect(calls).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "managed_transport_failure",
      http_status: "503",
      request_sequence: "1",
    });
    expect(events[0].shadow_recommended_timeout_ms).toBeUndefined();
    expect(events[1]).toMatchObject({
      event: "managed_transport_shadow",
      http_status: "200",
      request_sequence: "2",
    });
    expect(events[0].diagnostic_id).not.toBe(events[1].diagnostic_id);
  });

  it("logs only the validated RPC method and omits tool names and arguments (#7957)", async () => {
    const { wrap, stderr } = loadHelper({
      OPENSHELL_SANDBOX: "1",
      NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1",
    });
    const inner = async () => new Response("ok", { status: 200 });

    await wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { token: "secret-tool-argument" } },
      }),
    });

    expect(emittedEvents(stderr)[0]).toMatchObject({
      event: "managed_transport_shadow",
      operation: "tools/call",
      effective_timeout_ms: "60000",
    });
    expect(stderr.join("")).not.toContain("secret-tool-argument");
    expect(stderr.join("")).not.toContain("search");
  });

  it("redacts a credential-shaped server name before emitting shadow timing (#7957)", async () => {
    const { wrap, stderr } = loadHelper({
      OPENSHELL_SANDBOX: "1",
      NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "1",
    });
    const inner = async () => new Response("ok", { status: 200 });

    await wrap(inner as unknown as typeof fetch, {
      serverName: "sk-proj-secret-server-name-1234567890",
      serverUrl: "https://mcp.test/rpc",
      connectionTimeoutMs: 30_000,
      requestTimeoutMs: 60_000,
      catalogListTimeoutMs: 1_500,
    })("https://mcp.test/rpc", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(emittedEvents(stderr)[0].mcp_server).toContain("<REDACTED>");
    expect(stderr.join("")).not.toContain("secret-server-name");
  });

  it("records a failed proxy response with the canonical safe headers (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const inner = async () =>
      new Response("upstream connect error", {
        status: 503,
        headers: {
          "content-type": "text/plain",
          server: "envoy client_secret=header-secret-value",
          "x-request-id": "req-42 access_token=request-secret-value",
          "x-envoy-response-flags": "UF,URX",
          "set-cookie": "session=leaky",
        },
      });

    await wrap(
      inner as unknown as typeof fetch,
      "https://mcp.test:8443/rpc",
    )("https://mcp.test:8443/rpc");
    await waitForDiagnostic(stderr);
    const event = emittedEvent(stderr);

    expect(event.transport_phase).toBe("response_headers");
    expect(event.http_status).toBe("503");
    expect(event.target).toBe("mcp.test:8443");
    expect(event.mcp_server).toBe("remotedocs");
    expect(event.server).toContain("<REDACTED>");
    expect(event.x_request_id).toContain("<REDACTED>");
    expect(event.x_envoy_response_flags).toBe("UF,URX");
    expect(event.diagnostic_id).toMatch(/^[0-9a-f]{32}$/);
    expect(stderr.join("")).not.toContain("header-secret-value");
    expect(stderr.join("")).not.toContain("request-secret-value");
    expect(stderr.join("")).not.toContain("session=leaky");
  });

  it.each([
    ["policy", "CONNECT tunnel failed, response 403", "ECONNRESET"],
    ["connect", "CONNECT tunnel failed, response 502", "ECONNRESET"],
    ["tls", "certificate failed", "CERT_HAS_EXPIRED"],
    ["app_connect", "fetch failed", "ECONNREFUSED"],
    ["response_headers", "headers timed out", "UND_ERR_HEADERS_TIMEOUT"],
    ["request", "request aborted", "UND_ERR_ABORTED"],
  ])("classifies an injected %s failure (#7957)", async (transportPhase, message, code) => {
    const { wrap, stderr } = loadHelper();
    const error = Object.assign(new Error(message), { code });
    const inner = async () => {
      throw error;
    };

    await expect(
      wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc"),
    ).rejects.toBe(error);

    expect(emittedEvent(stderr).transport_phase).toBe(transportPhase);
  });

  it("emits the canonical injected failure fields (#7957)", async () => {
    const { wrap, stderr } = loadHelper({
      OPENSHELL_SANDBOX: "1",
      HTTPS_PROXY: "http://127.0.0.1:3128",
    });
    const error = Object.assign(new Error("CONNECT tunnel failed, response 403"), {
      code: "ECONNRESET",
    });
    const inner = async () => {
      throw error;
    };

    await expect(
      wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc"),
    ).rejects.toBe(error);

    const event = emittedEvent(stderr);
    expect(event).toMatchObject({
      consumer: "mcp",
      route: "proxy_configured",
      proxy: "127.0.0.1:3128",
      target: "mcp.test:443",
      transport_phase: "policy",
      cause_code: "ECONNRESET",
      session_present: "false",
    });
    expect(JSON.parse(event.cause_chain)).toEqual([
      {
        name: "Error",
        code: "ECONNRESET",
        message: "CONNECT tunnel failed, response 403",
      },
    ]);
    expect(event.diagnostic_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns the failing response unchanged so the caller still owns the body (#7957)", async () => {
    const { wrap } = loadHelper();
    const inner = async () =>
      new Response('{"error":"nope"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    const response = await wrap(
      inner as unknown as typeof fetch,
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc");

    expect(await response.json()).toEqual({ error: "nope" });
  });

  it("redacts credentials before enforcing the diagnostic body byte bound (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const body = `access_token="access-secret-value" refresh_token="refresh-secret-value" client_secret="client-secret-value" ${"é".repeat(4000)}`;
    const inner = async () =>
      new Response(body, {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    await wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc");
    await waitForDiagnostic(stderr);
    const captured = JSON.parse(emittedEvent(stderr).error_body) as string;

    expect(captured).not.toContain("access-secret-value");
    expect(captured).not.toContain("refresh-secret-value");
    expect(captured).not.toContain("client-secret-value");
    expect(Buffer.byteLength(captured, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("returns before a diagnostic body clone can stall (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const body = new ReadableStream<Uint8Array>({ start: () => {} });
    const response = new Response(body, {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    const inner = async () => response;

    const returned = await Promise.race([
      wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc"),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 50)),
    ]);

    expect(returned).toBe(response);
    await waitForDiagnostic(stderr);
    expect(emittedEvent(stderr).transport_phase).toBe("response_headers");
  });

  it("rethrows a transport failure without retrying it (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    let calls = 0;
    const inner = async () => {
      calls += 1;
      const error = new Error(
        'fetch failed access_token="access-secret-value" refresh_token="refresh-secret-value" client_secret="client-secret-value"',
      );
      Object.assign(error, {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
      throw error;
    };

    await expect(
      wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc"),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(1);
    expect(emittedEvent(stderr).transport_phase).toBe("app_connect");
    expect(emittedEvent(stderr).diagnostic_id).toMatch(/^[0-9a-f]{32}$/);
    expect(stderr.join("")).not.toContain("access-secret-value");
    expect(stderr.join("")).not.toContain("refresh-secret-value");
    expect(stderr.join("")).not.toContain("client-secret-value");
  });

  it("preserves the original failure when diagnostic property access throws (#7957)", async () => {
    const { wrap } = loadHelper();
    const error = new Error("fetch failed");
    Object.defineProperty(error, "code", {
      get: () => {
        throw new Error("hostile error getter");
      },
    });
    const inner = async () => {
      throw error;
    };

    await expect(
      wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc"),
    ).rejects.toBe(error);
  });

  it("classifies a policy denial ahead of its accompanying transport code (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const inner = async () => {
      throw Object.assign(new Error("CONNECT mcp.test:443 not permitted by policy"), {
        code: "ECONNRESET",
      });
    };

    await expect(
      wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc"),
    ).rejects.toThrow();

    expect(emittedEvent(stderr).transport_phase).toBe("policy");
  });

  it("reports proxy configuration without claiming the fetch used it (#7957)", async () => {
    const { wrap, stderr } = loadHelper({
      OPENSHELL_SANDBOX: "1",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: "mcp.test",
    });
    const inner = async () => new Response("", { status: 502 });

    await wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc");
    await waitForDiagnostic(stderr);
    const event = emittedEvent(stderr);

    expect(event.route).toBe("proxy_configured");
    expect(event.proxy).toBe("127.0.0.1:3128");
  });

  it("reports an unknown route when no proxy configuration is visible (#7957)", async () => {
    const { wrap, stderr } = loadHelper({ OPENSHELL_SANDBOX: "1" });
    const inner = async () => new Response("", { status: 502 });

    await wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc");
    await waitForDiagnostic(stderr);

    expect(emittedEvent(stderr).route).toBe("unknown");
  });

  it("mints a distinct diagnostic identifier for each failed response (#7957)", async () => {
    const first = loadHelper();
    const second = loadHelper();
    const inner = async () => new Response("", { status: 502 });

    await first.wrap(
      inner as unknown as typeof fetch,
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc");
    await second.wrap(
      inner as unknown as typeof fetch,
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc");
    await Promise.all([waitForDiagnostic(first.stderr), waitForDiagnostic(second.stderr)]);

    const firstDiagnosticId = emittedEvent(first.stderr).diagnostic_id;
    const secondDiagnosticId = emittedEvent(second.stderr).diagnostic_id;
    expect(firstDiagnosticId).toMatch(/^[0-9a-f]{32}$/);
    expect(secondDiagnosticId).toMatch(/^[0-9a-f]{32}$/);
    expect(firstDiagnosticId).not.toBe(secondDiagnosticId);
  });

  it("reports session presence without the identifier (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const inner = async () => new Response("", { status: 502 });

    await wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc")("https://mcp.test/rpc", {
      headers: { "mcp-session-id": "7f3c9a02-secret-session" },
    });
    await waitForDiagnostic(stderr);

    expect(emittedEvent(stderr).session_present).toBe("true");
    expect(stderr.join("")).not.toContain("7f3c9a02-secret-session");
  });

  it("stays inert outside the sandbox boundary (#7957)", async () => {
    const { wrap, stderr } = loadHelper({});
    const inner = async () => new Response("", { status: 503 });
    const wrapped = wrap(inner as unknown as typeof fetch, "https://mcp.test/rpc");

    expect(wrapped).toBe(inner);
    await wrapped("https://mcp.test/rpc");
    expect(stderr).toEqual([]);
  });
});
