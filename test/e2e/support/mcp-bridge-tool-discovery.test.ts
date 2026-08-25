// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { shouldRetryMcpMutationAfterConcurrencyConflict } from "../live/mcp-bridge-cleanup.ts";
import {
  type FakeMcpHttpsServer,
  type FakeMcpRequest,
  HERMES_DEFERRED_TOOL_SEARCH_MISS,
  type StartedHttpServer,
  startCompatibleMock,
} from "../live/mcp-bridge-servers.ts";
import {
  assertAuthenticatedMcpDiscoveryWithOneRestart,
  assertAuthenticatedMcpToolDiscovery,
  hasSuccessfulAuthenticatedMcpDiscovery,
  runHermesInitialMcpReadiness,
  shouldRetryMcpDiscoveryAfterRestart,
  shouldRetryMcpToolDiscoveryTransportFailure,
} from "../live/mcp-bridge-tool-discovery.ts";

const EXPECTED_SECRET = "expected-secret";
const EXPECTED_RESULT_TOKEN = "expected-result";
const SESSION_ID = "fake-session-1";
const LEGACY_SESSION_ID = "opaque-legacy-session";
const PROTOCOL_VERSION = "2025-03-26";
const STATUS_SECRET = "unregistered-sensitive-status-value";
const DISCOVERY_RETRY_ARTIFACT = "hermes-initial-mcp-discovery-retry-evidence.json";

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

function fakeDiscoveryServer(
  requests: FakeMcpRequest[] = [],
  observations: FakeMcpRequest[] = [...requests],
): FakeMcpHttpsServer {
  return { observations, requests } as unknown as FakeMcpHttpsServer;
}

function discoveryArtifacts() {
  return { writeJson: vi.fn().mockResolvedValue("/tmp/discovery-evidence.json") };
}

function discoveryRestartOptions(
  restart: () => Promise<void>,
  artifacts: ReturnType<typeof discoveryArtifacts>,
  offsets: { observationOffset?: number; requestOffset?: number } = {},
) {
  return {
    requestOffset: offsets.requestOffset ?? 0,
    observationOffset: offsets.observationOffset ?? 0,
    expectedSecret: EXPECTED_SECRET,
    label: "initial discovery",
    restart,
    artifacts,
    artifactName: DISCOVERY_RETRY_ARTIFACT,
  };
}

function successfulLegacyDiscovery(): FakeMcpRequest[] {
  return [
    {
      method: "GET",
      path: "/mcp",
      auth: `Bearer ${EXPECTED_SECRET}`,
      body: "",
      sessionId: "",
      protocolVersion: "",
      responseStatus: 200,
      negotiatedLegacySessionId: LEGACY_SESSION_ID,
      legacyPhase: "opened",
    },
    request("initialize", {
      sessionId: "",
      protocolVersion: "",
      responseStatus: 202,
      rpcId: 1,
      legacySessionId: LEGACY_SESSION_ID,
      negotiatedProtocolVersion: PROTOCOL_VERSION,
      legacyPhase: "awaiting-initialized",
      legacyResponseSequence: 1,
    }),
    request("notifications/initialized", {
      sessionId: "",
      legacySessionId: LEGACY_SESSION_ID,
      legacyPhase: "ready",
    }),
    request("tools/list", {
      sessionId: "",
      responseStatus: 202,
      rpcId: 2,
      legacySessionId: LEGACY_SESSION_ID,
      legacyPhase: "ready",
      legacyResponseSequence: 2,
    }),
  ];
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
const artifactRoots: string[] = [];

afterEach(async () => {
  await compatibleMock?.close();
  compatibleMock = undefined;
  await Promise.all(
    artifactRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
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

  it("accepts legacy SSE discovery correlated to an authenticated event stream", () => {
    expect(
      hasSuccessfulAuthenticatedMcpDiscovery(successfulLegacyDiscovery(), EXPECTED_SECRET),
    ).toBe(true);
  });

  it.each([
    ["an unauthenticated event stream", 0, { auth: "" }],
    ["a missing event-stream correlation", 0, { negotiatedLegacySessionId: "" }],
    ["a different POST endpoint", 3, { legacySessionId: "other-session" }],
    ["a missing negotiated protocol header", 3, { protocolVersion: "" }],
    ["a tools/list response without its JSON-RPC ID", 3, { rpcId: undefined }],
  ])("rejects legacy SSE discovery with %s", (_failure, failedRequestIndex, override) => {
    const requests = successfulLegacyDiscovery();
    Object.assign(requests[failedRequestIndex], override);

    expect(hasSuccessfulAuthenticatedMcpDiscovery(requests, EXPECTED_SECRET)).toBe(false);
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

describe("authenticated MCP tool discovery transport retry", () => {
  it("writes redacted boundary diagnostics before a discovery failure (#8746)", async () => {
    const statusJson = {
      provider: {
        registryPresent: true,
        gatewayPresent: true,
        attached: true,
        credentialReady: true,
        credentialResolution: { detail: STATUS_SECRET },
        token: STATUS_SECRET,
      },
      policy: { registryPresent: true, gatewayPresent: true, token: STATUS_SECRET },
      adapter: { registered: true, detail: STATUS_SECRET, sessionId: STATUS_SECRET },
      trustedPrivateTarget: {
        state: "match" as const,
        host: STATUS_SECRET,
        recordedPins: [STATUS_SECRET],
        detail: STATUS_SECRET,
      },
      toolDiscovery: {
        ok: false,
        count: 0,
        tools: [],
        truncated: false,
        detail: "MCP tool discovery request failed",
        credential: STATUS_SECRET,
      },
    };
    const fakeMcp = { requests: [] } as unknown as FakeMcpHttpsServer;
    const host = {
      nemoclaw: vi.fn(async () => {
        fakeMcp.requests.push(successfulInitialize());
        return { exitCode: 0, stdout: JSON.stringify(statusJson), stderr: "" };
      }),
    } as unknown as Parameters<typeof assertAuthenticatedMcpToolDiscovery>[0];
    const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-mcp-diagnostics-"));
    artifactRoots.push(artifactRoot);
    const artifacts = new ArtifactSink(artifactRoot);

    await expect(
      assertAuthenticatedMcpToolDiscovery(host, fakeMcp, {
        artifacts,
        sandboxName: "sandbox",
        artifactPrefix: "openclaw-trusted-private",
        hostSecret: EXPECTED_SECRET,
        progress: { event: vi.fn() },
      }),
    ).rejects.toThrow();

    const artifactPath = path.join(
      artifactRoot,
      "openclaw-trusted-private-mcp-tool-discovery-diagnostics.json",
    );
    const diagnostics = await fs.readFile(artifactPath, "utf8");
    expect(JSON.parse(diagnostics)).toEqual({
      provider: {
        registryPresent: true,
        gatewayPresent: true,
        attached: true,
        credentialReady: true,
        credentialResolutionPresent: true,
      },
      policy: { registryPresent: true, gatewayPresent: true },
      adapter: { registered: true, detailPresent: true },
      trustedPrivateTarget: { state: "match", detailPresent: true },
      toolDiscovery: {
        ok: false,
        count: 0,
        tools: [],
        truncated: false,
        detail: "MCP tool discovery request failed",
      },
      requests: [
        {
          httpMethod: "POST",
          rpcMethod: "initialize",
          transport: "streamable-http",
          responseStatus: 200,
          responseHasResult: true,
          rpcIdPresent: false,
          legacyPhase: null,
          legacyResponseSequence: null,
          sessionMetadataPresent: {
            sessionId: false,
            protocolVersion: false,
            negotiatedSessionId: true,
            negotiatedProtocolVersion: true,
            legacySessionId: false,
            negotiatedLegacySessionId: false,
          },
          credentialRewriteMatched: true,
        },
      ],
    });
    expect(diagnostics).not.toContain(STATUS_SECRET);
    expect(diagnostics).not.toContain(EXPECTED_SECRET);
    expect(diagnostics).not.toContain(SESSION_ID);
    expect(diagnostics).not.toContain(PROTOCOL_VERSION);
  });

  it("retries one generic transport failure before any request reaches the fixture", () => {
    expect(
      shouldRetryMcpToolDiscoveryTransportFailure(
        { ok: false, detail: "MCP tool discovery request failed" },
        [],
        1,
      ),
    ).toBe(true);
  });

  it.each([
    ["the fixture received a request", [request("initialize")], 1],
    ["the retry budget is exhausted", [], 2],
  ])("does not retry when %s", (_case, requests, attempt) => {
    expect(
      shouldRetryMcpToolDiscoveryTransportFailure(
        { ok: false, detail: "MCP tool discovery request failed" },
        requests as FakeMcpRequest[],
        attempt as number,
      ),
    ).toBe(false);
  });

  it("does not retry a classified product or endpoint failure", () => {
    expect(
      shouldRetryMcpToolDiscoveryTransportFailure(
        { ok: false, detail: "MCP endpoint returned an invalid tool-list response" },
        [],
        1,
      ),
    ).toBe(false);
  });
});

describe("authenticated MCP discovery restart retry", () => {
  it("retries when no request reached the fixture", () => {
    expect(shouldRetryMcpDiscoveryAfterRestart([])).toBe(true);
  });

  it("does not retry after a malformed MCP request reached the fixture", () => {
    expect(
      shouldRetryMcpDiscoveryAfterRestart([
        {
          method: "POST",
          path: "/mcp",
          auth: `Bearer ${EXPECTED_SECRET}`,
          body: "{",
          sessionId: "",
          protocolVersion: "",
          responseStatus: 400,
        },
      ]),
    ).toBe(false);
  });

  it.each([
    ["authenticated", { auth: `Bearer ${EXPECTED_SECRET}` }],
    ["metadata-bearing", { sessionId: SESSION_ID, protocolVersion: PROTOCOL_VERSION }],
    ["wrong-path", { path: "/health", responseStatus: 404 }],
    ["body-bearing", { body: "unexpected readiness body" }],
  ])("does not restart after a %s HEAD request arrived after the offset", async (_case, override) => {
    const readinessHead: FakeMcpRequest = {
      method: "HEAD",
      path: "/mcp",
      auth: "",
      body: "",
      sessionId: "",
      protocolVersion: "",
      responseStatus: 405,
    };
    const fakeMcp = fakeDiscoveryServer([], [readinessHead, { ...readinessHead, ...override }]);
    const failure = new Error("discovery failed after observed HEAD request");
    const assertDiscovery = vi.fn().mockRejectedValueOnce(failure);
    const restart = vi.fn().mockResolvedValueOnce(undefined);
    const artifacts = discoveryArtifacts();

    await expect(
      assertAuthenticatedMcpDiscoveryWithOneRestart(
        fakeMcp,
        discoveryRestartOptions(restart, artifacts, { observationOffset: 1 }),
        { assertDiscovery },
      ),
    ).rejects.toBe(failure);

    expect(restart).not.toHaveBeenCalled();
    expect(artifacts.writeJson).toHaveBeenCalledWith(DISCOVERY_RETRY_ARTIFACT, {
      schemaVersion: 1,
      attempts: [
        {
          attempt: 1,
          requestCount: 1,
          classification: "request-observed",
          restartDecision: "no-restart",
          outcome: "failed",
        },
      ],
      finalOutcome: "failed-no-restart",
    });
  });

  it("does not retry after the fixture received a request", () => {
    expect(shouldRetryMcpDiscoveryAfterRestart([request("initialize")])).toBe(false);
  });

  it("records bounded first-attempt evidence without request content", async () => {
    const sensitiveBody = "sensitive-request-body";
    const fakeMcp = fakeDiscoveryServer([
      request("initialize", { body: sensitiveBody, sessionId: SESSION_ID }),
    ]);
    const assertDiscovery = vi.fn().mockResolvedValueOnce(undefined);
    const restart = vi.fn().mockResolvedValueOnce(undefined);
    const artifacts = discoveryArtifacts();

    await assertAuthenticatedMcpDiscoveryWithOneRestart(
      fakeMcp,
      discoveryRestartOptions(restart, artifacts),
      { assertDiscovery },
    );

    expect(artifacts.writeJson).toHaveBeenCalledWith(DISCOVERY_RETRY_ARTIFACT, {
      schemaVersion: 1,
      attempts: [
        {
          attempt: 1,
          requestCount: 1,
          classification: "authenticated-discovery-complete",
          restartDecision: "not-needed",
          outcome: "passed",
        },
      ],
      finalOutcome: "passed-first-attempt",
    });
    const evidence = JSON.stringify(artifacts.writeJson.mock.calls[0]?.[1]);
    expect(evidence).not.toContain(sensitiveBody);
    expect(evidence).not.toContain(EXPECTED_SECRET);
    expect(evidence).not.toContain(SESSION_ID);
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts once and retries discovery when no request reached the fixture", async () => {
    const fakeMcp = fakeDiscoveryServer();
    const assertDiscovery = vi
      .fn()
      .mockRejectedValueOnce(new Error("first discovery failed"))
      .mockResolvedValueOnce(undefined);
    const restart = vi.fn().mockResolvedValueOnce(undefined);
    const artifacts = discoveryArtifacts();

    await assertAuthenticatedMcpDiscoveryWithOneRestart(
      fakeMcp,
      discoveryRestartOptions(restart, artifacts),
      { assertDiscovery },
    );

    expect(restart).toHaveBeenCalledOnce();
    expect(assertDiscovery).toHaveBeenCalledTimes(2);
    expect(assertDiscovery.mock.calls[1]?.[1]).toMatchObject({
      label: "initial discovery after one bridge restart",
    });
    expect(artifacts.writeJson).toHaveBeenCalledWith(DISCOVERY_RETRY_ARTIFACT, {
      schemaVersion: 1,
      attempts: [
        {
          attempt: 1,
          requestCount: 0,
          classification: "no-request-observed",
          restartDecision: "restart-once",
          outcome: "retrying",
        },
        {
          attempt: 2,
          requestCount: 0,
          classification: "authenticated-discovery-complete",
          restartDecision: "not-needed",
          outcome: "passed",
        },
      ],
      finalOutcome: "passed-after-restart",
    });
  });

  it("does not restart when the failed attempt reached the fixture", async () => {
    const fakeMcp = fakeDiscoveryServer([request("initialize")]);
    const failure = new Error("fixture-visible discovery failed");
    const assertDiscovery = vi.fn().mockRejectedValueOnce(failure);
    const restart = vi.fn().mockResolvedValueOnce(undefined);
    const artifacts = discoveryArtifacts();

    await expect(
      assertAuthenticatedMcpDiscoveryWithOneRestart(
        fakeMcp,
        discoveryRestartOptions(restart, artifacts),
        { assertDiscovery },
      ),
    ).rejects.toBe(failure);

    expect(restart).not.toHaveBeenCalled();
    expect(assertDiscovery).toHaveBeenCalledOnce();
    expect(artifacts.writeJson).toHaveBeenCalledWith(
      DISCOVERY_RETRY_ARTIFACT,
      expect.objectContaining({ finalOutcome: "failed-no-restart" }),
    );
  });

  it("propagates the retry failure without a second restart", async () => {
    const fakeMcp = fakeDiscoveryServer();
    const retryFailure = new Error("retry discovery failed");
    const assertDiscovery = vi
      .fn()
      .mockRejectedValueOnce(new Error("first discovery failed"))
      .mockRejectedValueOnce(retryFailure);
    const restart = vi.fn().mockResolvedValueOnce(undefined);
    const artifacts = discoveryArtifacts();

    await expect(
      assertAuthenticatedMcpDiscoveryWithOneRestart(
        fakeMcp,
        discoveryRestartOptions(restart, artifacts),
        { assertDiscovery },
      ),
    ).rejects.toBe(retryFailure);

    expect(restart).toHaveBeenCalledOnce();
    expect(assertDiscovery).toHaveBeenCalledTimes(2);
    expect(artifacts.writeJson).toHaveBeenCalledWith(DISCOVERY_RETRY_ARTIFACT, {
      schemaVersion: 1,
      attempts: [
        {
          attempt: 1,
          requestCount: 0,
          classification: "no-request-observed",
          restartDecision: "restart-once",
          outcome: "retrying",
        },
        {
          attempt: 2,
          requestCount: 0,
          classification: "discovery-incomplete-after-restart",
          restartDecision: "no-restart",
          outcome: "failed",
        },
      ],
      finalOutcome: "failed-after-restart",
    });
  });

  it("records a restart failure without attempting a second restart", async () => {
    const fakeMcp = fakeDiscoveryServer();
    const restartFailure = new Error("bridge restart failed");
    const assertDiscovery = vi.fn().mockRejectedValueOnce(new Error("first discovery failed"));
    const restart = vi.fn().mockRejectedValueOnce(restartFailure);
    const artifacts = discoveryArtifacts();

    await expect(
      assertAuthenticatedMcpDiscoveryWithOneRestart(
        fakeMcp,
        discoveryRestartOptions(restart, artifacts),
        { assertDiscovery },
      ),
    ).rejects.toBe(restartFailure);

    expect(restart).toHaveBeenCalledOnce();
    expect(assertDiscovery).toHaveBeenCalledOnce();
    expect(artifacts.writeJson).toHaveBeenCalledWith(DISCOVERY_RETRY_ARTIFACT, {
      schemaVersion: 1,
      attempts: [
        {
          attempt: 1,
          requestCount: 0,
          classification: "no-request-observed",
          restartDecision: "restart-once",
          outcome: "retrying",
        },
        {
          attempt: 2,
          requestCount: 0,
          classification: "restart-failed",
          restartDecision: "no-restart",
          outcome: "failed",
        },
      ],
      finalOutcome: "restart-failed",
    });
  });

  it("retains a discovery failure when retry evidence cannot be written (#10155)", async () => {
    const fakeMcp = fakeDiscoveryServer([request("initialize")]);
    const discoveryFailure = new Error("fixture-visible discovery failed");
    const evidenceFailure = new Error("retry evidence write failed");
    const assertDiscovery = vi.fn().mockRejectedValueOnce(discoveryFailure);
    const restart = vi.fn().mockResolvedValueOnce(undefined);
    const artifacts = discoveryArtifacts();
    artifacts.writeJson.mockRejectedValueOnce(evidenceFailure);

    const failure = await assertAuthenticatedMcpDiscoveryWithOneRestart(
      fakeMcp,
      discoveryRestartOptions(restart, artifacts),
      { assertDiscovery },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: discoveryFailure,
      errors: [discoveryFailure, evidenceFailure],
      evidenceStatus: "write-failed",
      finalOutcome: "failed-no-restart",
    });
    expect(String(failure)).toContain("retry evidence write failed");
    expect(restart).not.toHaveBeenCalled();
  });

  it("retains a restart failure when retry evidence cannot be written (#10155)", async () => {
    const fakeMcp = fakeDiscoveryServer();
    const restartFailure = new Error("bridge restart failed");
    const evidenceFailure = new Error("retry evidence write failed");
    const assertDiscovery = vi.fn().mockRejectedValueOnce(new Error("first discovery failed"));
    const restart = vi.fn().mockRejectedValueOnce(restartFailure);
    const artifacts = discoveryArtifacts();
    artifacts.writeJson.mockRejectedValueOnce(evidenceFailure);

    const failure = await assertAuthenticatedMcpDiscoveryWithOneRestart(
      fakeMcp,
      discoveryRestartOptions(restart, artifacts),
      { assertDiscovery },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: restartFailure,
      errors: [restartFailure, evidenceFailure],
      evidenceStatus: "write-failed",
      finalOutcome: "restart-failed",
    });
    expect(String(failure)).toContain("retry evidence write failed");
    expect(restart).toHaveBeenCalledOnce();
    expect(assertDiscovery).toHaveBeenCalledOnce();
  });
});

describe("Hermes initial MCP readiness", () => {
  it("does not start a model turn before discovery and tool status finish (#10155)", async () => {
    let finishDiscovery!: () => void;
    let finishToolStatus!: () => void;
    const discover = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    const inspectToolStatus = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishToolStatus = resolve;
        }),
    );
    let finishPreparation!: () => void;
    const prepareModelTurn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const runModelTurn = vi.fn().mockResolvedValue(undefined);

    const readiness = runHermesInitialMcpReadiness({
      discover,
      inspectToolStatus,
      prepareModelTurn,
      runModelTurn,
    });

    expect(discover).toHaveBeenCalledOnce();
    expect(inspectToolStatus).not.toHaveBeenCalled();
    expect(prepareModelTurn).not.toHaveBeenCalled();
    expect(runModelTurn).not.toHaveBeenCalled();

    finishDiscovery();
    await vi.waitFor(() => expect(inspectToolStatus).toHaveBeenCalledOnce());
    expect(prepareModelTurn).not.toHaveBeenCalled();
    expect(runModelTurn).not.toHaveBeenCalled();

    finishToolStatus();
    await vi.waitFor(() => expect(prepareModelTurn).toHaveBeenCalledOnce());
    expect(runModelTurn).not.toHaveBeenCalled();
    finishPreparation();
    await readiness;
    expect(prepareModelTurn).toHaveBeenCalledOnce();
    expect(runModelTurn).toHaveBeenCalledOnce();
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

describe("MCP mutation concurrency retry", () => {
  it("retries the explicit OpenShell optimistic-concurrency response", () => {
    expect(
      shouldRetryMcpMutationAfterConcurrencyConflict(
        "Failed to detach provider: sandbox was modified by another operation.\nPlease retry the command.",
      ),
    ).toBe(true);
  });

  it.each([
    "Failed to detach provider: permission denied",
    "sandbox was modified by another operation.",
    "Please retry the command.",
  ])("does not retry another failure: %s", (output) => {
    expect(shouldRetryMcpMutationAfterConcurrencyConflict(output)).toBe(false);
  });
});
