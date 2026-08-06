// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentTurnEvent } from "./contracts";
import { OpenClawVoiceClient } from "./openclaw-client";

interface SentRequest {
  readonly type: string;
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: SentRequest[] = [];
  closed = false;
  readonly firstReply: string;
  readonly finalReply: string;
  readonly oversizedFrameAfterConnect: boolean;

  constructor(firstReply = "hel", finalReply = "hello", oversizedFrameAfterConnect = false) {
    this.firstReply = firstReply;
    this.finalReply = finalReply;
    this.oversizedFrameAfterConnect = oversizedFrameAfterConnect;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const request = JSON.parse(data) as SentRequest;
    this.sent.push(request);
    switch (request.method) {
      case "connect":
        queueMicrotask(() => {
          this.respond(request.id, {});
          this.oversizedFrameAfterConnect
            ? this.onmessage?.({ data: `{"padding":"${"x".repeat(3 * 1024 * 1024)}"}` })
            : undefined;
        });
        return;
      case "chat.send": {
        const sessionKey = String(request.params.sessionKey);
        queueMicrotask(() => {
          this.respond(request.id, { runId: "expected-run" });
          queueMicrotask(() => {
            this.event(sessionKey, "other-run", "delta", "discarded run");
            this.event("other-session", "expected-run", "delta", "discarded session");
            this.event(sessionKey, "expected-run", "delta", this.firstReply);
            this.event(sessionKey, "expected-run", "final", this.finalReply);
          });
        });
        return;
      }
      default:
        return;
    }
  }

  close(): void {
    this.closed = true;
  }

  private respond(id: string, payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({ type: "res", id, ok: true, payload }),
    });
  }

  private event(sessionKey: string, runId: string, state: string, text: string): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          sessionKey,
          runId,
          state,
          message: { content: [{ type: "text", text }] },
          nativeSecret: "must-not-cross",
        },
      }),
    });
  }
}

describe("OpenClaw voice gateway client", () => {
  it("uses bounded operator scopes and emits only ordered normalized text for the expected session and run (#8378)", async () => {
    const socket = new FakeWebSocket();
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

    expect(result).toEqual({ outcome: "completed" });
    expect(events).toEqual([
      { type: "started" },
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
    ]);
    const connect = socket.sent.find((request) => request.method === "connect");
    expect(connect?.params).toMatchObject({
      client: { id: "openclaw-cli", mode: "cli" },
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

  it("fails closed when ordered response text changes its prior prefix (#8378)", async () => {
    const socket = new FakeWebSocket("first", "different");
    const client = new OpenClawVoiceClient({
      gatewayUrl: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-credential-must-not-cross",
      webSocketFactory: () => socket,
    });

    await expect(
      client.runTurn({
        sessionKey: "agent:main:nemoclaw-voice:session",
        idempotencyKey: "generated-turn-id",
        message: "repository status",
        onEvent: () => {},
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "agent_protocol_error" });
  });

  it("closes the direct WebSocket connection when the session owner revokes it (#8378)", () => {
    const socket = new FakeWebSocket();
    const client = new OpenClawVoiceClient({
      gatewayUrl: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-credential-must-not-cross",
      webSocketFactory: () => socket,
    });
    void client.runTurn({
      sessionKey: "agent:main:nemoclaw-voice:session",
      idempotencyKey: "generated-turn-id",
      message: "repository status",
      onEvent: () => {},
    });

    client.close();

    expect(socket.closed).toBe(true);
  });

  it("rejects an oversized native frame before sending agent work (#8378)", async () => {
    const socket = new FakeWebSocket("hel", "hello", true);
    const client = new OpenClawVoiceClient({
      gatewayUrl: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-credential-must-not-cross",
      webSocketFactory: () => socket,
    });

    await expect(
      client.runTurn({
        sessionKey: "agent:main:nemoclaw-voice:session",
        idempotencyKey: "generated-turn-id",
        message: "must-not-send",
        onEvent: () => {},
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "agent_protocol_error" });

    expect(socket.sent.some((request) => request.method === "chat.send")).toBe(false);
    expect(socket.closed).toBe(true);
  });
});
