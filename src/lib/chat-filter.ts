// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse a comma-separated list of allowed chat IDs.
 * Returns null if the input is empty or undefined (meaning: accept all).
 */
export function parseAllowedChatIds(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

/**
 * Check whether a chat ID is allowed by the parsed allowlist.
 *
 * When `allowedChats` is null every chat is accepted (open mode).
 */
export function isChatAllowed(allowedChats: string[] | null, chatId: string): boolean {
  return !allowedChats || allowedChats.includes(chatId);
}
