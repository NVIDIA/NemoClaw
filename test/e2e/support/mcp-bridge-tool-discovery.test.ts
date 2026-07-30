// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { FakeMcpRequest } from "../live/mcp-bridge-servers.ts";
import { hasSuccessfulAuthenticatedMcpDiscovery } from "../live/mcp-bridge-tool-discovery.ts";

const EXPECTED_SECRET = "expected-secret";
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
    ["initialize HTTP response", "initialize", { responseStatus: 401 }],
    ["tools/list JSON-RPC response", "tools/list", { responseHasResult: false }],
  ])("rejects a failed %s", (_failure, failedMethod, response) => {
    const requests = [
      successfulInitialize(),
      request("notifications/initialized"),
      request("tools/list"),
    ];
    const failedRequest = requests.find((candidate) => candidate.rpcMethod === failedMethod);
    if (!failedRequest) throw new Error(`missing ${failedMethod} fixture request`);
    Object.assign(failedRequest, response);

    expect(hasSuccessfulAuthenticatedMcpDiscovery(requests, EXPECTED_SECRET)).toBe(false);
  });
});
