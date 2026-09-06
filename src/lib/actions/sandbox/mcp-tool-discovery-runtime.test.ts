// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildMcpToolDiscoveryAuthorizationPlaceholder,
  createBoundedMcpFetch,
  enumerateMcpToolNames,
  MCP_TOOL_DISCOVERY_LIMITS,
  MCP_TOOL_DISCOVERY_PROTOCOL,
  mcpToolDiscoveryFailure,
  normalizeMcpToolPage,
  parseMcpToolDiscoveryArguments,
  runMcpToolDiscoverySession,
  safeToolDiscoveryErrorDetail,
  ToolDiscoveryRuntimeError,
} from "../../../../tools/mcp-tool-discovery-runtime/tool-discovery-core.ts";
import {
  MCP_TOOL_DISCOVERY_MAX_NAME_BYTES,
  MCP_TOOL_DISCOVERY_MAX_TOOLS,
  MCP_TOOL_DISCOVERY_RESULT_PROTOCOL,
} from "./mcp-bridge-tool-discovery";
import { validateMcpCredentialEnvName } from "./mcp-bridge-validation";

describe("shared MCP tool discovery runtime", () => {
  it.each(Array.from(["not-valid", "1TOKEN", `A${"a".repeat(128)}`], (value) => [value]))(
    "accepts canonical credential key names and rejects authorization values [case %#]",
    (credentialEnv) => {
      expect(() =>
        parseMcpToolDiscoveryArguments([
          "--url",
          "https://malicious.example.test/mcp",
          "--authorization",
          "arbitrary-format-secret-that-the-server-would-echo",
        ]),
      ).toThrow("invalid arguments");
      ["EXAMPLE_MCP_TOKEN", "lowercase_token", "_TOKEN", `A${"a".repeat(127)}`].forEach(
        (credentialEnv) => {
          expect(() => validateMcpCredentialEnvName(credentialEnv)).not.toThrow();
          expect(
            parseMcpToolDiscoveryArguments([
              "--url",
              "https://example.test/mcp",
              "--credential-env",
              credentialEnv,
            ]),
          ).toEqual({
            url: new URL("https://example.test/mcp"),
            credentialEnv,
          });
        },
      );
      expect(
        buildMcpToolDiscoveryAuthorizationPlaceholder(
          "EXAMPLE_MCP_TOKEN",
          "openshell:resolve:env:EXAMPLE_MCP_TOKEN",
        ),
      ).toBe("Bearer openshell:resolve:env:EXAMPLE_MCP_TOKEN");
      expect(
        buildMcpToolDiscoveryAuthorizationPlaceholder(
          "EXAMPLE_MCP_TOKEN",
          "openshell:resolve:env:v14429878272859325890_EXAMPLE_MCP_TOKEN",
        ),
      ).toBe("Bearer openshell:resolve:env:v14429878272859325890_EXAMPLE_MCP_TOKEN");
      expect(() => validateMcpCredentialEnvName(credentialEnv)).toThrow();
      expect(
        buildMcpToolDiscoveryAuthorizationPlaceholder(
          credentialEnv,
          `openshell:resolve:env:${credentialEnv}`,
        ),
      ).toBeNull();
      expect(() =>
        parseMcpToolDiscoveryArguments([
          "--url",
          "https://example.test/mcp",
          "--credential-env",
          credentialEnv,
        ]),
      ).toThrow("invalid arguments");
    },
  );

  it.each([
    undefined,
    "raw-secret",
    "openshell:resolve:env:v42_OTHER_MCP_TOKEN",
    "openshell:resolve:env:vbad_EXAMPLE_MCP_TOKEN",
    "openshell:resolve:env:v144298782728593258901_EXAMPLE_MCP_TOKEN",
    "openshell:resolve:env:v42_EXAMPLE_MCP_TOKEN\nAuthorization: Bearer raw-secret",
  ])("rejects unsafe live credential values [case %#]", (runtimeValue) => {
    expect(
      buildMcpToolDiscoveryAuthorizationPlaceholder("EXAMPLE_MCP_TOKEN", runtimeValue),
    ).toBeNull();
  });

  it("enumerates every page and returns deterministic names only", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [{ name: "zeta", description: "discard me" }],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({ tools: [{ name: "alpha" }] });

    await expect(enumerateMcpToolNames(loadPage)).resolves.toEqual({
      ok: true,
      count: 2,
      tools: ["alpha", "zeta"],
      truncated: false,
    });
    expect(loadPage).toHaveBeenNthCalledWith(1, undefined);
    expect(loadPage).toHaveBeenNthCalledWith(2, "next");
  });

  it("fails closed on duplicate names and repeated cursors", async () => {
    await expect(
      enumerateMcpToolNames(async () => ({
        tools: [{ name: "same" }, { name: "same" }],
      })),
    ).rejects.toMatchObject({ code: "invalid-response" });

    let page = 0;
    await expect(
      enumerateMcpToolNames(async () => {
        page += 1;
        return { tools: [{ name: `tool-${page}` }], nextCursor: "repeat" };
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });

    await expect(
      enumerateMcpToolNames(async () => normalizeMcpToolPage({ tools: [], nextCursor: "" })),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(
      enumerateMcpToolNames(async () =>
        normalizeMcpToolPage({ tools: [], nextCursor: "bad\ud800cursor" }),
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([
    "",
    "bad\nname",
    "bad\ud800name",
    "x".repeat(MCP_TOOL_DISCOVERY_LIMITS.maxToolNameBytes + 1),
  ])(
    "rejects empty, malformed, control-bearing, and overlong tool names [case %#]",
    async (name) => {
      await expect(
        enumerateMcpToolNames(async () => ({ tools: [{ name }] })),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it("returns an explicit partial failure at tool and page safety limits", async () => {
    const tools = Array.from({ length: MCP_TOOL_DISCOVERY_LIMITS.maxTools + 1 }, (_, index) => ({
      name: `tool-${String(index).padStart(3, "0")}`,
    }));
    await expect(enumerateMcpToolNames(async () => ({ tools }))).resolves.toMatchObject({
      ok: false,
      count: MCP_TOOL_DISCOVERY_LIMITS.maxTools,
      truncated: true,
      detail: expect.stringContaining("tool safety limit"),
    });

    let page = 0;
    await expect(
      enumerateMcpToolNames(async () => {
        page += 1;
        return { tools: [], nextCursor: `cursor-${page}` };
      }),
    ).resolves.toEqual({
      ok: false,
      count: 0,
      tools: [],
      truncated: true,
      detail: `tool discovery reached the ${MCP_TOOL_DISCOVERY_LIMITS.maxPages}-page safety limit`,
      failedStage: "tool-discovery",
      failureClass: "tool-operation",
    });
  });

  it("attempts session termination before closing after successful discovery", async () => {
    const lifecycle: string[] = [];
    const publishResult = vi.fn(() => {
      lifecycle.push("publish");
    });
    const terminateSession = vi.fn(async () => {
      lifecycle.push("terminate");
    });
    const close = vi.fn(async () => {
      lifecycle.push("close");
    });

    await runMcpToolDiscoverySession({
      connect: vi.fn(async () => undefined),
      loadPage: vi.fn(async () => ({ tools: [{ name: "alpha" }] })),
      hasSession: () => true,
      terminateSession,
      close,
      publishResult,
    });

    expect(publishResult).toHaveBeenCalledWith({
      ok: true,
      count: 1,
      tools: ["alpha"],
      truncated: false,
    });
    expect(terminateSession).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(["publish", "terminate", "close"]);
  });

  it("attempts both cleanup operations after failed connected discovery", async () => {
    const terminateSession = vi.fn(async () => {
      throw new Error("untrusted terminate failure");
    });
    const close = vi.fn(async () => {
      throw new Error("untrusted close failure");
    });
    const publishResult = vi.fn();

    await runMcpToolDiscoverySession({
      connect: vi.fn(async () => undefined),
      loadPage: vi.fn(async () => {
        throw new Error("Bearer untrusted discovery failure");
      }),
      hasSession: () => true,
      terminateSession,
      close,
      publishResult,
    });

    expect(terminateSession).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(publishResult).toHaveBeenCalledOnce();
    const result = publishResult.mock.calls[0]?.[0];
    expect(result).toEqual({
      ok: false,
      count: 0,
      tools: [],
      truncated: false,
      detail: "MCP request failed",
      failedStage: "tool-discovery",
      failureClass: "tool-operation",
    });
    expect(JSON.stringify(result)).not.toContain("Bearer");
    expect(JSON.stringify(result)).not.toContain("terminate failure");
    expect(JSON.stringify(result)).not.toContain("close failure");
  });

  it("closes the client after authentication fails during initialization (#10944)", async () => {
    const terminateSession = vi.fn();
    const close = vi.fn(async () => undefined);
    const publishResult = vi.fn();

    await runMcpToolDiscoverySession({
      connect: vi.fn(async () => {
        throw new ToolDiscoveryRuntimeError("http-error", 401);
      }),
      loadPage: vi.fn(),
      hasSession: () => false,
      terminateSession,
      close,
      publishResult,
    });

    expect(terminateSession).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(publishResult).toHaveBeenCalledWith({
      ok: false,
      count: 0,
      tools: [],
      truncated: false,
      detail: "MCP endpoint rejected the request (HTTP 401)",
      failedStage: "initialization",
      failureClass: "authentication",
    });
  });

  it("rejects redirects, HTTP failures, and declared oversized responses before reading bodies", async () => {
    const deadline = AbortSignal.timeout(1_000);
    const redirectFetch = createBoundedMcpFetch(
      async () => new Response(null, { status: 307, headers: { location: "https://other/" } }),
      deadline,
    );
    await expect(redirectFetch("https://example.test/mcp")).rejects.toMatchObject({
      code: "redirect",
    });

    const rejectedFetch = createBoundedMcpFetch(
      async () => new Response("untrusted auth failure", { status: 401 }),
      deadline,
    );
    await expect(rejectedFetch("https://example.test/mcp")).rejects.toMatchObject({
      code: "http-error",
      httpStatus: 401,
    });

    const connectionFailureFetch = createBoundedMcpFetch(
      async () => Promise.reject(new TypeError("untrusted DNS, TLS, or refusal detail")),
      deadline,
    );
    await expect(connectionFailureFetch("https://example.test/mcp")).rejects.toMatchObject({
      code: "connection",
    });

    const oversizedFetch = createBoundedMcpFetch(
      async () =>
        new Response("small", {
          headers: {
            "content-length": String(MCP_TOOL_DISCOVERY_LIMITS.maxResponseBytes + 1),
          },
        }),
      deadline,
    );
    await expect(oversizedFetch("https://example.test/mcp")).rejects.toMatchObject({
      code: "response-too-large",
    });
  });

  it("cancels a chunked response after cumulative bytes cross the limit", async () => {
    const sourceCancel = vi.fn();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        controller.enqueue(
          new Uint8Array(chunk === 1 ? MCP_TOOL_DISCOVERY_LIMITS.maxResponseBytes : 1),
        );
      },
      cancel: sourceCancel,
    });
    const boundedFetch = createBoundedMcpFetch(
      async () => new Response(body),
      AbortSignal.timeout(1_000),
    );

    const response = await boundedFetch("https://example.test/mcp");
    expect(response.headers.get("content-length")).toBeNull();
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "response-too-large",
    });
    expect(sourceCancel).toHaveBeenCalledOnce();
  });

  it("classifies a response-body transport interruption without exposing its error (#10944)", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("untrusted connection interruption"));
      },
    });
    const boundedFetch = createBoundedMcpFetch(
      async () => new Response(body),
      AbortSignal.timeout(1_000),
    );

    const response = await boundedFetch("https://example.test/mcp");
    const error = await response.arrayBuffer().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "connection" });
    expect(JSON.stringify(error)).not.toContain("untrusted connection interruption");
  });

  it.each(["deadline", "request"] as const)(
    "bounds both total-deadline and per-request aborts with a credential-safe timeout [case %#]",
    async (abortSource) => {
      const deadline = new AbortController();
      const request = new AbortController();
      const blockingFetch = vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            expect(signal).toBeDefined();
            const rejectAbort = () =>
              reject(new DOMException("Bearer untrusted-timeout-detail", "AbortError"));
            signal?.addEventListener("abort", rejectAbort, { once: true });
          }),
      );
      const boundedFetch = createBoundedMcpFetch(blockingFetch, deadline.signal);
      const pending = boundedFetch("https://example.test/mcp", { signal: request.signal });
      (abortSource === "deadline" ? deadline : request).abort();
      const error = await pending.catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "timeout" });
      expect(safeToolDiscoveryErrorDetail(error)).toBe("MCP request timed out after 10s");
      expect(safeToolDiscoveryErrorDetail(error)).not.toContain("untrusted-timeout-detail");
    },
  );

  it("maps failures to bounded details without echoing untrusted messages", () => {
    expect(safeToolDiscoveryErrorDetail(new ToolDiscoveryRuntimeError("connection"))).toBe(
      "MCP endpoint connection failed",
    );
    expect(safeToolDiscoveryErrorDetail(new ToolDiscoveryRuntimeError("redirect"))).toBe(
      "MCP endpoint redirect was rejected",
    );
    expect(safeToolDiscoveryErrorDetail(new ToolDiscoveryRuntimeError("http-error", 401))).toBe(
      "MCP endpoint rejected the request (HTTP 401)",
    );
    expect(
      safeToolDiscoveryErrorDetail(
        Object.assign(new Error("remote body contains Bearer secret-value"), { code: 401 }),
      ),
    ).toBe("MCP request failed");
    expect(safeToolDiscoveryErrorDetail(new Error("Bearer secret-value"))).toBe(
      "MCP request failed",
    );
  });

  it.each([
    ["connection", new ToolDiscoveryRuntimeError("connection"), "initialization", "connection"],
    [
      "authentication",
      new ToolDiscoveryRuntimeError("http-error", 401),
      "initialization",
      "authentication",
    ],
    [
      "forbidden authentication",
      new ToolDiscoveryRuntimeError("http-error", 403),
      "initialization",
      "authentication",
    ],
    ["protocol", new ToolDiscoveryRuntimeError("invalid-response"), "tool-discovery", "protocol"],
    ["initialization protocol", new Error("untrusted parse failure"), "initialization", "protocol"],
    [
      "tool operation",
      new Error("untrusted operation failure"),
      "tool-discovery",
      "tool-operation",
    ],
  ] as const)(
    "classifies %s failures without returning untrusted error text (#10944)",
    (_label, error, failedStage, failureClass) => {
      const result = mcpToolDiscoveryFailure(error, failedStage);
      expect(result).toMatchObject({ ok: false, failedStage, failureClass });
      expect(JSON.stringify(result)).not.toContain("untrusted operation failure");
    },
  );

  it("keeps the host parser and image runtime on the same result limits", () => {
    expect(MCP_TOOL_DISCOVERY_RESULT_PROTOCOL).toBe(MCP_TOOL_DISCOVERY_PROTOCOL);
    expect(MCP_TOOL_DISCOVERY_MAX_TOOLS).toBe(MCP_TOOL_DISCOVERY_LIMITS.maxTools);
    expect(MCP_TOOL_DISCOVERY_MAX_NAME_BYTES).toBe(MCP_TOOL_DISCOVERY_LIMITS.maxToolNameBytes);
  });
});
