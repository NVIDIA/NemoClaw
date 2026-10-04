// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentTurnEvent } from "./contracts";
import { OpenClawVoiceClient } from "./openclaw-client";

interface SentRequest {
  readonly type: string;
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type Handler = (request: SentRequest, socket: FakeWebSocket) => void;

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: SentRequest[] = [];
  closed = false;

  constructor(private readonly handlers: Record<string, Handler>) {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const request = JSON.parse(data) as SentRequest;
    this.sent.push(request);
    queueMicrotask(() => this.handlers[request.method]?.(request, this));
  }

  close(): void {
    this.closed = true;
  }

  respond(id: string, payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({ type: "res", id, ok: true, payload }),
    });
  }

  chat(payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: "chat",
        payload: { ...payload, nativeSecret: "must-not-cross" },
      }),
    });
  }
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1_786_032_000_000,
  };
}

type DeliverReply = (emit: () => void, respond: () => void) => void;

function replyHandlersWithDelivery(
  frames: ReadonlyArray<Record<string, unknown>>,
  deliver: DeliverReply,
): Record<string, Handler> {
  return {
    connect: (request, socket) => socket.respond(request.id, {}),
    "chat.send": (request, socket) => {
      const sessionKey = String(request.params.sessionKey);
      const emit = () => {
        for (const frame of frames) socket.chat({ sessionKey, runId: "expected-run", ...frame });
      };
      const respond = () => socket.respond(request.id, { runId: "expected-run" });
      deliver(emit, respond);
    },
  };
}

function replyHandlers(frames: ReadonlyArray<Record<string, unknown>>): Record<string, Handler> {
  return replyHandlersWithDelivery(frames, (emit, respond) => {
    respond();
    queueMicrotask(emit);
  });
}

function replyBeforeResponseHandlers(
  frames: ReadonlyArray<Record<string, unknown>>,
): Record<string, Handler> {
  return replyHandlersWithDelivery(frames, (emit, respond) => {
    emit();
    respond();
  });
}

function activeTurnHandlers(): Record<string, Handler> {
  return {
    connect: (request, socket) => socket.respond(request.id, {}),
    "chat.send": (request, socket) => socket.respond(request.id, { runId: "expected-run" }),
  };
}

function oversizedFrameHandlers(): Record<string, Handler> {
  return {
    connect: (request, socket) => {
      socket.respond(request.id, {});
      socket.onmessage?.({ data: `{"padding":"${"x".repeat(3 * 1024 * 1024)}"}` });
    },
  };
}

async function runTurn(handlers: Record<string, Handler>): Promise<{
  readonly result: Awaited<ReturnType<OpenClawVoiceClient["runTurn"]>>;
  readonly events: AgentTurnEvent[];
  readonly socket: FakeWebSocket;
}> {
  const socket = new FakeWebSocket(handlers);
  const events: AgentTurnEvent[] = [];
  const client = new OpenClawVoiceClient({
    gatewayUrl: "ws://127.0.0.1:18789/ws",
    credential: "openclaw-credential-must-not-cross",
    webSocketFactory: () => socket,
  });
  const result = await client.runTurn({
    sessionKey: "agent:main:nemoclaw-voice:session",
    idempotencyKey: "generated-turn-id",
    message: "repository status",
    onEvent: (event) => events.push(event),
  });
  return { result, events, socket };
}

describe("OpenClaw voice gateway client", () => {
  it("uses bounded operator scopes and returns only the expected session and run projection (#8482)", async () => {
    const handlers = replyHandlers([
      {
        sessionKey: "other-session",
        seq: 50,
        state: "delta",
        deltaText: "discarded session",
        message: assistantMessage("discarded session"),
      },
      {
        runId: "other-run",
        seq: 50,
        state: "delta",
        deltaText: "discarded run",
        message: assistantMessage("discarded run"),
      },
      { seq: 0, state: "delta", deltaText: "hel", message: assistantMessage("hel") },
      { seq: 1, state: "final", message: assistantMessage("hello") },
    ]);

    const { result, events, socket } = await runTurn(handlers);

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "hello" }]);
    const connect = socket.sent.find((request) => request.method === "connect");
    expect(connect?.params).toMatchObject({
      client: { id: "gateway-client", mode: "backend" },
      scopes: ["operator.read", "operator.write"],
      auth: { token: "openclaw-credential-must-not-cross" },
    });
    const send = socket.sent.find((request) => request.method === "chat.send");
    expect(send?.params).toMatchObject({
      sessionKey: "agent:main:nemoclaw-voice:session",
      message: "repository status",
      idempotencyKey: "generated-turn-id",
      deliver: false,
    });
    expect(JSON.stringify(events)).not.toContain("openclaw-credential");
    expect(JSON.stringify(events)).not.toContain("expected-run");
    expect(JSON.stringify(events)).not.toContain("must-not-cross");
  });

  it("recovers an omitted earlier delta from a later cumulative message (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        {
          seq: 2,
          state: "delta",
          deltaText: "world",
          message: assistantMessage("Hello world"),
        },
        { seq: 3, state: "final", message: assistantMessage("Hello world") },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "Hello world" }]);
  });

  it("reconciles a recognized final message before completion (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        { seq: 0, state: "delta", deltaText: "Hello" },
        { seq: 1, state: "final", message: assistantMessage("Hello world") },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "Hello world" }]);
  });

  it("accepts a final response that repeats the last sequence and contains assistant text (#9243)", async () => {
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 2, state: "delta", deltaText: "world", message: assistantMessage("Hello world") },
        { seq: 7, state: "delta", deltaText: "", message: assistantMessage("Hello world") },
        {
          sessionKey: "other-session",
          seq: 7,
          state: "final",
          message: assistantMessage("discarded session"),
        },
        {
          runId: "other-run",
          seq: 7,
          state: "final",
          message: assistantMessage("discarded run"),
        },
        { seq: 7, state: "final", message: assistantMessage("Hello world!") },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "Hello world!" }]);
    expect(socket.closed).toBe(true);
  });

  it("accepts schema-minimum deltas without optional messages (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        { seq: 0, state: "delta", deltaText: "hel" },
        { seq: 1, state: "delta", deltaText: "lo" },
        { seq: 2, state: "final" },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "hello" }]);
  });

  it("returns the replacement projection without exposing superseded text (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        { seq: 0, state: "delta", deltaText: "superseded" },
        { seq: 1, state: "delta", deltaText: "final", replace: true },
        { seq: 2, state: "final", message: assistantMessage("final") },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "final" }]);
  });

  it("falls back to canonical deltas when optional messages are unrecognized (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        {
          seq: 0,
          state: "delta",
          deltaText: "hel",
          message: { role: "user", content: [{ type: "text", text: "untrusted" }] },
        },
        {
          seq: 1,
          state: "delta",
          deltaText: "lo",
          message: { role: "assistant", content: [{ type: "text", text: 7 }] },
        },
        { seq: 2, state: "final", message: { role: "assistant", content: "unrecognized" } },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "hello" }]);
  });

  it.each([
    ["seq field", { state: "delta", deltaText: "message-only", message: assistantMessage("text") }],
    ["deltaText field", { seq: 0, state: "delta", message: assistantMessage("text") }],
    ["replace field", { seq: 0, state: "delta", deltaText: "text", replace: "yes" }],
  ])("rejects a delta with an invalid %s (#8482)", async (_name, frame) => {
    const { result, events } = await runTurn(replyHandlers([frame]));

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([{ type: "started" }]);
  });

  it.each([
    ["duplicate", 1],
    ["decreasing", 0],
  ])("rejects a %s sequence before returning response text (#8482)", async (_name, sequence) => {
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 1, state: "delta", deltaText: "first" },
        { seq: sequence, state: "delta", deltaText: "second" },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([{ type: "started" }]);
    expect(socket.closed).toBe(true);
  });

  it("rejects a final response with a lower sequence (#9243)", async () => {
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 7, state: "delta", deltaText: "first" },
        { seq: 6, state: "final", message: assistantMessage("complete") },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([{ type: "started" }]);
    expect(socket.closed).toBe(true);
  });

  it.each([
    ["no message", undefined],
    ["a user message", { role: "user", content: [{ type: "text", text: "untrusted" }] }],
    ["non-text assistant content", { role: "assistant", content: [{ type: "image" }] }],
  ])("rejects an equal-sequence final response with %s (#9243)", async (_name, message) => {
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 7, state: "delta", deltaText: "partial" },
        { seq: 7, state: "final", message },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([{ type: "started" }]);
    expect(socket.closed).toBe(true);
  });

  it("discards malformed frames for another session or run before projection checks (#8482)", async () => {
    const { result, events } = await runTurn(
      replyHandlers([
        { sessionKey: "other-session", state: "delta", message: assistantMessage("discarded") },
        { runId: "other-run", state: "delta", message: assistantMessage("discarded") },
        { seq: 0, state: "delta", deltaText: "kept" },
        { seq: 1, state: "final" },
      ]),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([{ type: "started" }, { type: "text", text: "kept" }]);
  });

  it("rejects a reconciled projection that exceeds the response bound (#8482)", async () => {
    const chunk = "x".repeat(VOICE_CHUNK_BYTES);
    const { result, events } = await runTurn(
      replyHandlers([
        { seq: 0, state: "delta", deltaText: chunk },
        {
          seq: 1,
          state: "delta",
          deltaText: "x",
          message: assistantMessage(`${chunk}${chunk}`),
        },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "response_too_large" });
    expect(events).toEqual([{ type: "started" }]);
  });

  it("rejects an oversized equal-sequence final response (#9243)", async () => {
    const chunk = "x".repeat(VOICE_CHUNK_BYTES);
    const { result, events, socket } = await runTurn(
      replyHandlers([
        { seq: 7, state: "delta", deltaText: "partial" },
        { seq: 7, state: "final", message: assistantMessage(`${chunk}${chunk}`) },
      ]),
    );

    expect(result).toEqual({ outcome: "failed", reason: "response_too_large" });
    expect(events).toEqual([{ type: "started" }]);
    expect(socket.closed).toBe(true);
  });

  it("rejects too many queued chat events before the run ID is admitted (#8482)", async () => {
    const frames = Array.from({ length: 129 }, (_, seq) => ({
      seq,
      state: "delta",
      deltaText: "x",
    }));
    const { result, events } = await runTurn(replyBeforeResponseHandlers(frames));

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(events).toEqual([]);
  });

  it("closes the direct WebSocket connection when the session owner revokes it (#8378)", async () => {
    const socket = new FakeWebSocket(activeTurnHandlers());
    const client = new OpenClawVoiceClient({
      gatewayUrl: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-credential-must-not-cross",
      webSocketFactory: () => socket,
    });
    const turn = client.runTurn({
      sessionKey: "agent:main:nemoclaw-voice:session",
      idempotencyKey: "generated-turn-id",
      message: "repository status",
      onEvent: () => {},
    });
    await vi.waitFor(() =>
      expect(socket.sent.some((request) => request.method === "chat.send")).toBe(true),
    );

    client.close();

    await expect(turn).resolves.toEqual({
      outcome: "failed",
      reason: "agent_gateway_unavailable",
    });
    expect(socket.closed).toBe(true);
  });

  it("rejects an oversized native frame before sending agent work (#8378)", async () => {
    const { result, socket } = await runTurn(oversizedFrameHandlers());

    expect(result).toEqual({ outcome: "failed", reason: "agent_protocol_error" });
    expect(socket.sent.some((request) => request.method === "chat.send")).toBe(false);
    expect(socket.closed).toBe(true);
  });
});

const VOICE_CHUNK_BYTES = 1024 * 1024 + 1;
