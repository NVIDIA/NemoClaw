// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CommandExitResult } from "../fixtures/clients/command.ts";
import {
  type FakeMcpRequest,
  HERMES_DEFERRED_TOOL_SEARCH_MISS,
} from "../live/mcp-bridge-servers.ts";
import {
  hasSuccessfulAuthenticatedMcpDiscovery,
  retryHermesToolCallAfterDeferredToolSearchMiss,
} from "../live/mcp-bridge-tool-discovery.ts";

const EXPECTED_SECRET = "expected-secret";
const EXPECTED_RESULT_TOKEN = "expected-result";
const SESSION_ID = "fake-session-1";
const PROTOCOL_VERSION = "2025-03-26";

function request(rpcMethod: string, overrides: Partial<FakeMcpRequest> = {}): FakeMcpRequest {
  return {
    method: "POST",
    path: "/mcp",
    auth: `Bearer ${EXPECTED_SECRET}`,
    body: "",
    sessionId: SESSION_ID,
    protocolVersion: PROTOCOL_VERSION,
    rpcMethod,
    responseStatus: rpcMethod === "notifications/initialized" ? 202 : 200,
    responseHasResult: rpcMethod !== "notifications/initialized",
    ...overrides,
  };
}

function successfulInitialize(): FakeMcpRequest {
  return request("initialize", {
    sessionId: "",
    protocolVersion: "",
    negotiatedSessionId: SESSION_ID,
    negotiatedProtocolVersion: PROTOCOL_VERSION,
  });
}

function commandResult(stdout: string, exitCode = 0): CommandExitResult {
  return { stdout, stderr: "", exitCode };
}

describe("authenticated MCP rediscovery evidence", () => {
  it("accepts successful tool discovery in one negotiated session", () => {
    expect(
      hasSuccessfulAuthenticatedMcpDiscovery(
        [successfulInitialize(), request("notifications/initialized"), request("tools/list")],
        EXPECTED_SECRET,
      ),
    ).toBe(true);
  });

  it("rejects tool discovery before session initialization completes", () => {
    expect(
      hasSuccessfulAuthenticatedMcpDiscovery(
        [request("tools/list"), successfulInitialize(), request("notifications/initialized")],
        EXPECTED_SECRET,
      ),
    ).toBe(false);
  });

  it("rejects tool discovery from a different negotiated session", () => {
    expect(
      hasSuccessfulAuthenticatedMcpDiscovery(
        [
          successfulInitialize(),
          request("notifications/initialized"),
          request("tools/list", { sessionId: "fake-session-2" }),
        ],
        EXPECTED_SECRET,
      ),
    ).toBe(false);
  });

  it.each([
    ["initialize HTTP response", 0, { responseStatus: 401 }],
    ["initialized notification response with HTTP 200", 1, { responseStatus: 200 }],
    ["tools/list JSON-RPC response", 2, { responseHasResult: false }],
  ])("rejects a failed %s", (_failure, failedRequestIndex, response) => {
    const requests = [
      successfulInitialize(),
      request("notifications/initialized"),
      request("tools/list"),
    ];
    Object.assign(requests[failedRequestIndex], response);

    expect(hasSuccessfulAuthenticatedMcpDiscovery(requests, EXPECTED_SECRET)).toBe(false);
  });
});

describe("Hermes deferred MCP tool discovery", () => {
  it("retries the tool call when tool_search does not return the deferred target", async () => {
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce(
        commandResult(`mock protocol error: ${HERMES_DEFERRED_TOOL_SEARCH_MISS}`),
      )
      .mockResolvedValueOnce(commandResult(EXPECTED_RESULT_TOKEN));

    const result = await retryHermesToolCallAfterDeferredToolSearchMiss({
      runAttempt,
      expectedResultToken: EXPECTED_RESULT_TOKEN,
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(runAttempt.mock.calls).toEqual([[1], [2]]);
    expect(result.stdout).toBe(EXPECTED_RESULT_TOKEN);
  });

  it.each([
    ["a command failure", commandResult(HERMES_DEFERRED_TOOL_SEARCH_MISS, 1)],
    ["a different protocol error", commandResult("mock protocol error: unexpected result")],
    [
      "a successful result",
      commandResult(
        `${EXPECTED_RESULT_TOKEN}\nmock protocol error: ${HERMES_DEFERRED_TOOL_SEARCH_MISS}`,
      ),
    ],
  ])("does not retry %s", async (_case, firstResult) => {
    const runAttempt = vi.fn().mockResolvedValue(firstResult);

    const result = await retryHermesToolCallAfterDeferredToolSearchMiss({
      runAttempt,
      expectedResultToken: EXPECTED_RESULT_TOKEN,
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(runAttempt.mock.calls).toEqual([[1]]);
    expect(result).toBe(firstResult);
  });

  it("stops after the configured attempt count", async () => {
    const firstResult = commandResult(`mock protocol error: ${HERMES_DEFERRED_TOOL_SEARCH_MISS}`);
    const runAttempt = vi.fn().mockResolvedValue(firstResult);

    const result = await retryHermesToolCallAfterDeferredToolSearchMiss({
      runAttempt,
      expectedResultToken: EXPECTED_RESULT_TOKEN,
      attempts: 3,
      retryDelayMs: 0,
    });

    expect(runAttempt.mock.calls).toEqual([[1], [2], [3]]);
    expect(result).toBe(firstResult);
  });
});
