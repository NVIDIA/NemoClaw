// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenClawBridgeHealthCommandRunner,
  OpenClawBridgeHealthHookOptions,
} from "../../openclaw-bridge-health";
import { cliName } from "../../../../onboard/branding";
import { DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS } from "../../channel-health";
import type { MessagingHookRegistration } from "../../../hooks/types";

export type { OpenClawBridgeHealthHookOptions } from "../../openclaw-bridge-health";

export const DISCORD_OPENCLAW_BRIDGE_HEALTH_HOOK_HANDLER_ID = "discord.openclawBridgeHealth";

export type OpenClawDiscordConnectionState =
  | "connected"
  | "account_disabled"
  | "auth_failed"
  | "blocked"
  | "inactive"
  | "unknown";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the managed default account's connection state, independently of REST token probes. */
export async function probeOpenClawDiscordConnection(
  execute: OpenClawBridgeHealthCommandRunner,
  timeoutMs = DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS,
): Promise<OpenClawDiscordConnectionState> {
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS)
      : DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS;
  try {
    const result = await execute(
      `openclaw channels status --channel discord --probe --json --timeout ${timeout}`,
      timeout,
    );
    if (
      result?.status !== 0 ||
      typeof result.stdout !== "string" ||
      result.stdout.length > 65_536
    ) {
      return "unknown";
    }
    const payload: unknown = JSON.parse(result.stdout);
    if (
      !isObjectRecord(payload) ||
      ("gatewayReachable" in payload && payload.gatewayReachable !== true)
    ) {
      return "unknown";
    }
    const accounts = isObjectRecord(payload.channelAccounts)
      ? payload.channelAccounts.discord
      : undefined;
    const account = Array.isArray(accounts)
      ? accounts.find((entry: unknown) => isObjectRecord(entry) && entry.accountId === "default")
      : undefined;
    if (!isObjectRecord(account)) return "unknown";
    if (account.enabled === false) return "account_disabled";
    if (isObjectRecord(account.probe) && account.probe.status === 401) return "auth_failed";
    if (account.lifecycle === "blocked" || account.terminalDisconnect === true) return "blocked";
    if (
      account.enabled !== true ||
      account.configured !== true ||
      typeof account.running !== "boolean" ||
      typeof account.connected !== "boolean"
    ) {
      return "unknown";
    }
    return account.running &&
      account.connected &&
      (account.lifecycle === undefined || account.lifecycle === "ready")
      ? "connected"
      : "inactive";
  } catch {
    // Native errors and malformed output can contain credentials; return only a fixed state.
    return "unknown";
  }
}

export function createDiscordOpenClawBridgeHealthHookRegistration(
  options: OpenClawBridgeHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: DISCORD_OPENCLAW_BRIDGE_HEALTH_HOOK_HANDLER_ID,
    handler: async () => {
      const execute = options.executeSandboxCommand;
      if (!execute) throw new Error("OpenClaw bridge health check requires executeSandboxCommand.");
      const log = options.log ?? console.log;
      const state = await probeOpenClawDiscordConnection(execute);
      if (state === "connected") {
        log("  ✓ OpenClaw reports a connected Discord gateway.");
        return {};
      }
      const detail =
        state === "account_disabled"
          ? "The managed Discord account is disabled."
          : state === "auth_failed"
            ? "Discord rejected the bot token."
            : state === "blocked"
              ? "OpenClaw reports a blocked Discord gateway."
              : state === "inactive"
                ? "The Discord gateway is not connected yet; it may still be starting."
                : "The Discord gateway connection is not verified yet.";
      log(`  ${state === "inactive" || state === "unknown" ? "ℹ" : "⚠"} ${detail}`);
      log(
        `    Run '${cliName()} ${options.sandboxName?.trim() || "<sandbox-name>"} channels status --channel discord --wait' for details.`,
      );
      return {};
    },
  };
}
