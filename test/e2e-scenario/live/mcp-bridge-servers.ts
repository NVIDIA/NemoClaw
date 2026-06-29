// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

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

interface McpRequestPayload {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: { challenge?: unknown } };
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

function requireTcpPort(server: TestServer, label: string): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(`${label} did not bind to a TCP port`);
  }
  return (address as AddressInfo).port;
}

function closeServer(server: TestServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listenOnRandomPort(server: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function startCompatibleMock(options: {
  apiKey: string;
  model: string;
  toolChallenge?: string;
  toolResultToken?: string;
  toolNames?: string[];
  deferredToolName?: string;
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
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const directToolName = body.tools
        ?.map((tool) => tool.function?.name)
        .find(
          (name): name is string =>
            typeof name === "string" && (options.toolNames ?? []).includes(name),
        );
      const deferredToolWrapper =
        !directToolName &&
        options.deferredToolName &&
        body.tools?.some((tool) => tool.function?.name === "tool_call")
          ? "tool_call"
          : undefined;
      const toolName = directToolName ?? deferredToolWrapper;
      const toolArguments = directToolName
        ? { challenge: options.toolChallenge }
        : {
            name: options.deferredToolName,
            arguments: { challenge: options.toolChallenge },
          };
      const sawAuthenticatedToolResult = (body.messages ?? []).some(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes(options.toolResultToken ?? "__never__"),
      );
      const responseMessage = sawAuthenticatedToolResult
        ? {
            role: "assistant",
            content: options.toolResultToken,
          }
        : toolName && options.toolChallenge
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: "call_mcp_bridge_proof",
                  type: "function",
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(toolArguments),
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
    requests.push({
      method: req.method ?? "",
      path: requestPath,
      auth,
      body,
      ...(typeof parsedPayload?.method === "string" ? { rpcMethod: parsedPayload.method } : {}),
    });
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
    if (parsedPayload.method === "notifications/initialized") {
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
    } else if (parsedPayload.method === "ping") {
      result = {};
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
