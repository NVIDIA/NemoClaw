// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  buildMcpToolDiscoveryAuthorizationPlaceholder,
  createBoundedMcpFetch,
  MCP_TOOL_DISCOVERY_LIMITS,
  type McpToolDiscoveryResult,
  normalizeMcpToolPage,
  runMcpToolDiscoverySession,
} from "./tool-discovery-core.ts";

interface ObservedRequest {
  httpMethod: string;
  rpcMethod?: string;
  accept?: string;
  authorization?: string;
  protocolVersion?: string;
  sessionId?: string;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("discovers tools from case-variant SSE response media types (#7726)", async () => {
  const observed: ObservedRequest[] = [];
  const sessionId = "case-variant-sse-session";
  const server = http.createServer(async (request, response) => {
    const bodyChunks: Buffer[] = [];
    for await (const chunk of request) {
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    let payload: { id?: string | number; method?: string; params?: { protocolVersion?: string } } =
      {};
    try {
      payload = JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as typeof payload;
    } catch {
      // GET and DELETE requests have no JSON body.
    }

    observed.push({
      httpMethod: request.method ?? "",
      ...(payload.method ? { rpcMethod: payload.method } : {}),
      ...(request.headers.accept ? { accept: request.headers.accept } : {}),
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(typeof request.headers["mcp-protocol-version"] === "string"
        ? { protocolVersion: request.headers["mcp-protocol-version"] }
        : {}),
      ...(typeof request.headers["mcp-session-id"] === "string"
        ? { sessionId: request.headers["mcp-session-id"] }
        : {}),
    });

    if (request.method === "GET") {
      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (payload.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }

    const result =
      payload.method === "initialize"
        ? {
            protocolVersion: payload.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "case-variant-sse", version: "1.0.0" },
          }
        : {
            tools: [{ name: "sse_tool", inputSchema: { type: "object" } }],
          };
    response.writeHead(200, {
      "Content-Type": "Text/Event-Stream; Charset=UTF-8",
      ...(payload.method === "initialize" ? { "Mcp-Session-Id": sessionId } : {}),
    });
    response.end(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result,
      })}\n\n`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const deadlineSignal = AbortSignal.timeout(MCP_TOOL_DISCOVERY_LIMITS.maxTotalTimeMs);
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    {
      fetch: createBoundedMcpFetch(globalThis.fetch, deadlineSignal),
      requestInit: {
        headers: {
          authorization: buildMcpToolDiscoveryAuthorizationPlaceholder("EXAMPLE_MCP_TOKEN"),
        },
        redirect: "manual",
      },
      reconnectionOptions: {
        maxReconnectionDelay: 1,
        initialReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    },
  );
  const client = new Client(
    { name: "nemoclaw-mcp-tool-discovery-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const requestOptions = {
    signal: deadlineSignal,
    timeout: MCP_TOOL_DISCOVERY_LIMITS.maxRequestTimeMs,
    maxTotalTimeout: MCP_TOOL_DISCOVERY_LIMITS.maxTotalTimeMs,
  };
  let published: McpToolDiscoveryResult | undefined;

  try {
    await runMcpToolDiscoverySession({
      connect: () => client.connect(transport, requestOptions),
      loadPage: async (cursor) =>
        normalizeMcpToolPage(
          await client.listTools(cursor ? { cursor } : undefined, requestOptions),
        ),
      hasSession: () => Boolean(transport.sessionId),
      terminateSession: () => transport.terminateSession(),
      close: () => client.close(),
      publishResult: (result) => {
        published = result;
      },
    });
  } finally {
    await closeServer(server);
  }

  assert.deepEqual(published, {
    ok: true,
    count: 1,
    tools: ["sse_tool"],
    truncated: false,
  });
  const initialize = observed.find((request) => request.rpcMethod === "initialize");
  assert.equal(initialize?.accept, "application/json, text/event-stream");
  assert.equal(initialize?.authorization, "Bearer openshell:resolve:env:EXAMPLE_MCP_TOKEN");
  const toolsList = observed.find((request) => request.rpcMethod === "tools/list");
  assert.equal(toolsList?.sessionId, sessionId);
  const initialized = observed.find((request) => request.rpcMethod === "notifications/initialized");
  assert.ok(initialized?.protocolVersion);
  assert.equal(toolsList?.protocolVersion, initialized.protocolVersion);
  const deletion = observed.find((request) => request.httpMethod === "DELETE");
  assert.equal(deletion?.sessionId, sessionId);
  assert.equal(deletion?.protocolVersion, initialized.protocolVersion);
});
