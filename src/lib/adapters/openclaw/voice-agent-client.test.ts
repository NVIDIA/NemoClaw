// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { OpenClawVoiceAgentClient } from "./voice-agent-client";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  close = vi.fn();

  send(value: string) {
    const frame = JSON.parse(value) as Record<string, unknown>;
    this.sent.push(frame);
    const method = frame.method;
    const payload = method === "chat.send" ? { runId: "expected-run" } : { type: "hello-ok" };
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }),
        }),
      ),
    );
    if (method === "chat.send")
      queueMicrotask(() => {
        for (const event of [
          {
            sessionKey: "other-session",
            runId: "expected-run",
            seq: 1,
            state: "delta",
            deltaText: "discard-session",
          },
          {
            sessionKey: "agent:main:voice:session",
            runId: "other-run",
            seq: 1,
            state: "delta",
            deltaText: "discard-run",
          },
          {
            sessionKey: "agent:main:voice:session",
            runId: "expected-run",
            seq: 1,
            state: "delta",
            deltaText: "ordered ",
          },
          {
            sessionKey: "agent:main:voice:session",
            runId: "expected-run",
            seq: 2,
            state: "delta",
            deltaText: "result",
          },
          { sessionKey: "agent:main:voice:session", runId: "expected-run", seq: 9, state: "final" },
        ])
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "event", event: "chat", payload: event }),
            }),
          );
      });
  }
}

describe("OpenClaw voice agent client", () => {
  it("uses read and write scopes, chat.send, and exact session and run filtering (#8378)", async () => {
    const socket = new FakeSocket();
    const client = new OpenClawVoiceAgentClient({
      endpoint: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-secret-value-with-at-least-32-bytes",
      requestTimeoutMs: 1_000,
      createSocket: () => socket as never,
    });
    queueMicrotask(() => {
      socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "challenge" },
          }),
        }),
      );
    });
    const text: string[] = [];
    const runs: string[] = [];

    await client.invoke({
      agentSessionKey: "agent:main:voice:session",
      idempotencyKey: "derived-idempotency-key",
      text: "committed text",
      signal: new AbortController().signal,
      onText: (value) => text.push(value),
      onRun: (value) => runs.push(value),
    });

    const connect = socket.sent.find((frame) => frame.method === "connect") as {
      params: { scopes: string[]; auth: { token: string } };
    };
    const send = socket.sent.find((frame) => frame.method === "chat.send") as {
      params: Record<string, unknown>;
    };
    expect(connect.params.scopes).toEqual(["operator.read", "operator.write"]);
    expect(connect.params).toMatchObject({
      role: "operator",
      client: { id: "gateway-client", mode: "backend" },
    });
    expect(connect.params).not.toHaveProperty("device");
    expect(connect.params.auth.token).toBe("openclaw-secret-value-with-at-least-32-bytes");
    expect(send.params).toMatchObject({
      sessionKey: "agent:main:voice:session",
      message: "committed text",
      deliver: false,
      idempotencyKey: "derived-idempotency-key",
    });
    expect(runs).toEqual(["expected-run"]);
    expect(text).toEqual(["ordered result"]);
  });

  it("ignores queued data after the first terminal frame (#8378)", async () => {
    class TerminalSocket extends FakeSocket {
      override send(value: string) {
        const frame = JSON.parse(value) as Record<string, unknown>;
        this.sent.push(frame);
        if (frame.method === "connect") {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "res",
                  id: frame.id,
                  ok: true,
                  payload: { type: "hello-ok" },
                }),
              }),
            ),
          );
          return;
        }
        for (const payload of [
          { sessionKey: "agent:main:voice:session", runId: "expected-run", seq: 1, state: "final" },
          {
            sessionKey: "agent:main:voice:session",
            runId: "expected-run",
            seq: 2,
            state: "delta",
            deltaText: "must-not-deliver",
          },
        ])
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "event", event: "chat", payload }),
            }),
          );
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: { runId: "expected-run" },
              }),
            }),
          ),
        );
      }
    }
    const socket = new TerminalSocket();
    const onText = vi.fn();
    const client = new OpenClawVoiceAgentClient({
      endpoint: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-secret-value-with-at-least-32-bytes",
      requestTimeoutMs: 1_000,
      createSocket: () => socket as never,
    });
    queueMicrotask(() =>
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "challenge" },
          }),
        }),
      ),
    );
    await client.invoke({
      agentSessionKey: "agent:main:voice:session",
      idempotencyKey: "key",
      text: "text",
      signal: new AbortController().signal,
      onText,
      onRun: vi.fn(),
    });
    expect(onText).not.toHaveBeenCalled();
  });

  it("rejects projected response text above the bounded limit (#8378)", async () => {
    class OversizedSocket extends FakeSocket {
      override send(value: string) {
        const frame = JSON.parse(value) as Record<string, unknown>;
        this.sent.push(frame);
        if (frame.method === "connect") {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "res",
                  id: frame.id,
                  ok: true,
                  payload: { type: "hello-ok" },
                }),
              }),
            ),
          );
          return;
        }
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload: { runId: "expected-run" },
              }),
            }),
          );
          queueMicrotask(() => {
            for (const seq of [1, 2]) {
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    type: "event",
                    event: "chat",
                    payload: {
                      sessionKey: "agent:main:voice:session",
                      runId: "expected-run",
                      seq,
                      state: "delta",
                      deltaText: "x".repeat(1_100_000),
                    },
                  }),
                }),
              );
            }
          });
        });
      }
    }
    const socket = new OversizedSocket();
    const client = new OpenClawVoiceAgentClient({
      endpoint: "ws://127.0.0.1:18789/ws",
      credential: "openclaw-secret-value-with-at-least-32-bytes",
      requestTimeoutMs: 1_000,
      createSocket: () => socket as never,
    });
    queueMicrotask(() =>
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "challenge" },
          }),
        }),
      ),
    );
    await expect(
      client.invoke({
        agentSessionKey: "agent:main:voice:session",
        idempotencyKey: "key",
        text: "text",
        signal: new AbortController().signal,
        onText: vi.fn(),
        onRun: vi.fn(),
      }),
    ).rejects.toMatchObject({ reason: "agent_response_limit" });
  });

  it.each([
    "ws://example.com:18789/ws",
    "wss://127.0.0.1:18789/ws",
    "ws://token@127.0.0.1:18789/ws",
  ])("rejects an untrusted configured endpoint %s (#8378)", (endpoint) => {
    expect(
      () =>
        new OpenClawVoiceAgentClient({ endpoint, credential: "credential", requestTimeoutMs: 100 }),
    ).toThrow("loopback WebSocket URL");
  });
});
