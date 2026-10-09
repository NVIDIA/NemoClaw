// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

/** Authenticated Anthropic Messages fixture; request evidence never stores credentials. */
export async function startFakeAnthropicCompatibleServer(options: {
  apiKey: string;
  model: string;
  publicHost: string;
}) {
  const requests: {
    path: string;
    model: string | null;
    authenticated: boolean;
    stream: boolean;
  }[] = [];
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.local").pathname;
    const authenticated = request.headers["x-api-key"] === options.apiKey;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let payload: { model?: string; stream?: boolean } = {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid request");
      const record = parsed as Record<string, unknown>;
      payload = {
        model: typeof record.model === "string" ? record.model : undefined,
        stream: record.stream === true,
      };
    } catch {
      response.writeHead(400).end();
      return;
    }
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (!authenticated) {
      json(401, {
        type: "error",
        error: { type: "authentication_error", message: "unauthorized" },
      });
      return;
    }
    if (request.method === "GET" && pathname === "/v1/models") {
      json(200, { data: [{ id: options.model, type: "model" }] });
      return;
    }
    if (request.method !== "POST" || pathname !== "/v1/messages") {
      json(404, { type: "error", error: { type: "not_found_error" } });
      return;
    }
    requests.push({
      path: pathname,
      model: payload.model ?? null,
      authenticated,
      stream: payload.stream === true,
    });
    if (payload.model !== options.model) {
      json(400, {
        type: "error",
        error: { type: "invalid_request_error", message: "unknown model" },
      });
      return;
    }
    const message = {
      id: "msg_native_fixture",
      type: "message",
      role: "assistant",
      model: options.model,
      content: [{ type: "text", text: "PONG" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    if (!payload.stream) {
      json(200, message);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
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
    ];
    for (const [event, data] of events)
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Anthropic fixture has no TCP address");
  return {
    endpointUrl: `http://${options.publicHost}:${address.port}`,
    requests: () => requests.slice(),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
