// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const VOICE_GATEWAY_FEATURE_ENV = "NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY";
export const VOICE_GATEWAY_LISTEN_ADDRESS = "127.0.0.1";
export const DEFAULT_VOICE_GATEWAY_LISTEN_PORT = 18_800;
export const VOICE_GATEWAY_SESSION_LIFETIME_MS = 5 * 60_000;
export const VOICE_GATEWAY_TURN_TIMEOUT_MS = 2 * 60_000;
export const VOICE_GATEWAY_MAX_REQUEST_BYTES = 64 * 1024;
export const VOICE_GATEWAY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type VoiceGatewayFailureReason =
  | "agent_failed"
  | "agent_gateway_unavailable"
  | "agent_protocol_error"
  | "response_too_large"
  | "session_closed"
  | "session_expired"
  | "turn_timeout";

export type VoiceResponseEvent =
  | {
      readonly type: "response.started";
      readonly voiceSessionId: string;
      readonly turnId: string;
      readonly responseId: string;
    }
  | {
      readonly type: "response.text.delta";
      readonly voiceSessionId: string;
      readonly turnId: string;
      readonly responseId: string;
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: "response.completed";
      readonly voiceSessionId: string;
      readonly turnId: string;
      readonly responseId: string;
    }
  | {
      readonly type: "response.failed";
      readonly voiceSessionId: string;
      readonly turnId: string;
      readonly responseId: string;
      readonly reason: VoiceGatewayFailureReason;
    };

export type AgentTurnEvent =
  | { readonly type: "started" }
  | { readonly type: "text"; readonly text: string };

export interface AgentTurnClient {
  runTurn(options: {
    readonly idempotencyKey: string;
    readonly message: string;
    readonly onEvent: (event: AgentTurnEvent) => void;
    readonly sessionKey: string;
  }): Promise<
    | { readonly outcome: "completed" }
    | {
        readonly outcome: "failed";
        readonly reason: "agent_failed" | "agent_gateway_unavailable" | "agent_protocol_error";
      }
  >;
  close(): void;
}

export interface VoiceGatewayDiagnostic {
  readonly event: string;
  readonly state: string;
  readonly runtimeIdentity?: string;
  readonly runtimeProfile?: string;
  readonly sandbox?: string;
  readonly agent?: string;
  readonly voiceSessionId?: string;
  readonly runtimeConversationId?: string;
  readonly turnId?: string;
  readonly responseId?: string;
  readonly reason?: VoiceGatewayFailureReason | string;
  readonly durationMs?: number;
}

export class VoiceGatewayRequestError extends Error {
  constructor(
    readonly code:
      | "authentication_failed"
      | "duplicate_turn"
      | "invalid_request"
      | "session_expired"
      | "session_in_progress"
      | "session_not_found"
      | "turn_in_progress"
      | "turn_limit_reached",
  ) {
    super(code);
  }
}
