// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export const VOICE_MAX_COMMIT_ID_BYTES = 256;
export const VOICE_MAX_TURN_TEXT_BYTES = 16 * 1024;
export const VOICE_MAX_RESPONSE_TEXT_BYTES = 2 * 1024 * 1024;
export const VOICE_MAX_SESSION_LIFETIME_MS = 15 * 60_000;
export const VOICE_MAX_TURN_TIMEOUT_MS = 2 * 60_000;

export type VoiceFailureReason =
  | "agent_authentication_failed"
  | "agent_connection_failed"
  | "agent_protocol_error"
  | "agent_response_limit"
  | "agent_unavailable"
  | "session_closed"
  | "session_expired"
  | "turn_timeout";

export type VoiceResponseEvent =
  | {
      type: "response.started";
      sequence: number;
      voiceSessionId: string;
      turnId: string;
      responseId: string;
    }
  | {
      type: "response.text.delta";
      sequence: number;
      voiceSessionId: string;
      turnId: string;
      responseId: string;
      text: string;
    }
  | {
      type: "response.completed";
      sequence: number;
      voiceSessionId: string;
      turnId: string;
      responseId: string;
    }
  | {
      type: "response.failed";
      sequence: number;
      voiceSessionId: string;
      turnId: string;
      responseId: string;
      reason: VoiceFailureReason;
    };

export interface AgentTurnRequest {
  agentSessionKey: string;
  idempotencyKey: string;
  text: string;
  signal: AbortSignal;
  onText: (text: string) => void;
  onRun: (runId: string) => void;
}

export interface VoiceAgentClient {
  invoke(request: AgentTurnRequest): Promise<void>;
  close(): void;
}

export interface VoiceSessionBinding {
  voiceSessionId: string;
  runtimeId: string;
  runtimeProfile: string;
  runtimeConversationId: string;
  sandbox: string;
  agent: string;
  agentSessionKey: string;
  expiresAt: string;
}

export interface VoiceDiagnostic {
  event: string;
  state: string;
  voiceSessionId?: string;
  turnId?: string;
  responseId?: string;
  openClawRunId?: string;
  reason?: string;
  durationMs?: number;
}

export class VoiceSessionError extends Error {
  constructor(
    readonly code:
      | "duplicate_turn"
      | "invalid_grant"
      | "invalid_request"
      | "session_expired"
      | "session_in_progress"
      | "session_not_found"
      | "turn_in_progress",
    readonly status: number,
  ) {
    super(code);
  }
}

interface SessionRecord extends VoiceSessionBinding {
  grantHash: Buffer;
  expiresAtMs: number;
  expiryTimer: NodeJS.Timeout;
  agentClient: VoiceAgentClient;
  acceptedCommitId?: string;
  active?: {
    turnId: string;
    responseId: string;
    startedAt: number;
    controller: AbortController;
    timedOut: boolean;
    responseLimitExceeded?: boolean;
    expiryReason?: "session_closed" | "session_expired";
    runId?: string;
  };
}

export interface VoiceSessionServiceOptions {
  runtimeId: string;
  runtimeProfile: string;
  sandbox: string;
  agent: string;
  sessionLifetimeMs: number;
  turnTimeoutMs: number;
  createAgentClient: () => VoiceAgentClient;
  diagnostic?: (diagnostic: VoiceDiagnostic) => void;
  now?: () => number;
  randomId?: () => string;
  randomGrant?: () => string;
}

function hashCredential(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

function equalCredential(value: string, expectedHash: Buffer): boolean {
  return crypto.timingSafeEqual(hashCredential(value), expectedHash);
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maxBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new VoiceSessionError("invalid_request", 400);
  }
  if (label === "text" && value.trim().length === 0) {
    throw new VoiceSessionError("invalid_request", 400);
  }
  return value;
}

export class VoiceSessionService {
  private session?: SessionRecord;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomGrant: () => string;
  private readonly diagnostic: (diagnostic: VoiceDiagnostic) => void;

  constructor(private readonly options: VoiceSessionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? crypto.randomUUID;
    this.randomGrant = options.randomGrant ?? (() => crypto.randomBytes(32).toString("base64url"));
    this.diagnostic = options.diagnostic ?? (() => {});
    if (
      !Number.isInteger(options.sessionLifetimeMs) ||
      options.sessionLifetimeMs < 1 ||
      options.sessionLifetimeMs > VOICE_MAX_SESSION_LIFETIME_MS
    ) {
      throw new Error(
        `Voice session lifetime must be an integer between 1 and ${VOICE_MAX_SESSION_LIFETIME_MS}.`,
      );
    }
    if (
      !Number.isInteger(options.turnTimeoutMs) ||
      options.turnTimeoutMs < 1 ||
      options.turnTimeoutMs > VOICE_MAX_TURN_TIMEOUT_MS
    ) {
      throw new Error(
        `Voice turn timeout must be an integer between 1 and ${VOICE_MAX_TURN_TIMEOUT_MS}.`,
      );
    }
  }

  createSession(runtimeConversationIdValue: unknown): VoiceSessionBinding & { grant: string } {
    this.expireIfNeeded();
    if (this.session) throw new VoiceSessionError("session_in_progress", 409);
    const runtimeConversationId = requireBoundedString(
      runtimeConversationIdValue,
      "runtimeConversationId",
      256,
    );
    const voiceSessionId = this.randomId();
    const grant = this.randomGrant();
    const expiresAtMs = this.now() + this.options.sessionLifetimeMs;
    const agentClient = this.options.createAgentClient();
    const binding: VoiceSessionBinding = {
      voiceSessionId,
      runtimeId: this.options.runtimeId,
      runtimeProfile: this.options.runtimeProfile,
      runtimeConversationId,
      sandbox: this.options.sandbox,
      agent: this.options.agent,
      agentSessionKey: `agent:${this.options.agent}:voice:${this.randomId()}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const expiryTimer = setTimeout(
      () => this.clearSession("session_expired"),
      this.options.sessionLifetimeMs,
    );
    expiryTimer.unref();
    this.session = {
      ...binding,
      grantHash: hashCredential(grant),
      expiresAtMs,
      expiryTimer,
      agentClient,
    };
    this.diagnostic({ event: "session.created", state: "active", voiceSessionId });
    return { ...binding, grant };
  }

  getBindingForTest(): VoiceSessionBinding | undefined {
    if (!this.session) return undefined;
    const {
      grantHash: _grantHash,
      expiresAtMs: _expiresAtMs,
      expiryTimer: _expiryTimer,
      agentClient: _agentClient,
      active: _active,
      acceptedCommitId: _acceptedCommitId,
      ...binding
    } = this.session;
    return binding;
  }

  authorize(voiceSessionId: string, grant: string): SessionRecord {
    this.expireIfNeeded();
    const session = this.session;
    if (!session || session.voiceSessionId !== voiceSessionId) {
      throw new VoiceSessionError("session_not_found", 404);
    }
    if (!equalCredential(grant, session.grantHash)) {
      throw new VoiceSessionError("invalid_grant", 401);
    }
    return session;
  }

  closeSession(voiceSessionId: string, grant: string): void {
    this.authorize(voiceSessionId, grant);
    this.clearSession("session_closed");
  }

  disconnectTurn(voiceSessionId: string, grant: string): void {
    let session: SessionRecord;
    try {
      session = this.authorize(voiceSessionId, grant);
    } catch {
      return;
    }
    if (!session.active) return;
    session.active.controller.abort();
    session.agentClient.close();
  }

  startTurn(
    voiceSessionId: string,
    grant: string,
    commitIdValue: unknown,
    textValue: unknown,
    deliver: (event: VoiceResponseEvent) => boolean,
  ): Promise<void> {
    const session = this.authorize(voiceSessionId, grant);
    const commitId = requireBoundedString(commitIdValue, "commitId", VOICE_MAX_COMMIT_ID_BYTES);
    const text = requireBoundedString(textValue, "text", VOICE_MAX_TURN_TEXT_BYTES);
    if (session.acceptedCommitId === commitId) {
      throw new VoiceSessionError("duplicate_turn", 409);
    }
    if (session.active) throw new VoiceSessionError("turn_in_progress", 409);
    if (session.acceptedCommitId) throw new VoiceSessionError("duplicate_turn", 409);

    session.acceptedCommitId = commitId;
    const turnId = this.randomId();
    const responseId = this.randomId();
    const controller = new AbortController();
    session.active = {
      turnId,
      responseId,
      startedAt: this.now(),
      controller,
      timedOut: false,
    };
    return Promise.resolve().then(() => this.runTurn(session, text, deliver));
  }

  private async runTurn(
    session: SessionRecord,
    text: string,
    deliver: (event: VoiceResponseEvent) => boolean,
  ): Promise<void> {
    const active = session.active;
    if (!active) return;
    let sequence = 0;
    let terminal = false;
    let responseBytes = 0;
    let deliveryOpen = deliver({
      type: "response.started",
      sequence: ++sequence,
      voiceSessionId: session.voiceSessionId,
      turnId: active.turnId,
      responseId: active.responseId,
    });
    this.diagnostic({
      event: "response.started",
      state: "running",
      voiceSessionId: session.voiceSessionId,
      turnId: active.turnId,
      responseId: active.responseId,
    });

    const emitTerminal = (reason?: VoiceFailureReason) => {
      if (terminal) return;
      terminal = true;
      if (deliveryOpen) {
        deliveryOpen = deliver(
          reason
            ? {
                type: "response.failed",
                sequence: ++sequence,
                voiceSessionId: session.voiceSessionId,
                turnId: active.turnId,
                responseId: active.responseId,
                reason,
              }
            : {
                type: "response.completed",
                sequence: ++sequence,
                voiceSessionId: session.voiceSessionId,
                turnId: active.turnId,
                responseId: active.responseId,
              },
        );
      }
      this.diagnostic({
        event: reason ? "response.failed" : "response.completed",
        state: reason ? "failed" : "completed",
        voiceSessionId: session.voiceSessionId,
        turnId: active.turnId,
        responseId: active.responseId,
        openClawRunId: active.runId,
        reason,
        durationMs: Math.max(0, this.now() - active.startedAt),
      });
    };

    const failureReason = (): VoiceFailureReason | undefined =>
      active.expiryReason ??
      (active.responseLimitExceeded
        ? "agent_response_limit"
        : active.timedOut
          ? "turn_timeout"
          : undefined);

    const timeout = setTimeout(() => {
      active.timedOut = true;
      active.controller.abort();
      session.agentClient.close();
    }, this.options.turnTimeoutMs);
    timeout.unref();

    try {
      await session.agentClient.invoke({
        agentSessionKey: session.agentSessionKey,
        idempotencyKey: hashCredential(active.turnId).toString("base64url"),
        text,
        signal: active.controller.signal,
        onRun: (runId) => {
          active.runId = runId;
        },
        onText: (delta) => {
          if (terminal || active.controller.signal.aborted || delta.length === 0) return;
          responseBytes += Buffer.byteLength(delta);
          if (responseBytes > VOICE_MAX_RESPONSE_TEXT_BYTES) {
            active.responseLimitExceeded = true;
            active.controller.abort();
            session.agentClient.close();
            return;
          }
          if (!deliveryOpen) return;
          deliveryOpen = deliver({
            type: "response.text.delta",
            sequence: ++sequence,
            voiceSessionId: session.voiceSessionId,
            turnId: active.turnId,
            responseId: active.responseId,
            text: delta,
          });
        },
      });
      emitTerminal(failureReason());
    } catch (error) {
      emitTerminal(
        failureReason() ?? (isVoiceFailureReason(error) ? error.reason : "agent_unavailable"),
      );
    } finally {
      clearTimeout(timeout);
      session.agentClient.close();
      if (session.active === active) session.active = undefined;
    }
  }

  private expireIfNeeded(): void {
    if (this.session && this.now() >= this.session.expiresAtMs) {
      this.clearSession("session_expired");
    }
  }

  private clearSession(reason: "session_closed" | "session_expired"): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    clearTimeout(session.expiryTimer);
    if (session.active) {
      session.active.expiryReason = reason;
      session.active.controller.abort();
    }
    session.agentClient.close();
    this.diagnostic({
      event: reason === "session_expired" ? "session.expired" : "session.closed",
      state: reason === "session_expired" ? "expired" : "closed",
      voiceSessionId: session.voiceSessionId,
      reason,
    });
  }
}

export class VoiceAgentError extends Error {
  constructor(
    readonly reason: Exclude<
      VoiceFailureReason,
      "session_closed" | "session_expired" | "turn_timeout"
    >,
  ) {
    super(reason);
  }
}

function isVoiceFailureReason(error: unknown): error is VoiceAgentError {
  return error instanceof VoiceAgentError;
}
