// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { WebSocket } from "undici";
import {
  type AgentTurnRequest,
  type VoiceAgentClient,
  VoiceAgentError,
} from "../../domain/voice/session-service";
import { VOICE_MAX_RESPONSE_TEXT_BYTES } from "../../domain/voice/session-service";

const OPENCLAW_PROTOCOL_VERSION = 4;
const MAX_NATIVE_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_CHAT_FRAMES = 64;
const MAX_QUEUED_CHAT_BYTES = 256 * 1024;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface OpenClawVoiceAgentClientOptions {
  endpoint: string;
  credential: string;
  requestTimeoutMs: number;
  createSocket?: (endpoint: string) => WebSocket;
}

function parseFixedLoopbackEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Voice agent gateway endpoint is invalid.");
  }
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/ws" ||
    url.search ||
    url.hash ||
    !url.port
  ) {
    throw new Error(
      "Voice agent gateway endpoint must be a credential-free loopback WebSocket URL.",
    );
  }
  return url.toString();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class OpenClawVoiceAgentClient implements VoiceAgentClient {
  private socket?: WebSocket;
  private requestSequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(private readonly options: OpenClawVoiceAgentClientOptions) {
    parseFixedLoopbackEndpoint(options.endpoint);
    if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new Error("Voice agent gateway timeout must be a positive integer.");
    }
  }

  async invoke(request: AgentTurnRequest): Promise<void> {
    const socket = await this.connect(request.signal);
    let expectedRunId: string | undefined;
    let lastSequence: number | undefined;
    let projectedText = "";
    let terminal = false;
    let settled = false;
    const queuedChatFrames: Record<string, unknown>[] = [];
    let queuedChatBytes = 0;

    await new Promise<void>((resolve, reject) => {
      const finish = (error?: VoiceAgentError) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        this.close();
        finish(new VoiceAgentError("agent_unavailable"));
      };
      const onClose = () => {
        if (!terminal) finish(new VoiceAgentError("agent_connection_failed"));
      };
      const consumeChatFrame = (frame: Record<string, unknown>) => {
        const payload = objectValue(frame.payload);
        if (!payload || payload.sessionKey !== request.agentSessionKey) return;
        if (typeof payload.runId !== "string" || payload.runId !== expectedRunId) return;
        if (
          typeof payload.seq !== "number" ||
          !Number.isInteger(payload.seq) ||
          payload.seq < 0 ||
          (lastSequence !== undefined && payload.seq <= lastSequence)
        ) {
          this.close();
          finish(new VoiceAgentError("agent_protocol_error"));
          return;
        }
        lastSequence = payload.seq;
        if (payload.state === "delta") {
          if (typeof payload.deltaText !== "string") {
            this.close();
            finish(new VoiceAgentError("agent_protocol_error"));
            return;
          }
          const projectedBytes =
            payload.replace === true
              ? Buffer.byteLength(payload.deltaText)
              : Buffer.byteLength(projectedText) + Buffer.byteLength(payload.deltaText);
          if (projectedBytes > VOICE_MAX_RESPONSE_TEXT_BYTES) {
            this.close();
            finish(new VoiceAgentError("agent_response_limit"));
            return;
          }
          projectedText =
            payload.replace === true ? payload.deltaText : `${projectedText}${payload.deltaText}`;
          return;
        }
        if (payload.state === "final") {
          if (projectedText) request.onText(projectedText);
          terminal = true;
          finish();
        } else if (payload.state === "error" || payload.state === "aborted") {
          terminal = true;
          finish(new VoiceAgentError("agent_unavailable"));
        } else {
          this.close();
          finish(new VoiceAgentError("agent_protocol_error"));
        }
      };
      const onMessage = (event: MessageEvent) => {
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw || Buffer.byteLength(raw) > MAX_NATIVE_FRAME_BYTES) {
          this.close();
          finish(new VoiceAgentError("agent_protocol_error"));
          return;
        }
        let frame: Record<string, unknown>;
        try {
          frame = objectValue(JSON.parse(raw)) ?? {};
        } catch {
          this.close();
          finish(new VoiceAgentError("agent_protocol_error"));
          return;
        }
        this.resolveRequestFrame(frame);
        if (frame.type !== "event" || frame.event !== "chat") return;
        if (!expectedRunId) {
          const payload = objectValue(frame.payload);
          if (!payload || payload.sessionKey !== request.agentSessionKey) return;
          queuedChatBytes += Buffer.byteLength(raw);
          if (
            queuedChatFrames.length >= MAX_QUEUED_CHAT_FRAMES ||
            queuedChatBytes > MAX_QUEUED_CHAT_BYTES
          ) {
            this.close();
            finish(new VoiceAgentError("agent_protocol_error"));
            return;
          }
          queuedChatFrames.push(frame);
        } else {
          consumeChatFrame(frame);
        }
      };

      request.signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      this.request(
        "chat.send",
        {
          sessionKey: request.agentSessionKey,
          message: request.text,
          deliver: false,
          timeoutMs: this.options.requestTimeoutMs,
          idempotencyKey: request.idempotencyKey,
        },
        request.signal,
      )
        .then((value) => {
          const response = objectValue(value);
          const runId = typeof response?.runId === "string" ? response.runId : undefined;
          if (!runId) {
            finish(new VoiceAgentError("agent_protocol_error"));
            return;
          }
          expectedRunId = runId;
          request.onRun(runId);
          for (const frame of queuedChatFrames.splice(0)) {
            if (settled) break;
            consumeChatFrame(frame);
          }
        })
        .catch((error) =>
          finish(
            error instanceof VoiceAgentError ? error : new VoiceAgentError("agent_unavailable"),
          ),
        );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.close(1000, "voice session closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new VoiceAgentError("agent_connection_failed"));
    }
    this.pending.clear();
  }

  private connect(signal: AbortSignal): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new VoiceAgentError("agent_connection_failed"));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    const endpoint = parseFixedLoopbackEndpoint(this.options.endpoint);
    const socket = this.options.createSocket?.(endpoint) ?? new WebSocket(endpoint);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let settled = false;
      let challengeReceived = false;
      const finish = (error?: VoiceAgentError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve(socket);
      };
      const fail = (reason: "agent_connection_failed" | "agent_authentication_failed") =>
        finish(new VoiceAgentError(reason));
      const onAbort = () => {
        socket.close();
        fail("agent_connection_failed");
      };
      const onError = () => fail("agent_connection_failed");
      const onClose = () => fail("agent_connection_failed");
      const onMessage = (event: MessageEvent) => {
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > MAX_NATIVE_FRAME_BYTES
        ) {
          fail("agent_connection_failed");
          return;
        }
        let frame: Record<string, unknown>;
        try {
          frame = objectValue(JSON.parse(event.data)) ?? {};
        } catch {
          fail("agent_connection_failed");
          return;
        }
        this.resolveRequestFrame(frame);
        if (frame.type !== "event" || frame.event !== "connect.challenge") return;
        const payload = objectValue(frame.payload);
        if (challengeReceived || typeof payload?.nonce !== "string" || !payload.nonce.trim()) {
          fail("agent_connection_failed");
          return;
        }
        challengeReceived = true;
        this.request(
          "connect",
          {
            minProtocol: OPENCLAW_PROTOCOL_VERSION,
            maxProtocol: OPENCLAW_PROTOCOL_VERSION,
            client: {
              id: "gateway-client",
              displayName: "NemoClaw experimental voice gateway",
              version: "1",
              platform: process.platform,
              mode: "backend",
            },
            caps: [],
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            auth: { token: this.options.credential },
          },
          signal,
        )
          .then(() => finish())
          .catch(() => fail("agent_authentication_failed"));
      };
      const timer = setTimeout(() => {
        socket.close();
        fail("agent_connection_failed");
      }, this.options.requestTimeoutMs);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new VoiceAgentError("agent_connection_failed"));
    }
    const id = `voice-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VoiceAgentError("agent_unavailable"));
      }, this.options.requestTimeoutMs);
      timer.unref();
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new VoiceAgentError("agent_unavailable"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private resolveRequestFrame(frame: Record<string, unknown>): void {
    if (frame.type !== "res" || typeof frame.id !== "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok === false || frame.error) {
      pending.reject(new VoiceAgentError("agent_unavailable"));
    } else {
      pending.resolve(frame.payload ?? frame.result ?? frame);
    }
  }
}
