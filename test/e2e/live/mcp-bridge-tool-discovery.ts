// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { FakeMcpHttpsServer } from "./mcp-bridge-servers.ts";

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
        const observed = (rpcMethod: "initialize" | "tools/list") =>
          requests.some(
            (request) =>
              request.method === "POST" &&
              request.path === "/mcp" &&
              request.rpcMethod === rpcMethod &&
              request.auth === `Bearer ${options.expectedSecret}`,
          );
        return {
          initialized: observed("initialize"),
          toolsListed: observed("tools/list"),
          requests: requests.map((request) => ({
            method: request.method,
            path: request.path,
            rpcMethod: request.rpcMethod,
            credentialRewritten: request.auth === `Bearer ${options.expectedSecret}`,
          })),
        };
      },
      { interval: 500, timeout: 90_000, message: options.label },
    )
    .toMatchObject({ initialized: true, toolsListed: true });
}

export async function assertAuthenticatedMcpToolDiscovery(
  host: HostCliClient,
  fakeMcp: FakeMcpHttpsServer,
  options: { sandboxName: string; artifactPrefix: string; hostSecret: string },
): Promise<void> {
  const requestOffset = fakeMcp.requests.length;
  const status = await host.nemoclaw(
    [options.sandboxName, "mcp", "status", "fake", "--tools", "--json"],
    {
      artifactName: `${options.artifactPrefix}-mcp-status-tools-json`,
      env: {
        ...buildAvailabilityProbeEnv(),
        FAKE_MCP_SECRET: options.hostSecret,
      },
      redactionValues: [options.hostSecret],
      timeoutMs: 60_000,
    },
  );
  assertExitZero(status, `${options.artifactPrefix} mcp status --tools --json`);
  const statusJson = JSON.parse(status.stdout) as {
    provider: { credentialResolution?: unknown };
    toolDiscovery: {
      ok: boolean;
      count: number;
      tools: string[];
      truncated: boolean;
      detail?: string;
    };
  };
  expect(statusJson.provider.credentialResolution).toBeUndefined();
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
