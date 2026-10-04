// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";

export const TELEGRAM_GATEWAY_CONFLICT_STATUS_HOOK_HANDLER_ID = "telegram.gatewayConflictStatus";

const GATEWAY_LOG_FILE = "/tmp/gateway.log";
const DEFAULT_LOG_LINES = 200;
const DEFAULT_TIMEOUT_MS = 3000;
const TELEGRAM_CONFLICT_PATTERN = /getUpdates conflict|409\s*:?\s*Conflict/i;

export interface TelegramGatewayConflictStatusCommandResult {
  readonly status?: number | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

export type TelegramGatewayConflictStatusCommandRunner = (
  sandboxName: string,
  command: string,
  timeoutMs: number,
) => TelegramGatewayConflictStatusCommandResult | null | undefined;

export interface TelegramGatewayConflictStatusHookOptions {
  readonly sandboxName?: string | null | (() => string | null);
  readonly executeSandboxCommand?: TelegramGatewayConflictStatusCommandRunner;
  readonly maxLogLines?: number;
  readonly timeoutMs?: number;
}

export function createTelegramGatewayConflictStatusHook(
  options: TelegramGatewayConflictStatusHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "telegram") return {};
    const sandboxName = resolveSandboxName(context.inputs?.currentSandbox, options.sandboxName);
    const execute = options.executeSandboxCommand;
    if (!sandboxName || !execute) return {};

    const maxLogLines = normalizeLogLines(options.maxLogLines);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const command = `tail -n ${maxLogLines} ${GATEWAY_LOG_FILE} 2>/dev/null || true`;
    const result = execute(sandboxName, command, timeoutMs);
    if (!result) return {};

    const conflicts = countTelegramConflictLines(String(result.stdout ?? ""));
    if (conflicts === 0) return {};

    return {
      outputs: {
        bridgeHealth: {
          kind: "status",
          value: {
            type: "messaging-bridge-health",
            channel: "telegram",
            conflicts,
            logFile: GATEWAY_LOG_FILE,
          },
        },
      },
    };
  };
}

export function createTelegramGatewayConflictStatusHookRegistration(
  options: TelegramGatewayConflictStatusHookOptions = {},
): MessagingHookRegistration {
  return {
    id: TELEGRAM_GATEWAY_CONFLICT_STATUS_HOOK_HANDLER_ID,
    handler: createTelegramGatewayConflictStatusHook(options),
  };
}

export function countTelegramConflictLines(logTail: string): number {
  return logTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && TELEGRAM_CONFLICT_PATTERN.test(line)).length;
}

function resolveSandboxName(
  inputValue: unknown,
  optionValue: string | null | (() => string | null) | undefined,
): string | null {
  const input = normalizeString(inputValue);
  if (input) return input;
  const resolved = typeof optionValue === "function" ? optionValue() : optionValue;
  return normalizeString(resolved);
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLogLines(value: unknown): number {
  return normalizePositiveInteger(value, DEFAULT_LOG_LINES, 2000);
}

function normalizeTimeoutMs(value: unknown): number {
  return normalizePositiveInteger(value, DEFAULT_TIMEOUT_MS, 30000);
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}
