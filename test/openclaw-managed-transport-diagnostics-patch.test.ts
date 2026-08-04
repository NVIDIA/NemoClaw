// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  INJECTED_DIAGNOSTIC_HELPER,
  MARKER,
  patchManagedTransportDiagnosticsText,
} from "../scripts/patch-openclaw-managed-transport-diagnostics.mts";

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
    serverName: string,
    serverUrl: string,
  ) => (input: unknown, init?: RequestInit) => Promise<Response>;
  stderr: string[];
}

function loadHelper(env: Record<string, string> = { OPENSHELL_SANDBOX: "1" }): HelperHarness {
  const stderr: string[] = [];
  const context = vm.createContext({
    Headers,
    URL,
    Date,
    Object,
    JSON,
    Number,
    Boolean,
    String,
    Set,
    process: { env, stderr: { write: (chunk: string) => stderr.push(chunk) } },
  });
  const wrap = vm.runInContext(
    `${INJECTED_DIAGNOSTIC_HELPER}\nnemoClawManagedTransportFetch;`,
    context,
  );
  return { wrap, stderr };
}

function emittedEvent(stderr: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stderr.join("").split("\n")) {
    const text = line.replace(/^\[nemoclaw\] /, "");
    const separator = text.indexOf("=");
    if (separator > 0) fields[text.slice(0, separator)] = text.slice(separator + 1);
  }
  return fields;
}

describe("patchManagedTransportDiagnosticsText", () => {
  it("routes the Streamable HTTP fetch through the diagnostic wrapper (#7957)", () => {
    const result = patchManagedTransportDiagnosticsText(bundleMcpRuntimeFixture(), "fixture.js");

    expect(result.status).toBe("patched");
    expect(result.text).toContain(MARKER);
    expect(result.text).toContain(
      "\t\t\tfetch: nemoClawManagedTransportFetch(httpFetch, serverName, resolved.url),",
    );
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
      "docs",
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc");

    expect(response.status).toBe(200);
    expect(stderr).toEqual([]);
  });

  it("classifies a proxy denial and keeps the safe envoy diagnostics (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const inner = async () =>
      new Response("upstream connect error", {
        status: 503,
        headers: {
          "content-type": "text/plain",
          server: "envoy",
          "x-request-id": "req-42",
          "x-envoy-response-flags": "UF,URX",
          "set-cookie": "session=leaky",
        },
      });

    await wrap(
      inner as unknown as typeof fetch,
      "docs",
      "https://mcp.test:8443/rpc",
    )("https://mcp.test:8443/rpc");
    const event = emittedEvent(stderr);

    expect(event.phase).toBe("response_headers");
    expect(event.http_status).toBe("503");
    expect(event.target).toBe("mcp.test:8443");
    expect(event.server).toBe("envoy");
    expect(event["x-request-id"]).toBe("req-42");
    expect(event["x-envoy-response-flags"]).toBe("UF,URX");
    expect(stderr.join("")).not.toContain("session=leaky");
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
      "docs",
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc");

    expect(await response.json()).toEqual({ error: "nope" });
  });

  it("rethrows a transport failure without retrying it (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    let calls = 0;
    const inner = async () => {
      calls += 1;
      const error = new Error("fetch failed");
      Object.assign(error, {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
      throw error;
    };

    await expect(
      wrap(
        inner as unknown as typeof fetch,
        "docs",
        "https://mcp.test/rpc",
      )("https://mcp.test/rpc"),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(1);
    expect(emittedEvent(stderr).phase).toBe("app_connect");
  });

  it("classifies a policy denial ahead of its accompanying transport code (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const inner = async () => {
      throw Object.assign(new Error("CONNECT mcp.test:443 not permitted by policy"), {
        code: "ECONNRESET",
      });
    };

    await expect(
      wrap(
        inner as unknown as typeof fetch,
        "docs",
        "https://mcp.test/rpc",
      )("https://mcp.test/rpc"),
    ).rejects.toThrow();

    expect(emittedEvent(stderr).phase).toBe("policy");
  });

  it("records the proxy route from the sandbox environment (#7957)", async () => {
    const { wrap, stderr } = loadHelper({
      OPENSHELL_SANDBOX: "1",
      HTTPS_PROXY: "http://127.0.0.1:3128",
    });
    const inner = async () => new Response("", { status: 502 });

    await wrap(
      inner as unknown as typeof fetch,
      "docs",
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc");
    const event = emittedEvent(stderr);

    expect(event.route).toBe("trusted_env_proxy");
    expect(event.proxy).toBe("127.0.0.1:3128");
  });

  it("reports session presence without the identifier (#7957)", async () => {
    const { wrap, stderr } = loadHelper();
    const inner = async () => new Response("", { status: 502 });

    await wrap(
      inner as unknown as typeof fetch,
      "docs",
      "https://mcp.test/rpc",
    )("https://mcp.test/rpc", { headers: { "mcp-session-id": "7f3c9a02-secret-session" } });

    expect(emittedEvent(stderr).session_present).toBe("true");
    expect(stderr.join("")).not.toContain("7f3c9a02-secret-session");
  });

  it("stays inert outside the sandbox boundary (#7957)", async () => {
    const { wrap, stderr } = loadHelper({});
    const inner = async () => new Response("", { status: 503 });
    const wrapped = wrap(inner as unknown as typeof fetch, "docs", "https://mcp.test/rpc");

    expect(wrapped).toBe(inner);
    await wrapped("https://mcp.test/rpc");
    expect(stderr).toEqual([]);
  });
});
