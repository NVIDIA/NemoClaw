// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createOpenClawBridgeHealthHookRegistration,
  type OpenClawBridgeHealthHookOptions,
  type OpenClawBridgeHealthStartupContext,
} from "../../openclaw-bridge-health";

export type { OpenClawBridgeHealthHookOptions } from "../../openclaw-bridge-health";

export const TELEGRAM_OPENCLAW_BRIDGE_HEALTH_HOOK_HANDLER_ID = "telegram.openclawBridgeHealth";

export function createTelegramOpenClawBridgeHealthHookRegistration(
  options: OpenClawBridgeHealthHookOptions = {},
) {
  return createOpenClawBridgeHealthHookRegistration(
    {
      channelId: "telegram",
      handlerId: TELEGRAM_OPENCLAW_BRIDGE_HEALTH_HOOK_HANDLER_ID,
      onStartupDetected: printTelegramDirectMessageAllowlistWarning,
    },
    options,
  );
}

function printTelegramDirectMessageAllowlistWarning({
  channelBlock,
  log,
}: OpenClawBridgeHealthStartupContext): void {
  const accountContainer = getObjectPath(channelBlock, "accounts");
  if (!isObjectRecord(accountContainer)) return;
  const account = isObjectRecord(accountContainer.default)
    ? accountContainer.default
    : getFirstObjectValue(accountContainer);
  const allowFrom = getObjectPath(account, "allowFrom");
  const allowedCount = Array.isArray(allowFrom) ? allowFrom.length : 0;
  if (getObjectPath(account, "dmPolicy") !== "allowlist" || allowedCount > 0) return;

  log("  ⚠ Telegram direct-message allowlist is empty in baked openclaw.json.");
  log(
    "    Set TELEGRAM_ALLOWED_IDS before rebuild, or complete OpenClaw pairing before expecting DM replies.",
  );
  log(
    "    Telegram Bot API sendMessage tests outbound delivery only; send from a Telegram client to test inbound agent replies.",
  );
}

function getFirstObjectValue(value: Record<string, unknown>): Record<string, unknown> | null {
  for (const entry of Object.values(value)) {
    if (isObjectRecord(entry)) return entry;
  }
  return null;
}

function getObjectPath(value: unknown, dottedPath: string): unknown {
  let current = value;
  for (const segment of dottedPath.split(".").filter(Boolean)) {
    if (!isObjectRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
