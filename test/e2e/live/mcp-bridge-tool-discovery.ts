// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
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
  // The caller captures its observation offset after public-tunnel readiness.
  // Every later request arrival is terminal, including an incomplete body,
  // HEAD, or malformed JSON without an rpcMethod.
  return requestsSinceAttempt.length === 0;
}

type McpToolDiscoveryStatusJson = {
  provider: Record<string, unknown> & {
    registryPresent: boolean;
    gatewayPresent: boolean | null;
    attached: boolean | null;
    credentialReady: boolean | null;
    credentialResolution?: unknown;
  };
  policy: Record<string, unknown> & {
    registryPresent: boolean;
    gatewayPresent: boolean | null;
  };
  adapter: Record<string, unknown> & {
    registered: boolean | null;
    detail?: unknown;
  };
  trustedPrivateTarget?: Record<string, unknown> & {
    state: "match" | "drift" | "unresolved";
    detail?: unknown;
  };
  toolDiscovery: Record<string, unknown> & {
    ok: boolean;
    count: number;
    tools: string[];
    truncated: boolean;
    detail?: string;
  };
};

function buildMcpToolDiscoveryDiagnostics(
  status: McpToolDiscoveryStatusJson,
  requests: readonly FakeMcpRequest[],
  expectedSecret: string,
): Record<string, unknown> {
  return {
    provider: {
      registryPresent: status.provider.registryPresent,
      gatewayPresent: status.provider.gatewayPresent,
      attached: status.provider.attached,
      credentialReady: status.provider.credentialReady,
      credentialResolutionPresent: status.provider.credentialResolution !== undefined,
    },
    policy: {
      registryPresent: status.policy.registryPresent,
      gatewayPresent: status.policy.gatewayPresent,
    },
    adapter: {
      registered: status.adapter.registered,
      detailPresent: status.adapter.detail !== undefined,
    },
    trustedPrivateTarget: status.trustedPrivateTarget
      ? {
          state: status.trustedPrivateTarget.state,
          detailPresent: status.trustedPrivateTarget.detail !== undefined,
        }
      : null,
    toolDiscovery: {
      ok: status.toolDiscovery.ok,
      count: status.toolDiscovery.count,
      tools: [...status.toolDiscovery.tools],
      truncated: status.toolDiscovery.truncated,
      ...(status.toolDiscovery.detail !== undefined ? { detail: status.toolDiscovery.detail } : {}),
    },
    requests: requests.map((request) => ({
      httpMethod: request.method,
      rpcMethod: request.rpcMethod ?? null,
      transport:
        request.legacySessionId || request.negotiatedLegacySessionId
          ? "legacy-sse"
          : "streamable-http",
      responseStatus: request.responseStatus ?? null,
      responseHasResult: request.responseHasResult ?? null,
      rpcIdPresent: request.rpcId !== undefined,
      legacyPhase: request.legacyPhase ?? null,
      legacyResponseSequence: request.legacyResponseSequence ?? null,
      sessionMetadataPresent: {
        sessionId: Boolean(request.sessionId),
        protocolVersion: Boolean(request.protocolVersion),
        negotiatedSessionId: Boolean(request.negotiatedSessionId),
        negotiatedProtocolVersion: Boolean(request.negotiatedProtocolVersion),
        legacySessionId: Boolean(request.legacySessionId),
        negotiatedLegacySessionId: Boolean(request.negotiatedLegacySessionId),
      },
      credentialRewriteMatched: request.auth === `Bearer ${expectedSecret}`,
    })),
  };
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
  const isAuthenticatedMcpRequest = (request: FakeMcpRequest): boolean =>
    request.path === "/mcp" && request.auth === `Bearer ${expectedSecret}`;
  for (const [initializeIndex, initializeRequest] of requests.entries()) {
    if (
      !isAuthenticatedMcpRequest(initializeRequest) ||
      initializeRequest.method !== "POST" ||
      initializeRequest.rpcMethod !== "initialize" ||
      initializeRequest.responseHasResult !== true ||
      !initializeRequest.negotiatedProtocolVersion
    ) {
      continue;
    }
    if (initializeRequest.legacySessionId) {
      if (
        initializeRequest.responseStatus !== 202 ||
        initializeRequest.sessionId !== "" ||
        initializeRequest.protocolVersion !== "" ||
        initializeRequest.rpcId === undefined
      ) {
        continue;
      }
      const eventStreamIndex = requests.findIndex(
        (request, requestIndex) =>
          requestIndex < initializeIndex &&
          isAuthenticatedMcpRequest(request) &&
          request.method === "GET" &&
          request.responseStatus === 200 &&
          request.negotiatedLegacySessionId === initializeRequest.legacySessionId,
      );
      if (eventStreamIndex === -1) continue;
      const hasNegotiatedLegacyMetadata = (request: FakeMcpRequest): boolean =>
        isAuthenticatedMcpRequest(request) &&
        request.method === "POST" &&
        request.legacySessionId === initializeRequest.legacySessionId &&
        request.sessionId === "" &&
        request.protocolVersion === initializeRequest.negotiatedProtocolVersion;
      const initializedIndex = requests.findIndex(
        (request, requestIndex) =>
          requestIndex > initializeIndex &&
          request.rpcMethod === "notifications/initialized" &&
          request.responseStatus === 202 &&
          hasNegotiatedLegacyMetadata(request),
      );
      if (initializedIndex === -1) continue;
      const toolsListed = requests.some(
        (request, requestIndex) =>
          requestIndex > initializedIndex &&
          request.rpcMethod === "tools/list" &&
          request.rpcId !== undefined &&
          request.responseStatus === 202 &&
          request.responseHasResult === true &&
          hasNegotiatedLegacyMetadata(request),
      );
      if (toolsListed) return true;
      continue;
    }
    if (initializeRequest.responseStatus !== 200 || !initializeRequest.negotiatedSessionId) {
      continue;
    }
    const hasNegotiatedMetadata = (request: FakeMcpRequest) =>
      isAuthenticatedMcpRequest(request) &&
      request.method === "POST" &&
      request.sessionId === initializeRequest.negotiatedSessionId &&
      request.protocolVersion === initializeRequest.negotiatedProtocolVersion;
    const initializedIndex = requests.findIndex(
      (request, requestIndex) =>
        requestIndex > initializeIndex &&
        request.rpcMethod === "notifications/initialized" &&
        request.responseStatus === 202 &&
        hasNegotiatedMetadata(request),
    );
    if (initializedIndex === -1) continue;
    const toolsListed = requests.some(
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
            legacySessionId: request.legacySessionId,
            negotiatedLegacySessionId: request.negotiatedLegacySessionId,
            legacyPhase: request.legacyPhase,
            legacyResponseSequence: request.legacyResponseSequence,
            rpcId: request.rpcId,
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

type McpDiscoveryRestartAttemptEvidence = {
  attempt: number;
  requestCount: number;
  classification:
    | "authenticated-discovery-complete"
    | "no-request-observed"
    | "request-observed"
    | "restart-failed"
    | "discovery-incomplete-after-restart";
  restartDecision: "not-needed" | "restart-once" | "no-restart";
  outcome: "passed" | "retrying" | "failed";
};

type McpDiscoveryRestartFinalOutcome =
  | "passed-first-attempt"
  | "failed-no-restart"
  | "restart-failed"
  | "passed-after-restart"
  | "failed-after-restart";

const AUTHENTICATED_MCP_DISCOVERY_RESTART_DEPS: AuthenticatedMcpDiscoveryRestartDeps = {
  assertDiscovery: assertAuthenticatedMcpDiscovery,
};

export async function assertAuthenticatedMcpDiscoveryWithOneRestart(
  fakeMcp: FakeMcpHttpsServer,
  options: {
    requestOffset: number;
    observationOffset: number;
    expectedSecret: string;
    label: string;
    restart: () => Promise<void>;
    artifacts: Pick<ArtifactSink, "writeJson">;
    artifactName: string;
  },
  deps: AuthenticatedMcpDiscoveryRestartDeps = AUTHENTICATED_MCP_DISCOVERY_RESTART_DEPS,
): Promise<void> {
  const attempts: McpDiscoveryRestartAttemptEvidence[] = [];
  const observedRequests = (): readonly FakeMcpRequest[] =>
    fakeMcp.observations.slice(options.observationOffset);
  const writeEvidence = (finalOutcome: McpDiscoveryRestartFinalOutcome): Promise<string> =>
    options.artifacts.writeJson(options.artifactName, {
      schemaVersion: 1,
      attempts,
      finalOutcome,
    });
  const throwTerminalFailure = async (
    finalOutcome: McpDiscoveryRestartFinalOutcome,
    terminalError: unknown,
  ): Promise<never> => {
    try {
      await writeEvidence(finalOutcome);
    } catch (evidenceError) {
      throw Object.assign(
        new AggregateError(
          [terminalError, evidenceError],
          `Hermes initial MCP discovery result is ${finalOutcome}; retry evidence write failed`,
          { cause: terminalError },
        ),
        { evidenceStatus: "write-failed" as const, finalOutcome },
      );
    }
    throw terminalError;
  };
  const firstAttempt = await deps.assertDiscovery(fakeMcp, options).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  if (firstAttempt.ok) {
    attempts.push({
      attempt: 1,
      requestCount: observedRequests().length,
      classification: "authenticated-discovery-complete",
      restartDecision: "not-needed",
      outcome: "passed",
    });
    await writeEvidence("passed-first-attempt");
    return;
  }
  const requests = observedRequests();
  if (!shouldRetryMcpDiscoveryAfterRestart(requests)) {
    attempts.push({
      attempt: 1,
      requestCount: requests.length,
      classification: "request-observed",
      restartDecision: "no-restart",
      outcome: "failed",
    });
    return throwTerminalFailure("failed-no-restart", firstAttempt.error);
  }
  attempts.push({
    attempt: 1,
    requestCount: 0,
    classification: "no-request-observed",
    restartDecision: "restart-once",
    outcome: "retrying",
  });
  try {
    await options.restart();
  } catch (restartError) {
    attempts.push({
      attempt: 2,
      requestCount: observedRequests().length,
      classification: "restart-failed",
      restartDecision: "no-restart",
      outcome: "failed",
    });
    return throwTerminalFailure("restart-failed", restartError);
  }
  const retryAttempt = await deps
    .assertDiscovery(fakeMcp, {
      ...options,
      label: `${options.label} after one bridge restart`,
    })
    .then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
  if (retryAttempt.ok) {
    attempts.push({
      attempt: 2,
      requestCount: observedRequests().length,
      classification: "authenticated-discovery-complete",
      restartDecision: "not-needed",
      outcome: "passed",
    });
    await writeEvidence("passed-after-restart");
    return;
  }
  attempts.push({
    attempt: 2,
    requestCount: observedRequests().length,
    classification: "discovery-incomplete-after-restart",
    restartDecision: "no-restart",
    outcome: "failed",
  });
  return throwTerminalFailure("failed-after-restart", retryAttempt.error);
}

export async function runHermesInitialMcpReadiness(operations: {
  discover: () => Promise<void>;
  inspectToolStatus: () => Promise<void>;
  prepareModelTurn: () => Promise<void>;
  runModelTurn: () => Promise<void>;
}): Promise<void> {
  await operations.discover();
  await operations.inspectToolStatus();
  await operations.prepareModelTurn();
  await operations.runModelTurn();
}

export async function assertAuthenticatedMcpToolDiscovery(
  host: HostCliClient,
  fakeMcp: FakeMcpHttpsServer,
  options: {
    artifacts: Pick<ArtifactSink, "writeJson">;
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
  const discoveryRequests = fakeMcp.requests.slice(requestOffset);
  await options.artifacts.writeJson(
    `${options.artifactPrefix}-mcp-tool-discovery-diagnostics.json`,
    buildMcpToolDiscoveryDiagnostics(statusJson, discoveryRequests, options.hostSecret),
  );
  expect(statusJson.provider.credentialResolution).toBeUndefined();
  expect(statusJson.toolDiscovery).toMatchObject({
    ok: true,
    count: 2,
    tools: ["fake_echo", "fake_status"],
    truncated: false,
  });
  expect(status.stdout).not.toContain(options.hostSecret);
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
  const initializeRequest = discoveryRpcRequests[initializeIndex];
  const initializedRequest = discoveryRpcRequests[initializedIndex];
  if (initializeRequest.legacySessionId) {
    expect(initializeRequest.responseStatus).toBe(202);
    expect(initializeRequest.responseHasResult).toBe(true);
    expect(initializeRequest.rpcId).not.toBeUndefined();
    expect(initializeRequest.sessionId).toBe("");
    expect(initializeRequest.protocolVersion).toBe("");
    expect(initializeRequest.negotiatedProtocolVersion).not.toBe("");
    const initializeRequestIndex = discoveryRequests.indexOf(initializeRequest);
    const eventStreamRequest = discoveryRequests.find(
      (request, requestIndex) =>
        requestIndex < initializeRequestIndex &&
        request.method === "GET" &&
        request.path === "/mcp" &&
        request.auth === `Bearer ${options.hostSecret}` &&
        request.responseStatus === 200 &&
        request.negotiatedLegacySessionId === initializeRequest.legacySessionId,
    );
    expect(
      eventStreamRequest,
      "legacy SSE discovery must correlate its authenticated GET with the POST endpoint",
    ).toBeDefined();
    for (const request of discoveryRpcRequests.slice(initializedIndex)) {
      expect(request.legacySessionId).toBe(initializeRequest.legacySessionId);
      expect(request.sessionId).toBe("");
      expect(request.protocolVersion).toBe(initializeRequest.negotiatedProtocolVersion);
    }
    for (const request of discoveryRpcRequests.filter(
      (candidate) => candidate.rpcMethod === "tools/list",
    )) {
      expect(request.rpcId).not.toBeUndefined();
      expect(request.legacyResponseSequence).toBeGreaterThan(0);
    }
  } else {
    expect(initializedRequest.sessionId).toMatch(/^fake-session-\d+$/u);
    expect(initializedRequest.protocolVersion).not.toBe("");
    for (const request of discoveryRpcRequests.slice(initializedIndex)) {
      expect(request.sessionId).toBe(initializedRequest.sessionId);
      expect(request.protocolVersion).toBe(initializedRequest.protocolVersion);
    }
  }

  const toolListRequests = discoveryRequests.filter(
    (request) => request.rpcMethod === "tools/list",
  );
  expect(toolListRequests).toHaveLength(2);
  expect(discoveryRequests.some((request) => request.rpcMethod === "tools/call")).toBe(false);
  for (const request of discoveryProtocolRequests.filter(
    (candidate) => candidate.method === "DELETE",
  )) {
    expect(initializeRequest.legacySessionId).toBeUndefined();
    expect(request.sessionId).toBe(initializedRequest.sessionId);
    expect(request.protocolVersion).toBe(initializedRequest.protocolVersion);
  }
  // The method-filtered OpenShell MCP policy does not authorize raw transport
  // DELETE, so SDK session termination is intentionally best effort at this
  // boundary. Unit coverage pins that cleanup attempt; protected E2E proves the
  // negotiated metadata on every post-initialize JSON-RPC request.
}
