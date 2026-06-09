// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ChannelAccount = {
  dmPolicy?: unknown;
  allowFrom?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function getDefaultChannelAccount(channelBlock: unknown): ChannelAccount | null {
  if (!isRecord(channelBlock) || !isRecord(channelBlock.accounts)) return null;
  const accounts = channelBlock.accounts;
  if (isRecord(accounts.default)) return accounts.default;
  const firstKey = Object.keys(accounts)[0];
  const firstAccount = firstKey ? accounts[firstKey] : null;
  return isRecord(firstAccount) ? firstAccount : null;
}

export function printTelegramDirectMessageAllowlistWarning(
  channelBlock: unknown,
  log: (message: string) => void = console.log,
  warningMarker = "!",
): boolean {
  const account = getDefaultChannelAccount(channelBlock);
  const allowFrom = Array.isArray(account?.allowFrom) ? account.allowFrom : [];
  if (account?.dmPolicy !== "allowlist" || allowFrom.length > 0) return false;

  log(`  ${warningMarker} Telegram direct-message allowlist is empty in baked openclaw.json.`);
  log(
    "    Set TELEGRAM_ALLOWED_IDS before rebuild, or complete OpenClaw pairing before expecting DM replies.",
  );
  log(
    "    Telegram Bot API sendMessage tests outbound delivery only; send from a Telegram client to test inbound agent replies.",
  );
  return true;
}
