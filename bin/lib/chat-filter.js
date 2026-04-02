// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse and filter Telegram chat IDs from the ALLOWED_CHAT_IDS env var.
 *
 * @param {string} [raw] - Comma-separated chat IDs (undefined = allow all)
 * @returns {string[] | null} Array of allowed chat IDs, or null to allow all
 */
function parseAllowedChatIds(raw) {
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check whether a chat ID is allowed by the parsed allowlist.
 *
 * @param {string[] | null} allowedChats - Output of parseAllowedChatIds
 * @param {string} chatId - The chat ID to check
 * @returns {boolean}
 */
function isChatAllowed(allowedChats, chatId) {
  return !allowedChats || allowedChats.includes(chatId);
}

module.exports = { parseAllowedChatIds, isChatAllowed };
