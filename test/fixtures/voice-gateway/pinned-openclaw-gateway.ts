// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface SentRequest {
  readonly type: string;
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Emits chat events for pinned OpenClaw v2026.7.1, including a repeated final sequence. */
export class PinnedOpenClawGateway {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: SentRequest[] = [];
  closed = false;

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const request = JSON.parse(data) as SentRequest;
    this.sent.push(request);
    queueMicrotask(() => {
      if (request.method === "connect") {
        const client = request.params.client;
        const scopes = request.params.scopes;
        if (
          client === null ||
          typeof client !== "object" ||
          Array.isArray(client) ||
          (client as Record<string, unknown>).id !== "gateway-client" ||
          (client as Record<string, unknown>).mode !== "backend" ||
          !Array.isArray(scopes) ||
          scopes.length !== 2 ||
          !scopes.includes("operator.read") ||
          !scopes.includes("operator.write")
        ) {
          this.reject(request.id);
          return;
        }
        this.respond(request.id, {});
      } else if (request.method === "chat.send") {
        this.respond(request.id, { runId: "pinned-openclaw-run" });
        queueMicrotask(() => this.emitRecoveredTurn(String(request.params.sessionKey)));
      }
    });
  }

  close(): void {
    this.closed = true;
  }

  private respond(id: string, payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type: "res", id, ok: true, payload }) });
  }

  private reject(id: string): void {
    this.onmessage?.({
      data: JSON.stringify({ type: "res", id, ok: false, error: "invalid client identity" }),
    });
  }

  private emitRecoveredTurn(sessionKey: string): void {
    this.chat({
      sessionKey,
      runId: "pinned-openclaw-run",
      seq: 2,
      state: "delta",
      deltaText: "world",
      message: this.assistantMessage("Hello world"),
    });
    this.chat({
      sessionKey,
      runId: "pinned-openclaw-run",
      seq: 7,
      state: "delta",
      deltaText: "",
      message: this.assistantMessage("Hello world"),
    });
    this.chat({
      sessionKey,
      runId: "pinned-openclaw-run",
      seq: 7,
      state: "final",
      message: this.assistantMessage("Hello world!"),
    });
  }

  private chat(payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: "chat",
        payload: { ...payload, nativeSecret: "must-not-cross" },
      }),
    });
  }

  private assistantMessage(text: string): Record<string, unknown> {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: 1_786_032_000_000,
    };
  }
}
