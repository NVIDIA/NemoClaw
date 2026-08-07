// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  type AgentTurnClient,
  type AgentTurnEvent,
  VOICE_GATEWAY_MAX_RESPONSE_BYTES,
} from "./contracts";

const OPENCLAW_PROTOCOL_VERSION = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_NATIVE_FRAME_BYTES = VOICE_GATEWAY_MAX_RESPONSE_BYTES + 64 * 1024;
const MAX_QUEUED_CHAT_EVENTS = 128;

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type WebSocketFactory = (url: string) => WebSocketLike;

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: () => void;
  readonly timer: NodeJS.Timeout;
}

interface NativeChatEvent {
  readonly sessionKey: string;
  readonly runId: string;
  readonly state: string;
  readonly text: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function textFromMessage(message: unknown): string {
  const value = record(message);
  if (!value) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map((part) => {
      const item = record(part);
      return typeof item?.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseNativeChatEvent(frame: Record<string, unknown>): NativeChatEvent | null {
  if (frame.type !== "event" || frame.event !== "chat") return null;
  const payload = record(frame.payload);
  if (!payload) return null;
  const sessionKey = nonemptyString(payload.sessionKey);
  const runId = nonemptyString(payload.runId);
  const state = nonemptyString(payload.state);
  if (!sessionKey || !runId || !state) return null;
  return { sessionKey, runId, state, text: textFromMessage(payload.message) };
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("WebSocket support is unavailable.");
  }
  return new globalThis.WebSocket(url) as unknown as WebSocketLike;
}

export interface OpenClawVoiceClientOptions {
  readonly gatewayUrl: string;
  readonly credential: string;
  readonly webSocketFactory?: WebSocketFactory;
}

type TurnResult = Awaited<ReturnType<AgentTurnClient["runTurn"]>>;

/** Confines OpenClaw authentication, native frames, and run IDs to one client. */
export class OpenClawVoiceClient implements AgentTurnClient {
  private readonly gatewayUrl: string;
  private readonly credential: string;
  private readonly webSocketFactory: WebSocketFactory;
  private socket: WebSocketLike | null = null;
  private closed = false;
  private cancelCurrent: (() => void) | null = null;

  constructor(options: OpenClawVoiceClientOptions) {
    this.gatewayUrl = options.gatewayUrl;
    this.credential = options.credential;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  }

  close(): void {
    this.closed = true;
    this.cancelCurrent?.();
    this.socket?.close();
    this.socket = null;
  }

  async runTurn(options: {
    readonly idempotencyKey: string;
    readonly message: string;
    readonly onEvent: (event: AgentTurnEvent) => void;
    readonly sessionKey: string;
  }): Promise<TurnResult> {
    if (this.closed) return { outcome: "failed", reason: "agent_gateway_unavailable" };

    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(this.gatewayUrl);
      this.socket = socket;
    } catch {
      return { outcome: "failed", reason: "agent_gateway_unavailable" };
    }

    const pending = new Map<string, PendingRequest>();
    const queuedChatEvents: NativeChatEvent[] = [];
    let requestCounter = 0;
    let activeRunId: string | null = null;
    let previousText = "";
    let terminal = false;

    const clearPending = () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject();
      }
      pending.clear();
    };
    const request = (method: string, params: Record<string, unknown>) => {
      const id = `voice-${++requestCounter}`;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("request timeout"));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject: () => reject(new Error("request failed")), timer });
        socket.send(JSON.stringify({ type: "req", id, method, params }));
      });
    };

    let resolveTerminal: (value: TurnResult) => void = () => {};
    const terminalPromise = new Promise<TurnResult>((resolve) => {
      resolveTerminal = resolve;
    });
    let settleOpen: (() => void) | null = null;
    const finish = (value: TurnResult) => {
      if (terminal) return;
      terminal = true;
      this.cancelCurrent = null;
      clearPending();
      settleOpen?.();
      socket.close();
      resolveTerminal(value);
    };
    this.cancelCurrent = () => finish({ outcome: "failed", reason: "agent_gateway_unavailable" });
    const handleChat = (event: NativeChatEvent) => {
      if (
        terminal ||
        activeRunId === null ||
        event.sessionKey !== options.sessionKey ||
        event.runId !== activeRunId
      ) {
        return;
      }
      if (event.text.length > 0) {
        if (!event.text.startsWith(previousText)) {
          finish({ outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        const delta = event.text.slice(previousText.length);
        previousText = event.text;
        if (delta.length > 0) options.onEvent({ type: "text", text: delta });
      }
      if (event.state === "final") finish({ outcome: "completed" });
      else if (event.state === "error" || event.state === "aborted") {
        finish({ outcome: "failed", reason: "agent_failed" });
      }
    };

    socket.onmessage = (event) => {
      let frame: Record<string, unknown> | null = null;
      try {
        const raw = String(event.data);
        if (Buffer.byteLength(raw) > MAX_NATIVE_FRAME_BYTES) {
          finish({ outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        frame = record(JSON.parse(raw));
      } catch {
        finish({ outcome: "failed", reason: "agent_protocol_error" });
        return;
      }
      if (!frame) return;
      if (frame.type === "res" && typeof frame.id === "string") {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.ok === false || frame.error !== undefined) entry.reject();
        else entry.resolve(record(frame.payload) ?? record(frame.result) ?? frame);
        return;
      }
      const chat = parseNativeChatEvent(frame);
      if (!chat) return;
      if (activeRunId === null) {
        if (queuedChatEvents.length >= MAX_QUEUED_CHAT_EVENTS) {
          finish({ outcome: "failed", reason: "agent_protocol_error" });
          return;
        }
        queuedChatEvents.push(chat);
      } else handleChat(chat);
    };
    let rejectOpen: (() => void) | null = null;
    socket.onerror = () => {
      rejectOpen?.();
      finish({ outcome: "failed", reason: "agent_gateway_unavailable" });
    };
    socket.onclose = () => {
      rejectOpen?.();
      finish({ outcome: "failed", reason: "agent_gateway_unavailable" });
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("open timeout")), REQUEST_TIMEOUT_MS);
        settleOpen = () => {
          clearTimeout(timer);
          reject(new Error("turn terminal"));
        };
        rejectOpen = () => {
          clearTimeout(timer);
          reject(new Error("open failed"));
        };
        socket.onopen = () => {
          clearTimeout(timer);
          rejectOpen = null;
          settleOpen = null;
          resolve();
        };
      });
      await request("connect", {
        minProtocol: OPENCLAW_PROTOCOL_VERSION,
        maxProtocol: OPENCLAW_PROTOCOL_VERSION,
        client: {
          id: "openclaw-cli",
          displayName: "NemoClaw voice gateway",
          version: "1",
          platform: process.platform,
          mode: "cli",
          instanceId: randomUUID(),
        },
        caps: [],
        scopes: ["operator.read", "operator.write"],
        auth: { token: this.credential },
      });
      if (terminal) return terminalPromise;
      const sent = await request("chat.send", {
        sessionKey: options.sessionKey,
        message: options.message,
        deliver: false,
        timeoutMs: 90_000,
        idempotencyKey: options.idempotencyKey,
      });
      activeRunId = nonemptyString(sent.runId);
      if (!activeRunId) {
        finish({ outcome: "failed", reason: "agent_protocol_error" });
      } else {
        options.onEvent({ type: "started" });
        for (const event of queuedChatEvents.splice(0)) handleChat(event);
      }
    } catch {
      finish({ outcome: "failed", reason: "agent_gateway_unavailable" });
    }

    return terminalPromise;
  }
}
