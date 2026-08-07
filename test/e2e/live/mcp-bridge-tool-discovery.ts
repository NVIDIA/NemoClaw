// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import type { FakeMcpHttpsServer, FakeMcpRequest } from "./mcp-bridge-servers.ts";

export interface AuthenticatedMcpDiscoveryTarget {
  server: FakeMcpHttpsServer;
  expectedSecret: string;
  label: string;
}

const MCP_TOOL_DISCOVERY_TRANSPORT_FAILURE = "MCP tool discovery request failed";
const MCP_TOOL_DISCOVERY_ATTEMPTS = 2;
const MCP_TOOL_DISCOVERY_RETRY_DELAY_MS = 1_000;

export function shouldRetryMcpToolDiscoveryTransportFailure(
  toolDiscovery: { ok: boolean; detail?: string },
  requestsSinceAttempt: readonly FakeMcpRequest[],
  attempt: number,
): boolean {
  return (
    attempt < MCP_TOOL_DISCOVERY_ATTEMPTS &&
    !toolDiscovery.ok &&
    toolDiscovery.detail === MCP_TOOL_DISCOVERY_TRANSPORT_FAILURE &&
    requestsSinceAttempt.length === 0
  );
}

export function shouldRetryMcpDiscoveryAfterRestart(
  requestsSinceAttempt: readonly FakeMcpRequest[],
): boolean {
  return requestsSinceAttempt.length === 0;
}

type McpToolDiscoveryStatusJson = {
  provider: { credentialResolution?: unknown };
  toolDiscovery: {
    ok: boolean;
    count: number;
    tools: string[];
    truncated: boolean;
    detail?: string;
  };
};

export async function assertAuthenticatedMcpRediscovery(
  target: AuthenticatedMcpDiscoveryTarget | undefined,
  requestOffset: number | undefined,
): Promise<void> {
  if (!target || requestOffset === undefined) return;
  await assertAuthenticatedMcpDiscovery(target.server, {
    requestOffset,
    expectedSecret: target.expectedSecret,
    label: target.label,
  });
}

export function hasSuccessfulAuthenticatedMcpDiscovery(
  requests: readonly FakeMcpRequest[],
  expectedSecret: string,
): boolean {
  const authenticatedRequests = requests.filter(
    (request) =>
      request.method === "POST" &&
      request.path === "/mcp" &&
      request.auth === `Bearer ${expectedSecret}`,
  );
  for (const [initializeIndex, initializeRequest] of authenticatedRequests.entries()) {
    if (
      initializeRequest.rpcMethod !== "initialize" ||
      initializeRequest.responseStatus !== 200 ||
      initializeRequest.responseHasResult !== true ||
      !initializeRequest.negotiatedSessionId ||
      !initializeRequest.negotiatedProtocolVersion
    ) {
      continue;
    }
    const hasNegotiatedMetadata = (request: FakeMcpRequest) =>
      request.sessionId === initializeRequest.negotiatedSessionId &&
      request.protocolVersion === initializeRequest.negotiatedProtocolVersion;
    const initializedIndex = authenticatedRequests.findIndex(
      (request, requestIndex) =>
        requestIndex > initializeIndex &&
        request.rpcMethod === "notifications/initialized" &&
        request.responseStatus === 202 &&
        hasNegotiatedMetadata(request),
    );
    if (initializedIndex === -1) continue;
    const toolsListed = authenticatedRequests.some(
      (request, requestIndex) =>
        requestIndex > initializedIndex &&
        request.rpcMethod === "tools/list" &&
        request.responseStatus === 200 &&
        request.responseHasResult === true &&
        hasNegotiatedMetadata(request),
    );
    if (toolsListed) return true;
  }
  return false;
}

export async function assertAuthenticatedMcpDiscovery(
  fakeMcp: FakeMcpHttpsServer,
  options: {
    requestOffset: number;
    expectedSecret: string;
    label: string;
  },
): Promise<void> {
  await expect
    .poll(
      () => {
        const requests = fakeMcp.requests.slice(options.requestOffset);
        return {
          discovered: hasSuccessfulAuthenticatedMcpDiscovery(requests, options.expectedSecret),
          requests: requests.map((request) => ({
            method: request.method,
            path: request.path,
            rpcMethod: request.rpcMethod,
            credentialRewritten: request.auth === `Bearer ${options.expectedSecret}`,
            sessionId: request.sessionId,
            protocolVersion: request.protocolVersion,
            responseStatus: request.responseStatus,
            responseHasResult: request.responseHasResult,
            negotiatedSessionId: request.negotiatedSessionId,
            negotiatedProtocolVersion: request.negotiatedProtocolVersion,
          })),
        };
      },
      { interval: 500, timeout: 90_000, message: options.label },
    )
    .toMatchObject({ discovered: true });
}

type AuthenticatedMcpDiscoveryRestartDeps = {
  assertDiscovery: typeof assertAuthenticatedMcpDiscovery;
};

const AUTHENTICATED_MCP_DISCOVERY_RESTART_DEPS: AuthenticatedMcpDiscoveryRestartDeps = {
  assertDiscovery: assertAuthenticatedMcpDiscovery,
};

export async function assertAuthenticatedMcpDiscoveryWithOneRestart(
  fakeMcp: FakeMcpHttpsServer,
  options: {
    requestOffset: number;
    expectedSecret: string;
    label: string;
    restart: () => Promise<void>;
  },
  deps: AuthenticatedMcpDiscoveryRestartDeps = AUTHENTICATED_MCP_DISCOVERY_RESTART_DEPS,
): Promise<void> {
  try {
    await deps.assertDiscovery(fakeMcp, options);
  } catch (error) {
    if (!shouldRetryMcpDiscoveryAfterRestart(fakeMcp.requests.slice(options.requestOffset))) {
      throw error;
    }
    await options.restart();
    await deps.assertDiscovery(fakeMcp, {
      ...options,
      label: `${options.label} after one bridge restart`,
    });
  }
}

export async function assertAuthenticatedMcpToolDiscovery(
  host: HostCliClient,
  fakeMcp: FakeMcpHttpsServer,
  options: {
    sandboxName: string;
    artifactPrefix: string;
    credentialKey?: string;
    hostSecret: string;
    progress: Pick<TestProgress, "event">;
    serverName?: string;
  },
): Promise<void> {
  const credentialKey = options.credentialKey ?? "FAKE_MCP_SECRET";
  const serverName = options.serverName ?? "fake";
  const requestOffset = fakeMcp.requests.length;
  let status: Awaited<ReturnType<HostCliClient["nemoclaw"]>> | undefined;
  let statusJson: McpToolDiscoveryStatusJson | undefined;
  for (let attempt = 1; attempt <= MCP_TOOL_DISCOVERY_ATTEMPTS; attempt += 1) {
    status = await host.nemoclaw(
      [options.sandboxName, "mcp", "status", serverName, "--tools", "--json"],
      {
        artifactName: `${options.artifactPrefix}-mcp-status-tools-json${attempt === 1 ? "" : `-retry-${attempt}`}`,
        env: {
          ...buildAvailabilityProbeEnv(),
          [credentialKey]: options.hostSecret,
        },
        redactionValues: [options.hostSecret],
        timeoutMs: 60_000,
      },
    );
    assertExitZero(status, `${options.artifactPrefix} mcp status --tools --json`);
    statusJson = JSON.parse(status.stdout) as McpToolDiscoveryStatusJson;
    expect(statusJson.provider.credentialResolution).toBeUndefined();
    if (
      !shouldRetryMcpToolDiscoveryTransportFailure(
        statusJson.toolDiscovery,
        fakeMcp.requests.slice(requestOffset),
        attempt,
      )
    ) {
      break;
    }
    options.progress.event(
      "MCP tool discovery transport failed before reaching the fixture; retrying once",
    );
    await new Promise((resolve) => setTimeout(resolve, MCP_TOOL_DISCOVERY_RETRY_DELAY_MS));
  }
  if (!status || !statusJson) throw new Error("MCP tool discovery did not run");
  expect(statusJson.toolDiscovery).toMatchObject({
    ok: true,
    count: 2,
    tools: ["fake_echo", "fake_status"],
    truncated: false,
  });
  expect(status.stdout).not.toContain(options.hostSecret);
  const discoveryRequests = fakeMcp.requests.slice(requestOffset);
  const discoveryProtocolRequests = discoveryRequests.filter(
    (request) =>
      (request.method === "POST" || request.method === "DELETE") && request.path === "/mcp",
  );
  expect(discoveryProtocolRequests.length).toBeGreaterThan(0);
  expect(
    discoveryProtocolRequests.every((request) => request.auth === `Bearer ${options.hostSecret}`),
  ).toBe(true);
  const discoveryRpcRequests = discoveryProtocolRequests.filter(
    (request) => request.method === "POST" && request.path === "/mcp",
  );
  const authenticatedRpcMethods = discoveryRpcRequests.map((request) => request.rpcMethod);
  const initializeIndex = authenticatedRpcMethods.indexOf("initialize");
  const initializedIndex = authenticatedRpcMethods.indexOf("notifications/initialized");
  const firstToolListIndex = authenticatedRpcMethods.indexOf("tools/list");
  expect(initializeIndex, "authenticated MCP discovery must initialize a session").toBeGreaterThan(
    -1,
  );
  expect(
    initializedIndex,
    "authenticated MCP discovery must notify the server after initialization",
  ).toBeGreaterThan(initializeIndex);
  expect(
    firstToolListIndex,
    "authenticated MCP discovery must finish initialization before listing tools",
  ).toBeGreaterThan(initializedIndex);
  const initializedRequest = discoveryRpcRequests[initializedIndex];
  expect(initializedRequest.sessionId).toMatch(/^fake-session-\d+$/u);
  expect(initializedRequest.protocolVersion).not.toBe("");
  for (const request of discoveryRpcRequests.slice(initializedIndex)) {
    expect(request.sessionId).toBe(initializedRequest.sessionId);
    expect(request.protocolVersion).toBe(initializedRequest.protocolVersion);
  }

  const toolListRequests = discoveryRequests.filter(
    (request) => request.rpcMethod === "tools/list",
  );
  expect(toolListRequests).toHaveLength(2);
  expect(discoveryRequests.some((request) => request.rpcMethod === "tools/call")).toBe(false);
  for (const request of discoveryProtocolRequests.filter(
    (candidate) => candidate.method === "DELETE",
  )) {
    expect(request.sessionId).toBe(initializedRequest.sessionId);
    expect(request.protocolVersion).toBe(initializedRequest.protocolVersion);
  }
  // The method-filtered OpenShell MCP policy does not authorize raw transport
  // DELETE, so SDK session termination is intentionally best effort at this
  // boundary. Unit coverage pins that cleanup attempt; protected E2E proves the
  // negotiated metadata on every post-initialize JSON-RPC request.
}
