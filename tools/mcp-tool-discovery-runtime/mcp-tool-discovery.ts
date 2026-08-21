// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  buildMcpToolDiscoveryAuthorizationPlaceholder,
  createBoundedMcpFetch,
  MCP_TOOL_DISCOVERY_LIMITS,
  MCP_TOOL_DISCOVERY_PROTOCOL,
  type McpToolDiscoveryResult,
  normalizeMcpToolPage,
  parseMcpToolDiscoveryArguments,
  runMcpToolDiscoverySession,
} from "./tool-discovery-core.ts";

function writeResult(result: McpToolDiscoveryResult): void {
  process.stdout.write(`${JSON.stringify({ protocol: MCP_TOOL_DISCOVERY_PROTOCOL, ...result })}\n`);
}

async function main(): Promise<void> {
  let runtimeArguments: { url: URL; credentialEnv: string };
  try {
    runtimeArguments = parseMcpToolDiscoveryArguments(process.argv.slice(2));
  } catch {
    writeResult({
      ok: false,
      count: 0,
      tools: [],
      truncated: false,
      detail: "tool discovery received invalid runtime arguments",
    });
    return;
  }

  const deadlineSignal = AbortSignal.timeout(MCP_TOOL_DISCOVERY_LIMITS.maxTotalTimeMs);
  const boundedFetch = createBoundedMcpFetch(globalThis.fetch, deadlineSignal);
  // check-direct-credential-env-ignore -- this boundary accepts only the exact
  // key-bound OpenShell placeholder syntax below; raw credentials fail closed
  // and are never placed in argv, output, or a network request.
  const authorization = buildMcpToolDiscoveryAuthorizationPlaceholder(
    runtimeArguments.credentialEnv,
    process.env[runtimeArguments.credentialEnv],
  );
  if (!authorization) {
    writeResult({
      ok: false,
      count: 0,
      tools: [],
      truncated: false,
      detail: "managed MCP credential placeholder is unavailable",
    });
    return;
  }
  const transport = new StreamableHTTPClientTransport(runtimeArguments.url, {
    fetch: boundedFetch,
    requestInit: {
      headers: {
        authorization,
      },
      redirect: "manual",
    },
    reconnectionOptions: {
      maxReconnectionDelay: 1,
      initialReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client(
    { name: "nemoclaw-mcp-tool-discovery", version: "1.0.0" },
    { capabilities: {} },
  );
  const requestOptions = {
    signal: deadlineSignal,
    timeout: MCP_TOOL_DISCOVERY_LIMITS.maxRequestTimeMs,
    maxTotalTimeout: MCP_TOOL_DISCOVERY_LIMITS.maxTotalTimeMs,
  };

  await runMcpToolDiscoverySession({
    connect: () => client.connect(transport, requestOptions),
    loadPage: async (cursor) => {
      const page = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
      return normalizeMcpToolPage(page);
    },
    hasSession: () => Boolean(transport.sessionId),
    terminateSession: () => transport.terminateSession(),
    close: () => client.close(),
    publishResult: writeResult,
  });
}

await main();
