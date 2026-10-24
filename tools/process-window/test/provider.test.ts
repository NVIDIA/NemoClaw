// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ProviderSession, readResponseStream } from "../src/provider.js";

test("Responses preserves reasoning and tool call IDs and rejects incomplete results", async () => {
  let turn = 0;
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "test-encrypted-state",
    summary: [],
  };
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      turn++;
      assert.equal(req.url, "/responses");
      assert.equal(body.model, "test-model");
      assert.equal(body.reasoning.effort, "high");
      assert.equal(body.store, false);
      assert.equal(body.tools[0].name, "read_files");
      assert.equal(body.tools[0].strict, false);
      let output: any[];
      if (turn === 1)
        output = [
          reasoning,
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read_files",
            arguments: '{"paths":["guide.ts"]}',
          },
        ];
      else {
        assert.deepEqual(body.input[1], reasoning);
        assert.deepEqual(body.input.at(-1), {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"content":"guidance"}',
        });
        output = [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          },
        ];
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: turn === 3 ? "incomplete" : "completed", output }));
    } catch {
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const session = new ProviderSession(
      {
        provider: "openai-compatible",
        api: "responses",
        model: "test-model",
        reasoningEffort: "high",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        maxTurns: 3,
        maxOutputTokens: 1000,
        timeoutSeconds: 10,
      },
      [{ role: "user", content: "Inspect guidance" }],
      [{ type: "function", function: { name: "read_files", parameters: { type: "object" } } }],
    );
    const next = await session.next();
    assert.equal(next.tool_calls[0].id, "call_1");
    session.result("call_1", { content: "guidance" });
    assert.equal((await session.next()).content, '{"ok":true}');
    // A separate session reproduces the same history for an incomplete final result.
    const incomplete = new ProviderSession(
      {
        provider: "openai-compatible",
        api: "responses",
        model: "test-model",
        reasoningEffort: "high",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        maxTurns: 3,
        maxOutputTokens: 1000,
        timeoutSeconds: 10,
      },
      [
        { role: "user", content: "Inspect guidance" },
        reasoning,
        { type: "function_call_output", call_id: "call_1", output: '{"content":"guidance"}' },
      ],
      [{ type: "function", function: { name: "read_files" } }],
    );
    await assert.rejects(incomplete.next(), /incomplete/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Responses streaming accepts fragmented events but never publishes partial output", async () => {
  const complete = {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "final" }] }],
  };
  const wire =
    'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n' +
    "data: " +
    JSON.stringify({ type: "response.completed", response: complete }) +
    "\n\n";
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < wire.length; i += 7)
        controller.enqueue(new TextEncoder().encode(wire.slice(i, i + 7)));
      controller.close();
    },
  });
  assert.deepEqual(await readResponseStream(new Response(stream)), complete);
  await assert.rejects(
    readResponseStream(
      new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
    ),
    /without a completed/,
  );
  await assert.rejects(
    readResponseStream(new Response('data: {"type":"response.incomplete"}\n\n')),
    /incomplete/,
  );
});

test("Responses completes on the terminal event even if the server keeps the connection open", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const completed = { status: "completed", output: [] };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
        ),
      );
    },
  });
  const pending = readResponseStream(new Response(stream));
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);
  if (result === "timeout") {
    controller.close();
    await pending;
  }
  assert.deepEqual(result, completed);
});
