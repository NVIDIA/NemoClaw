// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateSessionId } from "./paths";

export interface SessionStoreEntry {
  sessionId: string;
  [field: string]: unknown;
}

export type SessionStore = Record<string, SessionStoreEntry>;

const VALID_KEY_RE = /^[\x20-\x7E]+$/;

export function parseSessionStore(text: string): SessionStore {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Failed to parse session store JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Session store JSON must be an object map of sessionKey -> entry.");
  }
  const result: SessionStore = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!VALID_KEY_RE.test(key)) continue;
    if (!value || typeof value !== "object") continue;
    const sessionId = (value as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    result[key] = { ...(value as Record<string, unknown>), sessionId };
  }
  return result;
}

export function resolveSessionIdForKey(store: SessionStore, sessionKey: string): string {
  const entry = store[sessionKey];
  if (!entry) {
    const knownKeys = Object.keys(store).slice(0, 10);
    const suffix =
      knownKeys.length > 0
        ? ` Known keys (first ${knownKeys.length}): ${knownKeys.join(", ")}.`
        : "";
    throw new Error(`Session key '${sessionKey}' not found in sessions store.${suffix}`);
  }
  return validateSessionId(entry.sessionId);
}
