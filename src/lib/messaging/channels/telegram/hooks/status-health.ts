// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `telegram.statusHealth` — a `phase: "status"` hook that probes the live
 * Telegram bridge health from inside the sandbox and emits a
 * `messaging-channel-health` status output. Run by the generic channels-status
 * command via the status-hook runner, so no telegram-specific code lives in the
 * generic status orchestrator.
 *
 * The bridge is an in-process poller inside the OpenClaw gateway, so there is no
 * separate process or heartbeat file (unlike WhatsApp). The probe tails the
 * gateway log for the `[telegram] …` breadcrumbs the runtime preload writes,
 * plus a pgrep for the gateway process. It never runs its own getMe: verified
 * live, the egress MITM proxy refuses a raw `curl` at CONNECT (HTTP 403) and
 * authorizes only the gateway's instrumented Node egress, so reading the
 * gateway's own logged outcome is the sanctioned path.
 */

import { shellQuote as quotePath } from "../../../../core/shell-quote";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  type ChannelStatusHealthHookOptions,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channel-health";
import {
  evaluateTelegramDiagnostics,
  parseTelegramBreadcrumbs,
  type TelegramProbeInput,
} from "./status-health-eval";

export const TELEGRAM_STATUS_HEALTH_HOOK_HANDLER_ID = "telegram.statusHealth";

const DEFAULT_TIMEOUT_MS = 8_000;
const TG_SHELL_OK = "NEMOCLAW_TG_DIAG_OK";
const TG_LOG_BEGIN = "NEMOCLAW_TG_LOG_BEGIN";
const TG_LOG_END = "NEMOCLAW_TG_LOG_END";
const TG_PROC_DONE = "NEMOCLAW_TG_PROC_DONE";
const OPENCLAW_GATEWAY_LOG_FILE = "/tmp/gateway.log";

/** Telegram uses the generic channel-health hook options unchanged. */
export type TelegramStatusHealthHookOptions = ChannelStatusHealthHookOptions;

export function createTelegramStatusHealthHook(
  options: TelegramStatusHealthHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "telegram") return {};
    const execute = options.executeSandboxCommand;
    const sandboxName = normalizeString(context.inputs?.currentSandbox);
    // Without a sandbox target or an exec runner there is nothing to probe (e.g.
    // the top-level status runner does not thread an exec runner into this hook).
    if (!execute || !sandboxName) return {};

    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const exec = execute(sandboxName, buildTelegramProbeScript(), timeoutMs);
    const lines = String(exec?.stdout ?? "").split(/\r?\n/);
    // A non-zero exec (timeout/kill/unhealthy sandbox) can still carry partial
    // stdout with a stale `provider ready` line; require a clean exit so a failed
    // probe classifies as probe_failed rather than a false healthy.
    const reachable = exec?.status === 0 && lines.includes(TG_SHELL_OK);

    const logStart = lines.indexOf(TG_LOG_BEGIN);
    const logEnd = lines.indexOf(TG_LOG_END);
    const logLines =
      logStart !== -1 && logEnd > logStart
        ? lines
            .slice(logStart + 1, logEnd)
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
    const breadcrumbs = reachable ? parseTelegramBreadcrumbs(logLines) : null;

    const sawProc = lines.some((line) => line.startsWith("PROC "));
    const sawProcDone = lines.includes(TG_PROC_DONE);
    const gatewayProcessAlive = sawProc ? true : sawProcDone ? false : null;

    const input: TelegramProbeInput = {
      agent: normalizeString(context.inputs?.agent) ?? "openclaw",
      probeReachable: reachable,
      gatewayProcessAlive,
      breadcrumbs,
      probedAt: normalizeString(context.inputs?.probedAt) ?? "",
      presetInRegistry: Boolean(context.inputs?.presetInRegistry),
      presetOnGateway: normalizeTristate(context.inputs?.presetOnGateway),
      channelEnabledInRegistry: Boolean(context.inputs?.channelEnabledInRegistry),
    };

    const report = evaluateTelegramDiagnostics(input);
    return {
      outputs: {
        channelHealth: {
          kind: "status",
          value: {
            type: MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
            report,
          } as unknown as MessagingSerializableValue,
        },
      },
    };
  };
}

export function createTelegramStatusHealthHookRegistration(
  options: TelegramStatusHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: TELEGRAM_STATUS_HEALTH_HOOK_HANDLER_ID,
    handler: createTelegramStatusHealthHook(options),
  };
}

function buildTelegramProbeScript(): string {
  return [
    `set +e`,
    `printf '%s\\n' ${quotePath(TG_SHELL_OK)}`,
    `printf '%s\\n' ${quotePath(TG_LOG_BEGIN)}`,
    // Match `[telegram]` anywhere on the line: the diagnostics preload writes
    // non-timestamped `[telegram] [default] …` lines, while OpenClaw's own
    // gateway logs carry a leading timestamp before `[telegram] …` (these hold
    // the native network-failure evidence the evaluator classifies).
    `tail -n 400 ${quotePath(OPENCLAW_GATEWAY_LOG_FILE)} 2>/dev/null | grep -aE '\\[telegram\\]' | tail -n 40`,
    `printf '%s\\n' ${quotePath(TG_LOG_END)}`,
    `__nemoclaw_tg_self_pid=$$`,
    `pgrep -fa 'openclaw|openclaw-gateway|node .*gateway' 2>/dev/null | awk -v self="$__nemoclaw_tg_self_pid" '$1 != self && $0 !~ /pgrep -fa/ { print "PROC " $0 }' | head -n 5`,
    `printf '%s\\n' ${quotePath(TG_PROC_DONE)}`,
  ].join("\n");
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTristate(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}
