#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;

const host = process.env.NEMOCLAW_FAKE_OPENAI_HOST || "127.0.0.1";
const port = Number(process.env.NEMOCLAW_FAKE_OPENAI_PORT || "0");
const portFile = process.env.NEMOCLAW_FAKE_OPENAI_PORT_FILE || "";
const logFile = process.env.NEMOCLAW_FAKE_OPENAI_LOG_FILE || "";
const requestsFile = process.env.NEMOCLAW_FAKE_OPENAI_REQUESTS_FILE || "";
const model = process.env.NEMOCLAW_FAKE_OPENAI_MODEL || "test-model";
// Optional runtime context window advertised on /v1/models, mirroring vLLM's
// max_model_len so onboarding can probe a real endpoint's context (#6177).
const maxModelLen = (() => {
  const raw = (process.env.NEMOCLAW_FAKE_OPENAI_MAX_MODEL_LEN || "").trim();
  return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
})();
const apiKey = process.env.NEMOCLAW_FAKE_OPENAI_API_KEY || "";
const requireAuth = process.env.NEMOCLAW_FAKE_OPENAI_REQUIRE_AUTH === "1";
// Opt-in auth enforcement on GET /v1/models specifically (real vLLM launched
// with --api-key gates it). Separate from requireAuth so existing tests, whose
// readiness probe hits /v1/models unauthenticated, keep working. See #6177.
const requireAuthModels = process.env.NEMOCLAW_FAKE_OPENAI_REQUIRE_AUTH_MODELS === "1";
const chatContent = process.env.NEMOCLAW_FAKE_OPENAI_CHAT_CONTENT || "ok";
const responseText = process.env.NEMOCLAW_FAKE_OPENAI_RESPONSE_TEXT || chatContent;
const forbiddenMarkers = (() => {
  try {
    const parsed = JSON.parse(process.env.NEMOCLAW_FAKE_OPENAI_FORBIDDEN_MARKERS || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
})();

function log(message: string): void {
  if (logFile) {
    appendFileSync(logFile, `${message}\n`);
    return;
  }
  console.log(message);
}

function recordRequest(entry: JsonObject): void {
  if (!requestsFile) return;
  appendFileSync(requestsFile, `${JSON.stringify(entry)}\n`);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendChatSse(res: ServerResponse, content: string): void {
  const chunk = JSON.stringify({
    id: "chatcmpl-fake-openai-compatible",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  const doneChunk = JSON.stringify({
    id: "chatcmpl-fake-openai-compatible",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const body = `data: ${chunk}\n\ndata: ${doneChunk}\n\ndata: [DONE]\n\n`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendResponseSse(res: ServerResponse, text: string): void {
  const body = [
    "event: response.output_text.delta",
    `data: ${JSON.stringify({ delta: text })}`,
    "",
    "event: response.completed",
    "data: {}",
    "",
  ].join("\n");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isAuthOk(req: IncomingMessage): boolean {
  if (!requireAuth) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url || "/", "http://fake-openai-compatible.local").pathname;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function parseJsonBody(raw: Buffer): JsonObject {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function forbiddenMarkerMatches(req: IncomingMessage, raw: Buffer): number {
  const headerValues = Object.values(req.headers).flatMap((value) => value ?? []);
  const requestMaterial = [req.url ?? "", ...headerValues, raw.toString("utf8")].join("\n");
  return forbiddenMarkers.filter((marker) => requestMaterial.includes(marker)).length;
}

const server = createServer(async (req, res) => {
  const path = requestPath(req);

  if (req.method === "GET" && ["/v1/models", "/models"].includes(path)) {
    const modelsAuthOk = !requireAuthModels || req.headers.authorization === `Bearer ${apiKey}`;
    log(`GET ${path} auth=${modelsAuthOk ? "ok" : "missing"}`);
    recordRequest({
      method: "GET",
      path,
      bodyBytes: 0,
      auth: modelsAuthOk ? "ok" : "missing",
      // Presence only (never the token) so callers can prove a probe sent its
      // credential without leaking it into the requests log (#6177).
      authorizationSent: Boolean(req.headers.authorization),
      forbiddenMarkerMatches: forbiddenMarkerMatches(req, Buffer.alloc(0)),
    });
    if (!modelsAuthOk) {
      sendJson(res, 401, { error: { message: "missing bearer credential" } });
      return;
    }
    const modelEntry: JsonObject = { id: model, object: "model" };
    if (maxModelLen !== null) modelEntry.max_model_len = maxModelLen;
    sendJson(res, 200, { object: "list", data: [modelEntry] });
    return;
  }

  const raw = await readBody(req);
  const payload = parseJsonBody(raw);
  const auth = isAuthOk(req) ? "ok" : "missing";
  recordRequest({
    method: req.method || "GET",
    path,
    bodyBytes: raw.length,
    auth,
    // Presence only (never the token), matching the models request record.
    authorizationSent: Boolean(req.headers.authorization),
    model: payload.model,
    stream: Boolean(payload.stream),
    forbiddenMarkerMatches: forbiddenMarkerMatches(req, raw),
  });

  if (req.method === "POST" && ["/v1/chat/completions", "/chat/completions"].includes(path)) {
    log(
      `POST ${path} auth=${auth} model=${String(payload.model || "")} stream=${Boolean(payload.stream)}`,
    );
    if (!isAuthOk(req)) {
      sendJson(res, 401, { error: { message: "missing bearer credential" } });
      return;
    }
    if (payload.stream) {
      sendChatSse(res, chatContent);
      return;
    }
    sendJson(res, 200, {
      id: "chatcmpl-fake-openai-compatible",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: chatContent },
          finish_reason: "stop",
        },
      ],
    });
    return;
  }

  if (req.method === "POST" && ["/v1/responses", "/responses"].includes(path)) {
    log(`POST ${path} auth=${auth} stream=${Boolean(payload.stream)}`);
    if (!isAuthOk(req)) {
      sendJson(res, 401, { error: { message: "missing bearer credential" } });
      return;
    }
    if (payload.stream) {
      sendResponseSse(res, responseText);
      return;
    }
    sendJson(res, 200, {
      id: "resp-fake-openai-compatible",
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: responseText }],
        },
      ],
    });
    return;
  }

  sendJson(res, 404, { error: { message: "not found" } });
});

server.listen(port, host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake OpenAI-compatible server did not bind to a TCP port");
  }
  if (portFile) writeFileSync(portFile, String(address.port));
  log(`READY host=${host} port=${address.port} model=${model}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
