// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side probe that collects live evidence for the Telegram channel health
 * diagnostic. Kept out of the generic `channel-status.ts` orchestrator so the
 * generic file only dispatches; the pure classification lives in
 * `sandbox/telegram-diagnostics.ts`.
 *
 * Telegram's bridge is an in-process poller inside the OpenClaw gateway, so
 * there is no separate process or heartbeat file to inspect (unlike WhatsApp).
 * The probe tails the gateway log for the `[telegram] …` breadcrumbs the
 * runtime preload writes, plus a pgrep for the gateway process. It never runs
 * its own getMe — the resolved token lives only in the gateway env, so reading
 * the gateway's own logged outcome keeps the credential boundary intact.
 */

import type { AgentDefinition } from "../../agent/defs";
import { shellQuote as quotePath } from "../../core/shell-quote";
import {
  parseTelegramBreadcrumbs,
  type TelegramProbeInput,
} from "../../sandbox/telegram-diagnostics";
import * as registry from "../../state/registry";

const TELEGRAM_PROBE_TIMEOUT_MS = 8_000;
const TG_SHELL_OK = "NEMOCLAW_TG_DIAG_OK";
const TG_LOG_BEGIN = "NEMOCLAW_TG_LOG_BEGIN";
const TG_LOG_END = "NEMOCLAW_TG_LOG_END";
const TG_PROC_DONE = "NEMOCLAW_TG_PROC_DONE";
const OPENCLAW_GATEWAY_LOG_FILE = "/tmp/gateway.log";

/** Minimal orchestrator dependencies the probe needs; `channel-status.ts`
 * passes its own `Required<StatusDeps>`, which is structurally compatible. */
export interface TelegramProbeDeps {
  now: () => Date;
  execSandbox: (
    sandboxName: string,
    command: string,
    timeoutMs?: number,
  ) => { status: number; stdout: string; stderr: string } | null;
  getSandbox: typeof registry.getSandbox;
  getAppliedPresets: (sandboxName: string) => string[];
  getGatewayPresets: (sandboxName: string) => string[] | null;
}

function buildTelegramProbeScript(): string {
  return [
    `set +e`,
    `printf '%s\\n' ${quotePath(TG_SHELL_OK)}`,
    `printf '%s\\n' ${quotePath(TG_LOG_BEGIN)}`,
    `tail -n 400 ${quotePath(OPENCLAW_GATEWAY_LOG_FILE)} 2>/dev/null | grep -aE '^\\[telegram\\] ' | tail -n 40`,
    `printf '%s\\n' ${quotePath(TG_LOG_END)}`,
    `__nemoclaw_tg_self_pid=$$`,
    `pgrep -fa 'openclaw|openclaw-gateway|node .*gateway' 2>/dev/null | awk -v self="$__nemoclaw_tg_self_pid" '$1 != self && $0 !~ /pgrep -fa/ { print "PROC " $0 }' | head -n 5`,
    `printf '%s\\n' ${quotePath(TG_PROC_DONE)}`,
  ].join("\n");
}

export function buildTelegramProbeInput(
  sandboxName: string,
  agent: AgentDefinition,
  deps: TelegramProbeDeps,
): TelegramProbeInput {
  const probedAt = deps.now().toISOString();
  const exec = deps.execSandbox(sandboxName, buildTelegramProbeScript(), TELEGRAM_PROBE_TIMEOUT_MS);
  const lines = (exec?.stdout ?? "").split(/\r?\n/);
  const reachable = lines.includes(TG_SHELL_OK);

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

  const entry = deps.getSandbox(sandboxName);
  const channelEnabledInRegistry = registry
    .getConfiguredMessagingChannelsFromEntry(entry)
    .includes("telegram");
  const presetInRegistry = deps.getAppliedPresets(sandboxName).includes("telegram");
  let presetOnGateway: boolean | null = null;
  try {
    const gatewayPresets = deps.getGatewayPresets(sandboxName);
    presetOnGateway = gatewayPresets === null ? null : gatewayPresets.includes("telegram");
  } catch {
    presetOnGateway = null;
  }

  return {
    agent: agent.name,
    probeReachable: reachable,
    gatewayProcessAlive,
    breadcrumbs,
    probedAt,
    presetInRegistry,
    presetOnGateway,
    channelEnabledInRegistry,
  };
}
