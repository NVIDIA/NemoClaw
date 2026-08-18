// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  type AgentTurnClient,
  VOICE_GATEWAY_MAX_RESPONSE_BYTES,
  VOICE_GATEWAY_SESSION_LIFETIME_MS,
  VOICE_GATEWAY_TURN_TIMEOUT_MS,
  type VoiceGatewayDiagnostic,
  type VoiceGatewayFailureReason,
  VoiceGatewayRequestError,
  type VoiceResponseEvent,
} from "./contracts";

const RUNTIME_VALUE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u;
const MAX_TURN_TEXT_BYTES = 48 * 1024;

interface ActiveSession {
  readonly voiceSessionId: string;
  readonly runtimeConversationId: string;
  readonly agentSessionKey: string;
  readonly grantHash: Buffer;
  readonly expiresAt: number;
  readonly client: AgentTurnClient;
  expiryTimer: NodeJS.Timeout;
  commitId: string | null;
  turnState: "idle" | "running" | "terminal";
  revokedReason: "session_closed" | "session_expired" | null;
}

export interface VoiceSessionServiceOptions {
  readonly runtimeIdentity: string;
  readonly runtimeProfile: string;
  readonly sandbox: string;
  readonly agent: string;
  readonly createClient: () => AgentTurnClient;
  readonly diagnostic?: (entry: VoiceGatewayDiagnostic) => void;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly randomGrant?: () => Buffer;
  readonly sessionLifetimeMs?: number;
  readonly turnTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface CreatedVoiceSession {
  readonly voiceSessionId: string;
  readonly grant: string;
  readonly expiresAt: string;
}

function validateRuntimeValue(value: string, label: string): void {
  if (!RUNTIME_VALUE_PATTERN.test(value)) {
    throw new VoiceGatewayRequestError("invalid_request");
  }
  if (label.length === 0) throw new VoiceGatewayRequestError("invalid_request");
}

function hashBearer(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function grantMatches(value: string, expectedHash: Buffer): boolean {
  return timingSafeEqual(hashBearer(value), expectedHash);
}

function deriveAgentSessionKey(
  options: Pick<
    VoiceSessionServiceOptions,
    "agent" | "runtimeIdentity" | "runtimeProfile" | "sandbox"
  >,
  runtimeConversationId: string,
): string {
  const binding = JSON.stringify([
    options.agent,
    options.runtimeProfile,
    options.runtimeIdentity,
    options.sandbox,
    runtimeConversationId,
  ]);
  const bindingHash = createHash("sha256")
    .update(binding)
    .digest("base64url")
    .toLowerCase();
  return `agent:${options.agent}:nemoclaw-voice:${bindingHash}`;
}

/** Owns one runtime-neutral voice session and its single committed turn. */
export class VoiceSessionService {
  private readonly options: Required<
    Pick<
      VoiceSessionServiceOptions,
      | "now"
      | "randomId"
      | "randomGrant"
      | "sessionLifetimeMs"
      | "turnTimeoutMs"
      | "maxResponseBytes"
    >
  > &
    Omit<
      VoiceSessionServiceOptions,
      | "now"
      | "randomId"
      | "randomGrant"
      | "sessionLifetimeMs"
      | "turnTimeoutMs"
      | "maxResponseBytes"
    >;
  private session: ActiveSession | null = null;

  constructor(options: VoiceSessionServiceOptions) {
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      randomId: options.randomId ?? randomUUID,
      randomGrant: options.randomGrant ?? (() => randomBytes(32)),
      sessionLifetimeMs: options.sessionLifetimeMs ?? VOICE_GATEWAY_SESSION_LIFETIME_MS,
      turnTimeoutMs: options.turnTimeoutMs ?? VOICE_GATEWAY_TURN_TIMEOUT_MS,
      maxResponseBytes: options.maxResponseBytes ?? VOICE_GATEWAY_MAX_RESPONSE_BYTES,
    };
    validateRuntimeValue(options.runtimeIdentity, "runtime identity");
    validateRuntimeValue(options.runtimeProfile, "runtime profile");
    validateRuntimeValue(options.sandbox, "sandbox");
    validateRuntimeValue(options.agent, "agent");
  }

  createSession(runtimeConversationId: string): CreatedVoiceSession {
    validateRuntimeValue(runtimeConversationId, "runtime conversation ID");
    this.expireIfNeeded();
    if (this.session !== null) throw new VoiceGatewayRequestError("session_in_progress");

    const now = this.options.now();
    const voiceSessionId = this.options.randomId();
    const agentSessionKey = deriveAgentSessionKey(this.options, runtimeConversationId);
    const grant = this.options.randomGrant().toString("base64url");
    const expiresAt = now + this.options.sessionLifetimeMs;
    const session: ActiveSession = {
      voiceSessionId,
      runtimeConversationId,
      agentSessionKey,
      grantHash: hashBearer(grant),
      expiresAt,
      client: this.options.createClient(),
      expiryTimer: setTimeout(
        () => this.revoke(session, "session_expired"),
        this.options.sessionLifetimeMs,
      ),
      commitId: null,
      turnState: "idle",
      revokedReason: null,
    };
    session.expiryTimer.unref?.();
    this.session = session;
    this.options.diagnostic?.({
      event: "voice_session",
      state: "created",
      runtimeIdentity: this.options.runtimeIdentity,
      runtimeProfile: this.options.runtimeProfile,
      sandbox: this.options.sandbox,
      agent: this.options.agent,
      voiceSessionId,
      runtimeConversationId,
    });
    return { voiceSessionId, grant, expiresAt: new Date(expiresAt).toISOString() };
  }

  async commitTurn(options: {
    readonly voiceSessionId: string;
    readonly grant: string;
    readonly commitId: string;
    readonly text: string;
    readonly deliver: (event: VoiceResponseEvent) => void;
    readonly deliveryOpen: () => boolean;
  }): Promise<void> {
    const session = this.authorize(options.voiceSessionId, options.grant);
    validateRuntimeValue(options.commitId, "commit ID");
    if (
      options.text.length === 0 ||
      Buffer.byteLength(options.text) > MAX_TURN_TEXT_BYTES ||
      options.text.includes("\u0000")
    ) {
      throw new VoiceGatewayRequestError("invalid_request");
    }
    if (session.commitId === options.commitId) {
      throw new VoiceGatewayRequestError("duplicate_turn");
    }
    if (session.turnState === "running") throw new VoiceGatewayRequestError("turn_in_progress");
    if (session.turnState === "terminal") throw new VoiceGatewayRequestError("turn_limit_reached");

    session.commitId = options.commitId;
    session.turnState = "running";
    const turnId = this.options.randomId();
    const responseId = this.options.randomId();
    const startedAt = this.options.now();
    let sequence = 0;
    let responseBytes = 0;
    let forcedReason: VoiceGatewayFailureReason | null = null;
    let terminalSent = false;
    let startedSent = false;

    const deliver = (event: VoiceResponseEvent) => {
      if (!options.deliveryOpen()) return;
      options.deliver(event);
    };
    const finish = (reason: VoiceGatewayFailureReason | null) => {
      if (terminalSent) return;
      terminalSent = true;
      session.turnState = "terminal";
      if (reason) {
        deliver({
          type: "response.failed",
          voiceSessionId: session.voiceSessionId,
          turnId,
          responseId,
          reason,
        });
      } else {
        deliver({
          type: "response.completed",
          voiceSessionId: session.voiceSessionId,
          turnId,
          responseId,
        });
      }
      this.options.diagnostic?.({
        event: "voice_turn",
        state: reason ? "failed" : "completed",
        runtimeProfile: this.options.runtimeProfile,
        runtimeIdentity: this.options.runtimeIdentity,
        sandbox: this.options.sandbox,
        agent: this.options.agent,
        voiceSessionId: session.voiceSessionId,
        runtimeConversationId: session.runtimeConversationId,
        turnId,
        responseId,
        ...(reason ? { reason } : {}),
        durationMs: Math.max(0, this.options.now() - startedAt),
      });
    };

    let timeout: NodeJS.Timeout | undefined;
    const timeoutResult = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), this.options.turnTimeoutMs);
      timeout.unref?.();
    });
    const runResult = Promise.resolve()
      .then(() =>
        session.client.runTurn({
          sessionKey: session.agentSessionKey,
          idempotencyKey: turnId,
          message: options.text,
          onEvent: (event) => {
            if (terminalSent || forcedReason) return;
            if (event.type === "started") {
              if (startedSent) {
                forcedReason = "agent_protocol_error";
                session.client.close();
                return;
              }
              startedSent = true;
              deliver({
                type: "response.started",
                voiceSessionId: session.voiceSessionId,
                turnId,
                responseId,
              });
              return;
            }
            if (!startedSent) {
              forcedReason = "agent_protocol_error";
              session.client.close();
              return;
            }
            responseBytes += Buffer.byteLength(event.text);
            if (responseBytes > this.options.maxResponseBytes) {
              forcedReason = "response_too_large";
              session.client.close();
              return;
            }
            deliver({
              type: "response.text.delta",
              voiceSessionId: session.voiceSessionId,
              turnId,
              responseId,
              sequence: sequence++,
              text: event.text,
            });
          },
        }),
      )
      .catch(
        (): Awaited<ReturnType<AgentTurnClient["runTurn"]>> => ({
          outcome: "failed",
          reason: "agent_gateway_unavailable",
        }),
      );

    const result = await Promise.race([runResult, timeoutResult]);
    if (timeout) clearTimeout(timeout);
    if (result === "timeout") {
      session.client.close();
      finish(session.revokedReason ?? "turn_timeout");
    } else if (forcedReason) {
      finish(forcedReason);
    } else if (session.revokedReason) {
      finish(session.revokedReason);
    } else if (result.outcome === "failed") {
      finish(result.reason);
    } else {
      finish(null);
    }
  }

  closeSession(voiceSessionId: string, grant: string): void {
    const session = this.authorize(voiceSessionId, grant);
    this.revoke(session, "session_closed");
  }

  closeAll(): void {
    if (this.session) this.revoke(this.session, "session_closed");
  }

  authorizeSession(voiceSessionId: string, grant: string): void {
    this.authorize(voiceSessionId, grant);
  }

  private authorize(voiceSessionId: string, grant: string): ActiveSession {
    this.expireIfNeeded();
    const session = this.session;
    if (!session || session.voiceSessionId !== voiceSessionId) {
      throw new VoiceGatewayRequestError("session_not_found");
    }
    if (!grantMatches(grant, session.grantHash)) {
      throw new VoiceGatewayRequestError("authentication_failed");
    }
    return session;
  }

  private expireIfNeeded(): void {
    if (this.session && this.options.now() >= this.session.expiresAt) {
      this.revoke(this.session, "session_expired");
    }
  }

  private revoke(session: ActiveSession, reason: "session_closed" | "session_expired"): void {
    if (session.revokedReason) return;
    session.revokedReason = reason;
    clearTimeout(session.expiryTimer);
    session.client.close();
    session.grantHash.fill(0);
    if (this.session === session) this.session = null;
    this.options.diagnostic?.({
      event: "voice_session",
      state: reason === "session_expired" ? "expired" : "closed",
      runtimeIdentity: this.options.runtimeIdentity,
      runtimeProfile: this.options.runtimeProfile,
      sandbox: this.options.sandbox,
      agent: this.options.agent,
      voiceSessionId: session.voiceSessionId,
      runtimeConversationId: session.runtimeConversationId,
      reason,
    });
  }
}
