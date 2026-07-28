// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildMcpToolDiscoveryAuthorizationPlaceholder,
  createBoundedMcpFetch,
  enumerateMcpToolNames,
  MCP_TOOL_DISCOVERY_LIMITS,
  MCP_TOOL_DISCOVERY_PROTOCOL,
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
  it("accepts canonical credential key names and rejects authorization values", () => {
    expect(() =>
      parseMcpToolDiscoveryArguments([
        "--url",
        "https://malicious.example.test/mcp",
        "--authorization",
        "arbitrary-format-secret-that-the-server-would-echo",
      ]),
    ).toThrow("invalid arguments");
    for (const credentialEnv of [
      "EXAMPLE_MCP_TOKEN",
      "lowercase_token",
      "_TOKEN",
      `A${"a".repeat(127)}`,
    ]) {
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
    }
    expect(buildMcpToolDiscoveryAuthorizationPlaceholder("EXAMPLE_MCP_TOKEN")).toBe(
      "Bearer openshell:resolve:env:EXAMPLE_MCP_TOKEN",
    );
    for (const credentialEnv of ["not-valid", "1TOKEN", `A${"a".repeat(128)}`]) {
      expect(() => validateMcpCredentialEnvName(credentialEnv)).toThrow();
      expect(() =>
        parseMcpToolDiscoveryArguments([
          "--url",
          "https://example.test/mcp",
          "--credential-env",
          credentialEnv,
        ]),
      ).toThrow("invalid arguments");
    }
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

  it("rejects empty, malformed, control-bearing, and overlong tool names", async () => {
    for (const name of [
      "",
      "bad\nname",
      "bad\ud800name",
      "x".repeat(MCP_TOOL_DISCOVERY_LIMITS.maxToolNameBytes + 1),
    ]) {
      await expect(
        enumerateMcpToolNames(async () => ({ tools: [{ name }] })),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

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
      detail: "MCP tool discovery request failed",
    });
    expect(JSON.stringify(result)).not.toContain("Bearer");
    expect(JSON.stringify(result)).not.toContain("terminate failure");
    expect(JSON.stringify(result)).not.toContain("close failure");
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

  it("bounds both total-deadline and per-request aborts with a credential-safe timeout", async () => {
    for (const abortSource of ["deadline", "request"] as const) {
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
      expect(safeToolDiscoveryErrorDetail(error)).toBe("tool discovery timed out after 10s");
      expect(safeToolDiscoveryErrorDetail(error)).not.toContain("untrusted-timeout-detail");
    }
  });

  it("maps failures to bounded details without echoing untrusted messages", () => {
    expect(safeToolDiscoveryErrorDetail(new ToolDiscoveryRuntimeError("redirect"))).toBe(
      "MCP endpoint redirect was rejected",
    );
    expect(safeToolDiscoveryErrorDetail(new ToolDiscoveryRuntimeError("http-error", 401))).toBe(
      "MCP endpoint rejected tool discovery (HTTP 401)",
    );
    expect(
      safeToolDiscoveryErrorDetail(
        Object.assign(new Error("remote body contains Bearer secret-value"), { code: 401 }),
      ),
    ).toBe("MCP tool discovery request failed");
    expect(safeToolDiscoveryErrorDetail(new Error("Bearer secret-value"))).toBe(
      "MCP tool discovery request failed",
    );
  });

  it("keeps the host parser and image runtime on the same result limits", () => {
    expect(MCP_TOOL_DISCOVERY_RESULT_PROTOCOL).toBe(MCP_TOOL_DISCOVERY_PROTOCOL);
    expect(MCP_TOOL_DISCOVERY_MAX_TOOLS).toBe(MCP_TOOL_DISCOVERY_LIMITS.maxTools);
    expect(MCP_TOOL_DISCOVERY_MAX_NAME_BYTES).toBe(MCP_TOOL_DISCOVERY_LIMITS.maxToolNameBytes);
  });
});
