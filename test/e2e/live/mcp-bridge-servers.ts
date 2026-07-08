// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
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

type TestServer = http.Server | https.Server;

export interface StartedHttpServer {
  port: number;
  close(): Promise<void>;
}

export interface FakeMcpHttpsServer extends StartedHttpServer {
  setSecret(secret: string): void;
  requests: Array<{
    method: string;
    path: string;
    auth: string;
    body: string;
    rpcMethod?: string;
  }>;
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
  params?: { name?: unknown; arguments?: { challenge?: unknown } };
}

const MCP_NOTIFICATION_METHODS = new Set([
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
  "notifications/elicitation/complete",
]);

const TRYCLOUDFLARE_ORIGIN_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s"'\\/])/i;
const QUICK_TUNNEL_ATTEMPTS = 3;
const QUICK_TUNNEL_ATTEMPT_TIMEOUT_MS = 45_000;
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

async function probePublicTunnel(origin: string): Promise<{
  ready: boolean;
  diagnostic: string;
}> {
  try {
    const response = await fetch(`${origin}/mcp`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return {
      ready: response.status === 405,
      diagnostic: `public HEAD /mcp returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ready: false,
      // Avoid reflecting request URLs or child output here. The error class is
      // enough to distinguish DNS/transport failure without risking headers.
      diagnostic: `public HEAD /mcp failed (${error instanceof Error ? error.name : "unknown error"})`,
    };
  }
}

export async function startPublicMcpHttpsTunnel(options: {
  cleanup: TunnelCleanupRegistry;
  label: string;
  server: StartedHttpServer;
  cloudflaredBin?: string;
}): Promise<StartedPublicMcpTunnel> {
  const args = buildCloudflaredQuickTunnelArgs(options.server.port);
  let lastFailure = "cloudflared did not publish a quick-tunnel URL";

  for (let attempt = 1; attempt <= QUICK_TUNNEL_ATTEMPTS; attempt += 1) {
    let origin: string | null = null;
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
    const child = spawn(options.cloudflaredBin ?? "cloudflared", args, {
      detached: true,
      env: buildCloudflaredSubprocessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = waitForExit(child);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", inspectOutputForOrigin());
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", inspectOutputForOrigin());
    child.once("error", (error) => {
      spawnError = error;
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
        const probe = await probePublicTunnel(origin);
        if (probe.ready) {
          const tunnel = {
            origin,
            url: `${origin}/mcp`,
            close,
          };
          options.cleanup.add(`stop ${options.label} cloudflared quick tunnel`, tunnel.close);
          return tunnel;
        }
        lastFailure = `cloudflared published a quick-tunnel URL but ${probe.diagnostic}`;
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
        } else if (
          toolResultCount !== 1 ||
          !hasExpectedToolResult(0, "call_progressive_tool_search", [`- ${toolName}:`])
        ) {
          protocolError = "search_tools did not return the expected progressive target";
        } else if (!visibleToolNames.has(toolName)) {
          protocolError = `progressive target ${toolName} was not visible after search_tools`;
        } else {
          plannedToolCall = {
            id: "call_progressive_mcp_proof",
            name: toolName,
            arguments: { challenge: options.toolChallenge },
          };
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
          if (
            hasExpectedToolResult(0, "call_hermes_tool_search", [
              "matches",
              options.deferredToolName,
            ])
          ) {
            plannedToolCall = {
              id: "call_hermes_tool_describe",
              name: "tool_describe",
              arguments: { name: options.deferredToolName },
            };
          } else {
            protocolError = "Hermes tool_search did not return the deferred target";
          }
        } else if (toolResultCount === 2) {
          if (
            hasExpectedToolResult(1, "call_hermes_tool_describe", [
              options.deferredToolName,
              "parameters",
              "challenge",
            ])
          ) {
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
          protocolError = "Hermes returned an unexpected number of tool results";
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
  const requests: Array<{
    method: string;
    path: string;
    auth: string;
    body: string;
  }> = [];
  const server = https.createServer(tls, async (req, res) => {
    const requestPath = new URL(req.url ?? "/", "https://fake-mcp.local").pathname;
    const body = await readRequestBody(req);
    const auth = Array.isArray(req.headers.authorization)
      ? req.headers.authorization.join(",")
      : (req.headers.authorization ?? "");
    let parsedPayload: McpRequestPayload | null = null;
    try {
      parsedPayload = JSON.parse(body) as McpRequestPayload;
    } catch {
      // The protocol error below handles malformed JSON after recording it.
    }
    // The public quick-tunnel readiness probe uses HEAD /mcp. Keep it out of
    // the protocol request ledger so zero-upstream decoy and policy-denial
    // assertions continue to measure only attempted MCP traffic.
    if (req.method !== "HEAD") {
      requests.push({
        method: req.method ?? "",
        path: requestPath,
        auth,
        body,
        ...(typeof parsedPayload?.method === "string" ? { rpcMethod: parsedPayload.method } : {}),
      });
    }
    if (requestPath !== "/mcp") {
      jsonResponse(res, 404, { error: { message: "not found" } });
      return;
    }
    if (req.method === "HEAD" || req.method === "GET") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: { message: "method not allowed" } });
      return;
    }
    if (auth !== `Bearer ${expectedSecret}`) {
      jsonResponse(res, 401, { error: { message: "missing rewritten bearer credential" } });
      return;
    }

    if (!parsedPayload) {
      jsonResponse(res, 400, { error: { message: "invalid json" } });
      return;
    }
    if (
      typeof parsedPayload.method === "string" &&
      MCP_NOTIFICATION_METHODS.has(parsedPayload.method)
    ) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown;
    if (parsedPayload.method === "initialize") {
      const request = JSON.parse(body) as {
        params?: { protocolVersion?: string };
      };
      result = {
        protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      };
    } else if (parsedPayload.method === "tools/list") {
      result = {
        tools: [
          {
            name: "fake_echo",
            description: "Returns an authenticated MCP proof token",
            inputSchema: {
              type: "object",
              properties: { challenge: { type: "string" } },
              required: ["challenge"],
              additionalProperties: false,
            },
          },
        ],
      };
    } else if (parsedPayload.method === "tools/call") {
      const challenge = parsedPayload.params?.arguments?.challenge;
      if (
        parsedPayload.params?.name !== "fake_echo" ||
        (options.challenge !== undefined && challenge !== options.challenge)
      ) {
        jsonResponse(res, 200, {
          jsonrpc: "2.0",
          id: parsedPayload.id ?? 1,
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
      jsonResponse(res, 200, {
        jsonrpc: "2.0",
        id: parsedPayload.id ?? 1,
        error: { code: -32601, message: "method not found" },
      });
      return;
    }
    jsonResponse(res, 200, {
      jsonrpc: "2.0",
      id: parsedPayload.id ?? 1,
      result,
    });
  });

  await listenOnRandomPort(server);
  return {
    port: requireTcpPort(server, "fake MCP endpoint"),
    requests,
    setSecret: (secret: string) => {
      expectedSecret = secret;
    },
    close: () => closeServer(server),
  };
}
