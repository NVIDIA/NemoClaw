// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  type FakeMcpRequest,
  HERMES_DEFERRED_TOOL_SEARCH_MISS,
  type StartedHttpServer,
  startCompatibleMock,
} from "../live/mcp-bridge-servers.ts";
import { hasSuccessfulAuthenticatedMcpDiscovery } from "../live/mcp-bridge-tool-discovery.ts";

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

interface CompatibleToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface CompatibleMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: CompatibleToolCall[];
}

const COMPATIBLE_API_KEY = "compatible-api-key";
const COMPATIBLE_MODEL = "mock/mcp-bridge";
const DEFERRED_TOOL_NAME = "mcp__fake__fake_echo";
const TOOL_CHALLENGE = "deferred-tool-challenge";
const BRIDGE_TOOLS = ["tool_search", "tool_describe", "tool_call"].map((name) => ({
  type: "function",
  function: { name },
}));

let compatibleMock: StartedHttpServer | undefined;

afterEach(async () => {
  await compatibleMock?.close();
  compatibleMock = undefined;
});

async function startDeferredCompatibleMock(): Promise<StartedHttpServer> {
  return startCompatibleMock({
    apiKey: COMPATIBLE_API_KEY,
    model: COMPATIBLE_MODEL,
    toolChallenge: TOOL_CHALLENGE,
    toolResultToken: EXPECTED_RESULT_TOKEN,
    deferredToolName: DEFERRED_TOOL_NAME,
  });
}

async function requestCompatibleMessage(
  server: StartedHttpServer,
  messages: CompatibleMessage[],
): Promise<CompatibleMessage> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${COMPATIBLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: COMPATIBLE_MODEL, messages, tools: BRIDGE_TOOLS }),
  });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: CompatibleMessage }>;
  };
  const message = payload.choices?.[0]?.message;
  expect(message).toBeDefined();
  messages.push(message as CompatibleMessage);
  return message as CompatibleMessage;
}

function expectToolCall(
  message: CompatibleMessage,
  name: string,
  expectedArguments: Record<string, unknown>,
): CompatibleToolCall {
  expect(message.tool_calls).toHaveLength(1);
  const toolCall = message.tool_calls?.[0];
  expect(toolCall).toMatchObject({ function: { name } });
  expect(JSON.parse(toolCall?.function.arguments ?? "{}")).toEqual(expectedArguments);
  return toolCall as CompatibleToolCall;
}

function recordToolResult(
  messages: CompatibleMessage[],
  toolCall: CompatibleToolCall,
  content: unknown,
): void {
  messages.push({
    role: "tool",
    content: JSON.stringify(content),
    tool_call_id: toolCall.id,
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
    ["an unsuccessful initialize HTTP response", 0, { responseStatus: 401 }],
    ["an initialize response without a negotiated session ID", 0, { negotiatedSessionId: "" }],
    [
      "an initialize response without a negotiated protocol version",
      0,
      { negotiatedProtocolVersion: "" },
    ],
    ["an initialized notification response with HTTP 200", 1, { responseStatus: 200 }],
    ["a tools/list response without a JSON-RPC result", 2, { responseHasResult: false }],
  ])("rejects %s", (_failure, failedRequestIndex, response) => {
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
  it("uses one tool_search, tool_describe, and tool_call when the deferred target is present", async () => {
    compatibleMock = await startDeferredCompatibleMock();
    const messages: CompatibleMessage[] = [{ role: "user", content: "call deferred tool" }];

    const firstSearch = expectToolCall(
      await requestCompatibleMessage(compatibleMock, messages),
      "tool_search",
      { query: DEFERRED_TOOL_NAME },
    );
    expect(firstSearch.id).toBe("call_hermes_tool_search");
    recordToolResult(messages, firstSearch, { matches: [{ name: DEFERRED_TOOL_NAME }] });

    const description = expectToolCall(
      await requestCompatibleMessage(compatibleMock, messages),
      "tool_describe",
      { name: DEFERRED_TOOL_NAME },
    );
    recordToolResult(messages, description, {
      name: DEFERRED_TOOL_NAME,
      parameters: { properties: { challenge: { type: "string" } } },
    });

    const deferredCall = expectToolCall(
      await requestCompatibleMessage(compatibleMock, messages),
      "tool_call",
      {
        name: DEFERRED_TOOL_NAME,
        arguments: { challenge: TOOL_CHALLENGE },
      },
    );
    recordToolResult(messages, deferredCall, EXPECTED_RESULT_TOKEN);

    const finalMessage = await requestCompatibleMessage(compatibleMock, messages);
    expect(finalMessage).toMatchObject({ role: "assistant", content: EXPECTED_RESULT_TOKEN });
    expect(finalMessage.tool_calls).toBeUndefined();
  });

  it("stops after one well-formed tool_search miss", async () => {
    compatibleMock = await startDeferredCompatibleMock();
    const messages: CompatibleMessage[] = [{ role: "user", content: "call deferred tool" }];

    const firstSearch = expectToolCall(
      await requestCompatibleMessage(compatibleMock, messages),
      "tool_search",
      { query: DEFERRED_TOOL_NAME },
    );
    expect(firstSearch.id).toBe("call_hermes_tool_search");
    recordToolResult(messages, firstSearch, { matches: [] });

    const terminalMessage = await requestCompatibleMessage(compatibleMock, messages);
    expect(terminalMessage).toMatchObject({
      role: "assistant",
      content: `mock protocol error: ${HERMES_DEFERRED_TOOL_SEARCH_MISS}`,
    });
    expect(terminalMessage.tool_calls).toBeUndefined();
  });

  it("rejects a malformed tool_search result without retrying", async () => {
    compatibleMock = await startDeferredCompatibleMock();
    const messages: CompatibleMessage[] = [{ role: "user", content: "call deferred tool" }];

    const firstSearch = expectToolCall(
      await requestCompatibleMessage(compatibleMock, messages),
      "tool_search",
      { query: DEFERRED_TOOL_NAME },
    );
    expect(firstSearch.id).toBe("call_hermes_tool_search");
    recordToolResult(messages, firstSearch, { matches: [{ unexpected: true }] });

    const terminalMessage = await requestCompatibleMessage(compatibleMock, messages);
    expect(terminalMessage).toMatchObject({
      role: "assistant",
      content: "mock protocol error: Hermes returned an unexpected deferred tool result sequence",
    });
    expect(terminalMessage.tool_calls).toBeUndefined();
  });
});
