// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const SANDBOX_OPENCLAW_STATE_DIR = "/sandbox/.openclaw";

export function agentSessionsDir(agentId: string): string {
  return `${SANDBOX_OPENCLAW_STATE_DIR}/agents/${agentId}/sessions`;
}

export function agentSessionsStorePath(agentId: string): string {
  return `${agentSessionsDir(agentId)}/sessions.json`;
}

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateAgentId(agentId: string): string {
  const trimmed = agentId.trim();
  if (!AGENT_ID_RE.test(trimmed)) {
    throw new Error(
      `Invalid agent id '${agentId}'. Allowed characters: letters, digits, '.', '_', '-' (max 64).`,
    );
  }
  return trimmed;
}

const SESSION_KEY_RE = /^[\x20-\x7E]{1,256}$/;
const SESSION_KEY_REJECT = /["'`$\\\n\r\t]/;

export function validateSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (!trimmed || !SESSION_KEY_RE.test(trimmed) || SESSION_KEY_REJECT.test(trimmed)) {
    throw new Error(
      `Invalid session key '${sessionKey}'. Must be a printable ASCII string without quotes, backticks, '$', backslash, or whitespace control characters.`,
    );
  }
  return trimmed;
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateSessionId(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `Refusing to operate on session id '${sessionId}'. Expected an alphanumeric identifier (with '.', '_', '-').`,
    );
  }
  return sessionId;
}
