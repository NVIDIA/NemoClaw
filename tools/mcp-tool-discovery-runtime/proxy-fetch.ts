// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

import { createBoundedMcpFetch, type ToolDiscoveryFetch } from "./tool-discovery-core.ts";

export interface McpToolDiscoveryFetchSession {
  fetch: ToolDiscoveryFetch;
  close: () => Promise<void>;
}

/**
 * Build a session-scoped, lock-pinned proxy transport for MCP discovery.
 *
 * Node's image-bundled fetch implementation and its NODE_USE_ENV_PROXY gate
 * vary with the Node release carried by each managed image. OpenShell v0.0.101
 * exposed that dependency as a pre-request discovery failure on an otherwise
 * admitted trusted-private route (#8746). Use the reviewed Undici transport
 * directly so every managed agent gets the same HTTP CONNECT implementation.
 * The dispatcher remains local to this one names-only discovery session and
 * still reads the trusted proxy and NO_PROXY environment sourced by the host
 * command; it does not replace the process-global dispatcher.
 */
export function createMcpToolDiscoveryFetchSession(
  deadlineSignal: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
): McpToolDiscoveryFetchSession {
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: environment.http_proxy ?? environment.HTTP_PROXY ?? "",
    httpsProxy: environment.https_proxy ?? environment.HTTPS_PROXY ?? "",
    noProxy: environment.no_proxy ?? environment.NO_PROXY ?? "",
  });
  const fetchWithDispatcher = (async (input, init) => {
    const undiciInit = {
      ...(init as object),
      dispatcher,
    } as Parameters<typeof undiciFetch>[1];
    return (await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      undiciInit,
    )) as unknown as Response;
  }) as ToolDiscoveryFetch;

  return {
    fetch: createBoundedMcpFetch(fetchWithDispatcher, deadlineSignal),
    close: async () => {
      await dispatcher.close();
    },
  };
}
