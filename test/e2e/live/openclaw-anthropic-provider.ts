// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http, { type Server } from "node:http";
import { anthropicToolCount } from "./openclaw-inference-switch-helpers.ts";

export interface MockAnthropicRequest {
  method: string;
  model: string | null;
  path: string;
  stream: boolean;
  toolCount: number | null;
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sseResponse(res: http.ServerResponse, events: Array<[string, unknown]>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const [name, payload] of events) {
    res.write(`event: ${name}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end();
}

export function createMockAnthropicProviderServer(options: {
  nativeCustom: boolean;
  credentialValue: string;
}): { server: Server; requests: MockAnthropicRequest[] } {
  const requests: MockAnthropicRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock.local");
    if (["GET", "HEAD"].includes(req.method ?? "") && url.pathname === "/health") {
      jsonResponse(res, 200, { ok: true });
      return;
    }
    if (
      req.method === "GET" &&
      ["/v1/models", "/v1/models/mock-anthropic-model"].includes(url.pathname)
    ) {
      jsonResponse(res, 200, { data: [{ id: "mock-anthropic-model" }] });
      return;
    }
    const invalidCredential =
      options.nativeCustom && req.headers["x-api-key"] !== options.credentialValue;
    if (req.method !== "POST" || url.pathname !== "/v1/messages" || invalidCredential) {
      jsonResponse(res, invalidCredential ? 401 : 404, {
        error: "request rejected",
        path: url.pathname,
      });
      return;
    }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let payload: { model?: unknown; stream?: unknown; tools?: unknown } = {};
      try {
        payload = JSON.parse(raw || "{}") as {
          stream?: unknown;
          tools?: unknown;
        };
      } catch {
        payload = {};
      }
      const model = typeof payload.model === "string" ? payload.model : "mock-anthropic-model";
      requests.push({
        method: req.method ?? "",
        model: typeof payload.model === "string" ? payload.model : null,
        path: url.pathname,
        stream: payload.stream === true,
        toolCount: anthropicToolCount(payload.tools),
      });
      if (payload.stream === true) {
        const message = {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        };
        sseResponse(res, [
          ["message_start", { type: "message_start", message }],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          ],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PONG" } },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ]);
        return;
      }
      jsonResponse(res, 200, {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "PONG" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
  });

  return { server, requests };
}
