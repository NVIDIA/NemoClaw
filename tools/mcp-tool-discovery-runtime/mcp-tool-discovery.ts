// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  buildMcpToolDiscoveryAuthorizationPlaceholder,
  createBoundedMcpFetch,
  MCP_TOOL_DISCOVERY_LIMITS,
  MCP_TOOL_DISCOVERY_PROTOCOL,
  type McpToolDiscoveryResult,
  normalizeMcpToolPage,
  parseMcpToolDiscoveryArguments,
  runMcpToolDiscoverySession,
  ToolDiscoveryRuntimeError,
} from "./tool-discovery-core.ts";

function writeResult(result: McpToolDiscoveryResult): void {
  process.stdout.write(`${JSON.stringify({ protocol: MCP_TOOL_DISCOVERY_PROTOCOL, ...result })}\n`);
}

export function normalizeMcpSdkError(error: unknown): unknown {
  if (error instanceof ToolDiscoveryRuntimeError) return error;
  if (error instanceof McpError) {
    return error.code === ErrorCode.RequestTimeout
      ? new ToolDiscoveryRuntimeError("timeout")
      : error;
  }
  // The SDK exposes malformed JSON, invalid JSON-RPC envelopes, and invalid
  // result schemas as untyped parser errors. They are protocol failures, not
  // remote tool-operation errors.
  return new ToolDiscoveryRuntimeError("invalid-response");
}

async function callMcpSdk<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeMcpSdkError(error);
  }
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
      failedStage: "preflight",
      failureClass: "precondition",
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
      failedStage: "preflight",
      failureClass: "precondition",
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
    connect: () => callMcpSdk(() => client.connect(transport, requestOptions)),
    loadPage: (cursor) =>
      callMcpSdk(async () => {
        const page = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
        return normalizeMcpToolPage(page);
      }),
    hasSession: () => Boolean(transport.sessionId),
    terminateSession: () => transport.terminateSession(),
    close: () => client.close(),
    publishResult: writeResult,
  });
}

const entrypointPath = process.argv[1];
if (
  entrypointPath &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypointPath)
) {
  await main();
}
