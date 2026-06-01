// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

const AGENT_SESSION_KEY_RE = /^agent:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):/;

export function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const match = AGENT_SESSION_KEY_RE.exec(sessionKey);
  return match ? match[1] : null;
}

export const DEFAULT_AGENT_ID = "main";

export function buildCanonicalSessionKey(agentId: string, sessionKey: string): string {
  const agent = validateAgentId(agentId);
  const key = validateSessionKey(sessionKey);
  if (key.startsWith("agent:")) return key;
  return `agent:${agent}:${key}`;
}
