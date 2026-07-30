// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, type CommandExitResult, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  type FakeMcpHttpsServer,
  type FakeMcpRequest,
  HERMES_DEFERRED_TOOL_SEARCH_MISS,
} from "./mcp-bridge-servers.ts";

const HERMES_TOOL_CALL_ATTEMPTS = 15;
const HERMES_TOOL_CALL_RETRY_DELAY_MS = 2_000;

export interface AuthenticatedMcpDiscoveryTarget {
  server: FakeMcpHttpsServer;
  expectedSecret: string;
  label: string;
}

export async function retryHermesToolCallAfterDeferredToolSearchMiss<
  T extends CommandExitResult,
>(options: {
  runAttempt(attempt: number): Promise<T>;
  expectedResultToken: string;
  attempts?: number;
  retryDelayMs?: number;
}): Promise<T> {
  const attempts = options.attempts ?? HERMES_TOOL_CALL_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? HERMES_TOOL_CALL_RETRY_DELAY_MS;
  let result = await options.runAttempt(1);
  for (let attempt = 2; attempt <= attempts; attempt += 1) {
    const output = resultText(result);
    const canRetry =
      result.exitCode === 0 &&
      !output.includes(options.expectedResultToken) &&
      output.includes(`mock protocol error: ${HERMES_DEFERRED_TOOL_SEARCH_MISS}`);
    if (!canRetry) return result;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    result = await options.runAttempt(attempt);
  }
  return result;
}

export async function runMcpToolCallWithHermesRetry(
  sandbox: SandboxClient,
  command: string,
  options: {
    agent: string;
    sandboxName: string;
    artifactName: string;
    expectedResultToken: string;
  },
): Promise<ShellProbeResult> {
  const runAttempt = (attempt: number) =>
    sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(["set -eu", command].join("\n")),
      {
        artifactName:
          attempt === 1 ? options.artifactName : `${options.artifactName}-retry-${attempt - 1}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 5 * 60_000,
      },
    );
  return options.agent === "hermes"
    ? retryHermesToolCallAfterDeferredToolSearchMiss({
        runAttempt,
        expectedResultToken: options.expectedResultToken,
      })
    : runAttempt(1);
}

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
