// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { startFakeAnthropicCompatibleServer } from "../fixtures/fake-anthropic-compatible.ts";

it("requires Anthropic authentication and serves the selected model as JSON and SSE", async () => {
  const apiKey = "fixture-only-key";
  const server = await startFakeAnthropicCompatibleServer({
    apiKey,
    model: "fixture-model",
    publicHost: "127.0.0.1",
  });
  try {
    const request = (stream: boolean, key?: string, model = "fixture-model") =>
      fetch(`${server.endpointUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
        body: JSON.stringify({
          model,
          stream,
          messages: [{ role: "user", content: "Reply with only: PONG" }],
          max_tokens: 50,
        }),
      });
    expect((await request(false)).status).toBe(401);
    expect(server.requests()).toHaveLength(0);
    const json = await request(false, apiKey);
    expect(json.status).toBe(200);
    expect(await json.json()).toMatchObject({
      model: "fixture-model",
      content: [{ type: "text", text: "PONG" }],
      stop_reason: "end_turn",
    });
    const streamed = await request(true, apiKey);
    expect(streamed.status).toBe(200);
    const events = (await streamed.text())
      .trim()
      .split("\n\n")
      .map((entry) => JSON.parse(entry.split("\ndata: ")[1]!));
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[2].delta).toEqual({ type: "text_delta", text: "PONG" });
    const toolResponse = await fetch(`${server.endpointUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        model: "fixture-model",
        stream: true,
        tool_choice: { type: "tool", name: "emit_ok" },
      }),
    });
    expect(toolResponse.status).toBe(200);
    const toolEvents = (await toolResponse.text())
      .trim()
      .split("\n\n")
      .map((entry) => JSON.parse(entry.split("\ndata: ")[1]!));
    expect(toolEvents[1].content_block).toMatchObject({
      type: "tool_use",
      name: "emit_ok",
      input: {},
    });
    expect(toolEvents[2].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"value":"OK"}',
    });
    expect(toolEvents[4].delta.stop_reason).toBe("tool_use");
    expect((await request(false, apiKey, "wrong-model")).status).toBe(400);
    expect(server.requests().slice(0, 2)).toEqual([
      { path: "/v1/messages", model: "fixture-model", authenticated: true, stream: false },
      { path: "/v1/messages", model: "fixture-model", authenticated: true, stream: true },
    ]);
    expect(JSON.stringify(server.requests())).not.toContain(apiKey);
  } finally {
    await server.close();
  }
});
