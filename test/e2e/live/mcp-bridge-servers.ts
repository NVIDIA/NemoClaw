// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";

import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  closeServer,
  writeJsonResponse as jsonResponse,
  listenServer as listenOnRandomPort,
  readRequestBody,
} from "../fixtures/http-protocol.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress, TestProgressCapability } from "../fixtures/progress.ts";

type TestServer = http.Server | https.Server;

export const HERMES_DEFERRED_TOOL_SEARCH_MISS =
  "Hermes tool_search did not return the deferred target";

export interface StartedHttpServer {
  port: number;
  close(): Promise<void>;
}

export interface FakeMcpRequest {
  method: string;
  path: string;
  auth: string;
  body: string;
  sessionId: string;
  protocolVersion: string;
  rpcMethod?: string;
  responseStatus?: number;
  responseHasResult?: boolean;
  negotiatedSessionId?: string;
  negotiatedProtocolVersion?: string;
  legacySessionId?: string;
  negotiatedLegacySessionId?: string;
  legacyPhase?: LegacyMcpSessionPhase;
  legacyResponseSequence?: number;
  rpcId?: string | number | null;
}

export interface FakeMcpHttpsServer extends StartedHttpServer {
  setSecret(secret: string): void;
  requests: FakeMcpRequest[];
  activeLegacySessionCount(): number;
}

export interface StartedPublicMcpTunnel {
  origin: string;
  url: string;
  close(): Promise<void>;
}

type TunnelCleanupRegistry = Pick<CleanupRegistry, "add">;

interface McpRequestPayload {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: { challenge?: unknown }; cursor?: unknown };
}

export type LegacyMcpSessionPhase = "opened" | "awaiting-initialized" | "ready" | "closed";

interface LegacyMcpSession {
  id: string;
  response: http.ServerResponse;
  phase: LegacyMcpSessionPhase;
  protocolVersion?: string;
  pendingRequestIds: Set<string>;
  queuedBytes: number;
  responseSequence: number;
  writeChain: Promise<void>;
}

type LegacyQueueResult =
  | { ok: true; sequence: number }
  | { ok: false; status: number; message: string };

const MCP_NOTIFICATION_METHODS = new Set([
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
  "notifications/elicitation/complete",
]);

const LEGACY_MCP_SESSION_BYTES = 32;
const LEGACY_MCP_MAX_QUEUED_BYTES = 64 * 1024;

const TRYCLOUDFLARE_ORIGIN_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s"'\\/])/i;
const QUICK_TUNNEL_ATTEMPTS = 3;
const QUICK_TUNNEL_ATTEMPT_TIMEOUT_MS = 45_000;
const QUICK_TUNNEL_CONSECUTIVE_READY_PROBES = 3;
const QUICK_TUNNEL_DISCOVERY_CARRY_LIMIT = 512;
const OMITTED_CLOUDFLARED_OUTPUT_DIAGNOSTIC = "cloudflared child output omitted from diagnostics";
const CLOUDFLARED_ENV_NAMES = new Set([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

const EMPTY_TASK = {
  taskId: "fake-task",
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  ttl: null,
};

const MCP_EMPTY_RESULT_BY_METHOD: Record<string, unknown> = {
  ping: {},
  "resources/list": { resources: [] },
  "resources/read": { contents: [] },
  "resources/templates/list": { resourceTemplates: [] },
  "resources/subscribe": {},
  "resources/unsubscribe": {},
  "prompts/list": { prompts: [] },
  "prompts/get": { messages: [] },
  "tasks/list": { tasks: [] },
  "tasks/get": EMPTY_TASK,
  "tasks/update": {},
  "tasks/result": { content: [], isError: false },
  "tasks/cancel": EMPTY_TASK,
  "completion/complete": { completion: { values: [] } },
  "logging/setLevel": {},
  "server/discover": {
    supportedVersions: ["2025-11-25", "2025-03-26"],
    capabilities: { tools: {} },
    serverInfo: { name: "fake", version: "1.0.0" },
  },
  "messages/listen": {},
};

function requireTcpPort(server: TestServer, label: string): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(`${label} did not bind to a TCP port`);
  }
  return (address as AddressInfo).port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonRpcId(value: unknown): string | number | null | undefined {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function jsonRpcIdKey(value: string | number | null): string {
  return `${value === null ? "null" : typeof value}:${String(value)}`;
}

function waitForLegacyMcpDrain(response: http.ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("legacy MCP event stream closed during backpressure"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

function queueLegacyMcpResponse(
  session: LegacyMcpSession,
  requestId: string | number | null,
  payload: unknown,
): LegacyQueueResult {
  if (
    session.phase === "closed" ||
    session.response.destroyed ||
    session.response.writableEnded
  ) {
    return { ok: false, status: 410, message: "legacy MCP event stream is closed" };
  }
  const requestIdKey = jsonRpcIdKey(requestId);
  if (session.pendingRequestIds.has(requestIdKey)) {
    return { ok: false, status: 409, message: "legacy MCP request ID is already pending" };
  }
  const event = `data: ${JSON.stringify(payload)}\n\n`;
  const eventBytes = Buffer.byteLength(event);
  if (session.queuedBytes + eventBytes > LEGACY_MCP_MAX_QUEUED_BYTES) {
    return { ok: false, status: 429, message: "legacy MCP response queue is full" };
  }

  session.pendingRequestIds.add(requestIdKey);
  session.queuedBytes += eventBytes;
  session.responseSequence += 1;
  const sequence = session.responseSequence;
  session.writeChain = session.writeChain
    .then(async () => {
      if (
        session.phase === "closed" ||
        session.response.destroyed ||
        session.response.writableEnded
      ) {
        throw new Error("legacy MCP event stream closed before response delivery");
      }
      if (!session.response.write(event)) await waitForLegacyMcpDrain(session.response);
    })
    .catch(() => {
      session.phase = "closed";
      session.response.destroy();
    })
    .finally(() => {
      session.pendingRequestIds.delete(requestIdKey);
      session.queuedBytes -= eventBytes;
    });
  return { ok: true, sequence };
}

function buildCloudflaredSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {
    // Do not let quick-tunnel discovery consume a developer's named-tunnel
    // credentials or config. The CI runner temp directory is job-isolated.
    HOME: process.env.RUNNER_TEMP ?? os.tmpdir(),
    XDG_CONFIG_HOME: process.env.RUNNER_TEMP ?? os.tmpdir(),
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CLOUDFLARED_ENV_NAMES.has(name) || name.startsWith("LC_")) env[name] = value;
  }
  return env;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to signalling the process leader when no group exists.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process already exited.
  }
}

async function stopCloudflared(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child, "SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (graceful) return;
  signalProcessGroup(child, "SIGKILL");
  await exited;
}

export function parseTryCloudflareOrigin(log: string): string | null {
  return log.match(TRYCLOUDFLARE_ORIGIN_PATTERN)?.[0] ?? null;
}

export function buildCloudflaredQuickTunnelArgs(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid local MCP HTTPS port: ${port}`);
  }
  return [
    "tunnel",
    "--no-autoupdate",
    "--protocol",
    "http2",
    "--url",
    `https://127.0.0.1:${port}`,
    "--no-tls-verify",
    "--loglevel",
    "info",
  ];
}

async function probePublicTunnel(
  origin: string,
  readinessPath: string,
  readinessStatus: number,
): Promise<{
  ready: boolean;
  diagnostic: string;
}> {
  try {
    const response = await fetch(`${origin}${readinessPath}`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return {
      ready: response.status === readinessStatus,
      diagnostic: `public HEAD ${readinessPath} returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ready: false,
      // Avoid reflecting request URLs or child output here. The error class is
      // enough to distinguish DNS/transport failure without risking headers.
      diagnostic: `public HEAD ${readinessPath} failed (${error instanceof Error ? error.name : "unknown error"})`,
    };
  }
}

/**
 * Publishes a local HTTPS origin behind a real `trycloudflare.com` quick
 * tunnel: a genuinely public, DNS-resolvable, publicly-trusted-certificate
 * endpoint. Named for its original MCP-bridge fixture caller; reused as-is
 * (via the optional readiness override below) for the HTTPS-pin runtime
 * adapter's live coverage, since both need the identical real-tunnel proof
 * and only differ in which local path/status means "ready".
 */
export async function startPublicMcpHttpsTunnel(options: {
  cleanup: TunnelCleanupRegistry;
  label: string;
  progress: Pick<TestProgress, "activity" | "event" | "onOutput"> & TestProgressCapability;
  server: StartedHttpServer;
  cloudflaredBin?: string;
  readinessPath?: string;
  readinessStatus?: number;
}): Promise<StartedPublicMcpTunnel> {
  const readinessPath = options.readinessPath ?? "/mcp";
  const readinessStatus = options.readinessStatus ?? 405;
  const args = buildCloudflaredQuickTunnelArgs(options.server.port);
  let lastFailure = "cloudflared did not publish a quick-tunnel URL";

  for (let attempt = 1; attempt <= QUICK_TUNNEL_ATTEMPTS; attempt += 1) {
    const progressName = `cloudflared quick tunnel attempt ${attempt}`;
    try {
      options.progress.event(`${progressName} started`);
    } catch {
      // Progress diagnostics must never change tunnel setup.
    }
    let origin: string | null = null;
    let consecutiveReadyProbes = 0;
    let childOutputSeen = false;
    let spawnError: Error | undefined;
    const inspectOutputForOrigin = (): ((chunk: string) => void) => {
      let carry = "";
      return (chunk: string): void => {
        childOutputSeen = true;
        const candidate = `${carry}${chunk}`;
        origin ??= parseTryCloudflareOrigin(candidate);
        carry = candidate.slice(-QUICK_TUNNEL_DISCOVERY_CARRY_LIMIT);
      };
    };
    const child = spawnObservedChild(options.cloudflaredBin ?? "cloudflared", args, {
      activityLabel: `command: ${progressName}`,
      progress: options.progress,
      spawn: {
        detached: true,
        env: buildCloudflaredSubprocessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    const exited = waitForExit(child);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", inspectOutputForOrigin());
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", inspectOutputForOrigin());
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", () => {
      try {
        options.progress.event(`${progressName} stopped`);
      } catch {
        // Progress diagnostics must never change tunnel cleanup.
      }
    });

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= stopCloudflared(child, exited);
      return closePromise;
    };
    const deadline = Date.now() + QUICK_TUNNEL_ATTEMPT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (spawnError) {
        lastFailure = spawnError.message;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        lastFailure = `cloudflared exited before readiness (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`;
        break;
      }
      if (origin) {
        const probe = await probePublicTunnel(origin, readinessPath, readinessStatus);
        if (probe.ready) {
          consecutiveReadyProbes += 1;
          if (consecutiveReadyProbes >= QUICK_TUNNEL_CONSECUTIVE_READY_PROBES) {
            const tunnel = {
              origin,
              url: `${origin}/mcp`,
              close,
            };
            options.cleanup.add(`stop ${options.label} cloudflared quick tunnel`, tunnel.close);
            return tunnel;
          }
          lastFailure =
            `cloudflared quick tunnel passed ${consecutiveReadyProbes}/` +
            `${QUICK_TUNNEL_CONSECUTIVE_READY_PROBES} consecutive readiness probes`;
        } else {
          consecutiveReadyProbes = 0;
          lastFailure = `cloudflared published a quick-tunnel URL but ${probe.diagnostic}`;
        }
      }
      await delay(500);
    }

    await close();
    // Raw child output is intentionally excluded from thrown diagnostics.
    // Redacting completed chunks is unsafe when a credential continues in a
    // later data event, while retaining an arbitrary unfinished token would
    // make diagnostic memory unbounded. The bounded carry above exists only
    // to discover a quick-tunnel origin and is never surfaced to callers.
    if (childOutputSeen) {
      lastFailure = `${lastFailure}\n${OMITTED_CLOUDFLARED_OUTPUT_DIAGNOSTIC}`;
    }
    if (attempt < QUICK_TUNNEL_ATTEMPTS) await delay(attempt * 1_000);
  }

  throw new Error(
    `${options.label} public MCP HTTPS tunnel failed after ${QUICK_TUNNEL_ATTEMPTS} attempts: ${lastFailure}`,
  );
}

export async function startCompatibleMock(options: {
  apiKey: string;
  model: string;
  toolChallenge?: string;
  toolResultToken?: string;
  toolNames?: string[];
  deferredToolName?: string;
  progressiveToolSearch?: { toolName: string; query: string };
}): Promise<StartedHttpServer> {
  const server = http.createServer(async (req, res) => {
    const requestPath = new URL(req.url ?? "/", "http://compatible.mock").pathname;
    const auth = req.headers.authorization === `Bearer ${options.apiKey}`;
    if (!auth) {
      jsonResponse(res, 401, { error: { message: "missing bearer credential" } });
      return;
    }

    if (req.method === "GET" && ["/models", "/v1/models"].includes(requestPath)) {
      jsonResponse(res, 200, {
        object: "list",
        data: [{ id: options.model, object: "model" }],
      });
      return;
    }

    if (
      req.method === "POST" &&
      ["/chat/completions", "/v1/chat/completions"].includes(requestPath)
    ) {
      const body = JSON.parse(await readRequestBody(req)) as {
        stream?: boolean;
        messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const visibleToolNames = new Set(
        (body.tools ?? [])
          .map((tool) => tool.function?.name)
          .filter((name): name is string => typeof name === "string"),
      );
      const toolResults = (body.messages ?? []).filter((message) => message.role === "tool");
      const toolResultCount = toolResults.length;
      const sawAuthenticatedToolResult = toolResults.some((message) =>
        JSON.stringify(message.content).includes(options.toolResultToken ?? "__never__"),
      );
      const hasExpectedToolResult = (
        index: number,
        toolCallId: string,
        requiredContent: string[],
      ) => {
        const message = toolResults[index];
        const content = JSON.stringify(message?.content);
        return (
          message?.tool_call_id === toolCallId &&
          requiredContent.every((value) => content.includes(value))
        );
      };
      const parsedToolResult = (index: number, toolCallId: string) => {
        const message = toolResults[index];
        if (message?.tool_call_id !== toolCallId || typeof message.content !== "string") {
          return undefined;
        }
        try {
          const parsed = JSON.parse(message.content);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      };
      const classifyHermesSearchResult = (
        index: number,
        toolName: string,
      ): "target" | "miss" | "invalid" => {
        const parsed = parsedToolResult(index, "call_hermes_tool_search");
        if (!Array.isArray(parsed?.matches)) return "invalid";
        const matches = parsed.matches;
        const hasValidEntries = matches.every(
          (match) =>
            match &&
            typeof match === "object" &&
            !Array.isArray(match) &&
            typeof (match as Record<string, unknown>).name === "string",
        );
        if (!hasValidEntries) return "invalid";
        return matches.some((match) => (match as Record<string, unknown>).name === toolName)
          ? "target"
          : "miss";
      };
      const hasExpectedHermesDescription = (index: number, toolName: string) => {
        const parsed = parsedToolResult(index, "call_hermes_tool_describe");
        const parameters = parsed?.parameters;
        const properties =
          parameters && typeof parameters === "object" && !Array.isArray(parameters)
            ? (parameters as Record<string, unknown>).properties
            : undefined;
        return (
          parsed?.name === toolName &&
          properties !== null &&
          typeof properties === "object" &&
          !Array.isArray(properties) &&
          Object.hasOwn(properties, "challenge")
        );
      };
      let plannedToolCall:
        | { id: string; name: string; arguments: Record<string, unknown> }
        | undefined;
      let protocolError: string | undefined;

      if (!sawAuthenticatedToolResult && options.progressiveToolSearch) {
        const { query, toolName } = options.progressiveToolSearch;
        if (toolResultCount === 0 && visibleToolNames.has(toolName)) {
          protocolError = `progressive target ${toolName} was visible before search_tools`;
        } else if (toolResultCount === 0 && !visibleToolNames.has("search_tools")) {
          protocolError = "search_tools was not visible before progressive discovery";
        } else if (toolResultCount === 0) {
          plannedToolCall = {
            id: "call_progressive_tool_search",
            name: "search_tools",
            arguments: { query },
          };
        } else if (!hasExpectedToolResult(0, "call_progressive_tool_search", [`- ${toolName}:`])) {
          protocolError = "search_tools did not return the expected progressive target";
        } else if (!visibleToolNames.has(toolName)) {
          protocolError = `progressive target ${toolName} was not visible after search_tools`;
        } else if (toolResultCount === 1) {
          plannedToolCall = {
            id: "call_progressive_mcp_proof",
            name: toolName,
            arguments: { challenge: options.toolChallenge },
          };
        } else {
          protocolError = `progressive target ${toolName} did not return the expected authenticated result`;
        }
      } else if (!sawAuthenticatedToolResult && options.deferredToolName) {
        const bridgeNames = ["tool_search", "tool_describe", "tool_call"];
        const missingBridges = bridgeNames.filter((name) => !visibleToolNames.has(name));
        if (visibleToolNames.has(options.deferredToolName)) {
          protocolError = `deferred target ${options.deferredToolName} leaked into model tools`;
        } else if (missingBridges.length > 0) {
          protocolError = `Hermes tool search bridges missing: ${missingBridges.join(", ")}`;
        } else if (toolResultCount === 0) {
          plannedToolCall = {
            id: "call_hermes_tool_search",
            name: "tool_search",
            arguments: { query: options.deferredToolName },
          };
        } else if (toolResultCount === 1) {
          const searchResult = classifyHermesSearchResult(0, options.deferredToolName);
          if (searchResult === "target") {
            plannedToolCall = {
              id: "call_hermes_tool_describe",
              name: "tool_describe",
              arguments: { name: options.deferredToolName },
            };
          } else if (searchResult === "miss") {
            protocolError = HERMES_DEFERRED_TOOL_SEARCH_MISS;
          } else {
            protocolError = "Hermes returned an unexpected deferred tool result sequence";
          }
        } else if (
          toolResultCount === 2 &&
          toolResults.at(-1)?.tool_call_id === "call_hermes_tool_describe"
        ) {
          if (hasExpectedHermesDescription(1, options.deferredToolName)) {
            plannedToolCall = {
              id: "call_hermes_tool_call",
              name: "tool_call",
              arguments: {
                name: options.deferredToolName,
                arguments: { challenge: options.toolChallenge },
              },
            };
          } else {
            protocolError = "Hermes tool_describe did not return the deferred schema";
          }
        } else {
          protocolError = "Hermes returned an unexpected deferred tool result sequence";
        }
      } else if (!sawAuthenticatedToolResult) {
        const directToolName = [...visibleToolNames].find((name) =>
          (options.toolNames ?? []).includes(name),
        );
        if (directToolName) {
          plannedToolCall = {
            id: "call_mcp_bridge_proof",
            name: directToolName,
            arguments: { challenge: options.toolChallenge },
          };
        }
      }
      const responseMessage = sawAuthenticatedToolResult
        ? {
            role: "assistant",
            content: options.toolResultToken,
          }
        : protocolError
          ? { role: "assistant", content: `mock protocol error: ${protocolError}` }
          : plannedToolCall && options.toolChallenge
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: plannedToolCall.id,
                    type: "function",
                    function: {
                      name: plannedToolCall.name,
                      arguments: JSON.stringify(plannedToolCall.arguments),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "ok" };
      const finishReason = "tool_calls" in responseMessage ? "tool_calls" : "stop";
      if (body.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-mcp-bridge",
            object: "chat.completion.chunk",
            created: 0,
            model: options.model,
            choices: [
              {
                index: 0,
                delta: responseMessage,
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-mcp-bridge",
            object: "chat.completion.chunk",
            created: 0,
            model: options.model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      } else {
        jsonResponse(res, 200, {
          id: "chatcmpl-mcp-bridge",
          object: "chat.completion",
          created: 0,
          model: options.model,
          choices: [
            {
              index: 0,
              message: responseMessage,
              finish_reason: finishReason,
            },
          ],
        });
      }
      return;
    }

    if (req.method === "POST" && ["/responses", "/v1/responses"].includes(requestPath)) {
      await readRequestBody(req);
      jsonResponse(res, 200, {
        id: "resp-mcp-bridge",
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
      });
      return;
    }

    jsonResponse(res, 404, { error: { message: "not found" } });
  });

  await listenOnRandomPort(server);
  return {
    port: requireTcpPort(server, "compatible endpoint mock"),
    close: () => closeServer(server),
  };
}

export async function startFakeMcpHttpsServer(options: {
  secret: string;
  challenge?: string;
  resultToken?: string;
  tls?: { cert: Buffer; key: Buffer };
}): Promise<FakeMcpHttpsServer> {
  let expectedSecret = options.secret;
  let nextSessionId = 1;
  const sessions = new Map<string, string>();
  const legacySessions = new Map<string, LegacyMcpSession>();
  const serverEventStreams = new Set<http.ServerResponse>();
  const tls =
    options.tls ??
    (() => {
      const certPath = process.env.NEMOCLAW_MCP_TLS_CERT;
      const keyPath = process.env.NEMOCLAW_MCP_TLS_KEY;
      if (!certPath || !keyPath) {
        throw new Error(
          "NEMOCLAW_MCP_TLS_CERT and NEMOCLAW_MCP_TLS_KEY are required for the HTTPS MCP fixture",
        );
      }
      return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    })();
  const requests: FakeMcpRequest[] = [];
  const server = https.createServer(tls, async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "https://fake-mcp.local");
    const requestPath = requestUrl.pathname;
    const legacySessionId = requestUrl.searchParams.get("legacySessionId") ?? "";
    const legacySession = legacySessionId ? legacySessions.get(legacySessionId) : undefined;
    const body = await readRequestBody(req);
    const auth = Array.isArray(req.headers.authorization)
      ? req.headers.authorization.join(",")
      : (req.headers.authorization ?? "");
    const sessionId = Array.isArray(req.headers["mcp-session-id"])
      ? req.headers["mcp-session-id"].join(",")
      : (req.headers["mcp-session-id"] ?? "");
    const protocolVersion = Array.isArray(req.headers["mcp-protocol-version"])
      ? req.headers["mcp-protocol-version"].join(",")
      : (req.headers["mcp-protocol-version"] ?? "");
    let parsedPayload: McpRequestPayload | null = null;
    try {
      parsedPayload = JSON.parse(body) as McpRequestPayload;
    } catch {
      // The protocol error below handles malformed JSON after recording it.
    }
    // The public quick-tunnel readiness probe uses HEAD /mcp. Keep it out of
    // the protocol request ledger so zero-upstream decoy and policy-denial
    // assertions continue to measure only attempted MCP traffic.
    let recordedRequest: FakeMcpRequest | undefined;
    if (req.method !== "HEAD") {
      const requestId = jsonRpcId(parsedPayload?.id);
      recordedRequest = {
        method: req.method ?? "",
        path: requestPath,
        auth,
        body,
        sessionId,
        protocolVersion,
        ...(legacySessionId ? { legacySessionId } : {}),
        ...(legacySession ? { legacyPhase: legacySession.phase } : {}),
        ...(requestId !== undefined ? { rpcId: requestId } : {}),
        ...(typeof parsedPayload?.method === "string" ? { rpcMethod: parsedPayload.method } : {}),
      };
      requests.push(recordedRequest);
    }
    const respondJson = (status: number, payload: unknown): void => {
      if (recordedRequest) {
        recordedRequest.responseStatus = status;
        recordedRequest.responseHasResult =
          typeof payload === "object" &&
          payload !== null &&
          Object.prototype.hasOwnProperty.call(payload, "result") &&
          !Object.prototype.hasOwnProperty.call(payload, "error");
      }
      jsonResponse(res, status, payload);
    };
    const respondEmpty = (status: number, headers?: http.OutgoingHttpHeaders): void => {
      if (recordedRequest) recordedRequest.responseStatus = status;
      res.writeHead(status, headers);
      res.end();
    };
    const respondRpc = (requestId: string | number | null, payload: unknown): void => {
      if (!legacySessionId) {
        respondJson(200, payload);
        return;
      }
      const activeLegacySession = legacySessions.get(legacySessionId);
      if (!activeLegacySession) {
        respondJson(404, { error: { message: "legacy MCP event stream is unavailable" } });
        return;
      }
      const queued = queueLegacyMcpResponse(activeLegacySession, requestId, payload);
      if (!queued.ok) {
        respondJson(queued.status, { error: { message: queued.message } });
        return;
      }
      if (recordedRequest) {
        recordedRequest.responseStatus = 202;
        recordedRequest.legacyResponseSequence = queued.sequence;
        recordedRequest.responseHasResult =
          typeof payload === "object" &&
          payload !== null &&
          Object.prototype.hasOwnProperty.call(payload, "result") &&
          !Object.prototype.hasOwnProperty.call(payload, "error");
      }
      res.writeHead(202);
      res.end();
    };
    if (requestPath !== "/mcp") {
      respondJson(404, { error: { message: "not found" } });
      return;
    }
    if (req.method === "HEAD") {
      respondEmpty(405, { Allow: "POST" });
      return;
    }
    if (req.method === "GET") {
      if (auth !== `Bearer ${expectedSecret}`) {
        respondJson(401, { error: { message: "missing rewritten bearer credential" } });
        return;
      }
      if (sessionId === "" && protocolVersion === "") {
        let eventSessionId: string;
        do {
          eventSessionId = randomBytes(LEGACY_MCP_SESSION_BYTES).toString("base64url");
        } while (legacySessions.has(eventSessionId));
        const eventSession: LegacyMcpSession = {
          id: eventSessionId,
          response: res,
          phase: "opened",
          pendingRequestIds: new Set(),
          queuedBytes: 0,
          responseSequence: 0,
          writeChain: Promise.resolve(),
        };
        legacySessions.set(eventSessionId, eventSession);
        if (recordedRequest) {
          recordedRequest.responseStatus = 200;
          recordedRequest.negotiatedLegacySessionId = eventSessionId;
          recordedRequest.legacyPhase = eventSession.phase;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`event: endpoint\ndata: /mcp?legacySessionId=${eventSessionId}\n\n`);
        serverEventStreams.add(res);
        res.once("close", () => {
          eventSession.phase = "closed";
          legacySessions.delete(eventSessionId);
          serverEventStreams.delete(res);
        });
        return;
      }
      const negotiatedProtocolVersion = sessions.get(sessionId);
      if (!negotiatedProtocolVersion || protocolVersion !== negotiatedProtocolVersion) {
        respondJson(400, { error: { message: "missing negotiated MCP session metadata" } });
        return;
      }
      if (recordedRequest) recordedRequest.responseStatus = 200;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      serverEventStreams.add(res);
      res.once("close", () => serverEventStreams.delete(res));
      return;
    }
    if (req.method !== "POST" && req.method !== "DELETE") {
      respondJson(405, { error: { message: "method not allowed" } });
      return;
    }
    if (auth !== `Bearer ${expectedSecret}`) {
      respondJson(401, { error: { message: "missing rewritten bearer credential" } });
      return;
    }
    if (req.method === "DELETE") {
      if (legacySessionId) {
        respondJson(405, { error: { message: "legacy MCP sessions close with the event stream" } });
        return;
      }
      const negotiatedProtocolVersion = sessions.get(sessionId);
      if (!negotiatedProtocolVersion || protocolVersion !== negotiatedProtocolVersion) {
        respondJson(400, { error: { message: "missing negotiated MCP session metadata" } });
        return;
      }
      sessions.delete(sessionId);
      respondEmpty(204);
      return;
    }

    if (!parsedPayload) {
      respondJson(400, { error: { message: "invalid json" } });
      return;
    }
    if (legacySessionId && !legacySession) {
      respondJson(404, { error: { message: "legacy MCP event stream is unavailable" } });
      return;
    }
    if (
      legacySession &&
      (legacySession.phase === "closed" || !legacySessions.has(legacySessionId))
    ) {
      respondJson(410, { error: { message: "legacy MCP event stream is closed" } });
      return;
    }
    const requestId = jsonRpcId(parsedPayload.id);
    const isNotification =
      typeof parsedPayload.method === "string" && MCP_NOTIFICATION_METHODS.has(parsedPayload.method);
    if (legacySession) {
      if (sessionId !== "") {
        respondJson(400, { error: { message: "legacy MCP requests must not mix session headers" } });
        return;
      }
      if (parsedPayload.method === "initialize") {
        if (legacySession.phase !== "opened") {
          respondJson(409, { error: { message: "legacy MCP session is already initialized" } });
          return;
        }
        if (protocolVersion !== "") {
          respondJson(400, { error: { message: "legacy MCP initialize sent premature metadata" } });
          return;
        }
      } else {
        if (legacySession.phase === "opened") {
          respondJson(409, { error: { message: "legacy MCP session is not initialized" } });
          return;
        }
        if (!legacySession.protocolVersion || protocolVersion !== legacySession.protocolVersion) {
          respondJson(400, { error: { message: "missing negotiated legacy MCP metadata" } });
          return;
        }
        if (parsedPayload.method === "notifications/initialized") {
          if (legacySession.phase !== "awaiting-initialized") {
            respondJson(409, { error: { message: "legacy MCP initialization phase is invalid" } });
            return;
          }
        } else if (legacySession.phase !== "ready") {
          respondJson(409, { error: { message: "legacy MCP session is not ready" } });
          return;
        }
      }
      if (!isNotification && requestId === undefined) {
        respondJson(400, { error: { message: "legacy MCP request ID is required" } });
        return;
      }
    }
    const responseId = requestId === undefined ? 1 : requestId;
    // This shared fixture also serves intentional stateless policy probes.
    // Validate any supplied session metadata as an all-or-nothing pair; the
    // focused discovery assertion separately requires the negotiated pair on
    // every post-initialize request.
    if (
      !legacySessionId &&
      parsedPayload.method !== "initialize" &&
      (sessionId !== "" || protocolVersion !== "")
    ) {
      const negotiatedProtocolVersion = sessions.get(sessionId);
      if (!negotiatedProtocolVersion || protocolVersion !== negotiatedProtocolVersion) {
        respondJson(400, { error: { message: "missing negotiated MCP session metadata" } });
        return;
      }
    }
    if (isNotification) {
      if (legacySession && parsedPayload.method === "notifications/initialized") {
        legacySession.phase = "ready";
        if (recordedRequest) recordedRequest.legacyPhase = legacySession.phase;
      }
      respondEmpty(202);
      return;
    }
    let result: unknown;
    if (parsedPayload.method === "initialize") {
      const request = JSON.parse(body) as {
        params?: { protocolVersion?: string };
      };
      const negotiatedProtocolVersion = request.params?.protocolVersion ?? "2025-03-26";
      if (legacySession) {
        legacySession.protocolVersion = negotiatedProtocolVersion;
        legacySession.phase = "awaiting-initialized";
        if (recordedRequest) {
          recordedRequest.negotiatedProtocolVersion = negotiatedProtocolVersion;
          recordedRequest.legacyPhase = legacySession.phase;
        }
      } else {
        const negotiatedSessionId = `fake-session-${nextSessionId}`;
        nextSessionId += 1;
        sessions.set(negotiatedSessionId, negotiatedProtocolVersion);
        res.setHeader("mcp-session-id", negotiatedSessionId);
        if (recordedRequest) {
          recordedRequest.negotiatedSessionId = negotiatedSessionId;
          recordedRequest.negotiatedProtocolVersion = negotiatedProtocolVersion;
        }
      }
      result = {
        protocolVersion: negotiatedProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      };
    } else if (parsedPayload.method === "tools/list") {
      if (parsedPayload.params?.cursor === undefined) {
        result = {
          tools: [
            {
              name: "fake_echo",
              description: "Returns an authenticated MCP proof token",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: { challenge: { type: "string" } },
                required: ["challenge"],
                additionalProperties: false,
              },
            },
          ],
          nextCursor: "fake-page-2",
        };
      } else if (parsedPayload.params.cursor === "fake-page-2") {
        result = {
          tools: [
            {
              name: "fake_status",
              description: "Returns fixture status",
              annotations: { readOnlyHint: true },
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        };
      } else {
        respondRpc(responseId, {
          jsonrpc: "2.0",
          id: responseId,
          error: { code: -32602, message: "invalid tools/list cursor" },
        });
        return;
      }
    } else if (parsedPayload.method === "tools/call") {
      const challenge = parsedPayload.params?.arguments?.challenge;
      if (
        parsedPayload.params?.name !== "fake_echo" ||
        (options.challenge !== undefined && challenge !== options.challenge)
      ) {
        respondRpc(responseId, {
          jsonrpc: "2.0",
          id: responseId,
          error: { code: -32602, message: "invalid fake_echo challenge" },
        });
        return;
      }
      result = {
        content: [
          {
            type: "text",
            text: options.resultToken ?? `MCP_AUTH_REWRITE_OK::${String(challenge ?? "")}`,
          },
        ],
        isError: false,
      };
    } else if (
      typeof parsedPayload.method === "string" &&
      Object.prototype.hasOwnProperty.call(MCP_EMPTY_RESULT_BY_METHOD, parsedPayload.method)
    ) {
      result = MCP_EMPTY_RESULT_BY_METHOD[parsedPayload.method];
    } else {
      respondRpc(responseId, {
        jsonrpc: "2.0",
        id: responseId,
        error: { code: -32601, message: "method not found" },
      });
      return;
    }
    respondRpc(responseId, {
      jsonrpc: "2.0",
      id: responseId,
      result,
    });
  });

  await listenOnRandomPort(server);
  return {
    port: requireTcpPort(server, "fake MCP endpoint"),
    requests,
    activeLegacySessionCount: () => legacySessions.size,
    setSecret: (secret: string) => {
      expectedSecret = secret;
    },
    close: async () => {
      for (const response of serverEventStreams) response.destroy();
      await closeServer(server);
      for (const session of legacySessions.values()) session.phase = "closed";
      legacySessions.clear();
    },
  };
}
