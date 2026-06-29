// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway recovery/restart shell generation. Kept separate from runtime.ts so
// agent lookup and display metadata do not grow around security-sensitive
// process-control scripts.

import { DASHBOARD_PORT } from "../core/ports";
import { shellQuote } from "../runner";
import { type AgentDefinition, isTerminalAgent } from "./defs";
import { GATEWAY_RESTART_MARKERS as MARKERS } from "./gateway-restart-markers";
import {
  buildGatewayGuardRecoveryLines,
  buildGatewayLogSelection,
  buildGatewayLogSetup,
  gatewayGuardRefusalCommand,
  gatewayLaunchCommand,
} from "./gateway-script-shared";

export const TERMINAL_AGENT_RECOVERY_SCRIPT = Object.freeze({ kind: "terminal" } as const);

export type AgentRecoveryScript = string | typeof TERMINAL_AGENT_RECOVERY_SCRIPT | null;

export function isTerminalAgentRecoveryScript(
  script: AgentRecoveryScript,
): script is typeof TERMINAL_AGENT_RECOVERY_SCRIPT {
  return script === TERMINAL_AGENT_RECOVERY_SCRIPT;
}

export function getTerminalCommand(
  agent: AgentDefinition | null,
  mode: "interactive" | "headless" = "interactive",
): string | null {
  if (!agent || !isTerminalAgent(agent)) return null;
  if (mode === "headless") return agent.runtime?.headless_command ?? null;
  return agent.runtime?.interactive_command ?? agent.runtime?.headless_command ?? null;
}

function getRecoveryHealthProbeUrl(
  agent: AgentDefinition | null,
  fallbackPort = DASHBOARD_PORT,
): string {
  if (!agent) return `http://127.0.0.1:${fallbackPort}/health`;
  if (isTerminalAgent(agent)) return "";
  return agent.healthProbe?.url || `http://127.0.0.1:${fallbackPort}/health`;
}

function escapeEre(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function escapeCharClass(value: string): string {
  return value.replace(/[\\\]\[\^\-]/g, "\\$&");
}

function selfSafeGatewayProcessPattern(command: string): string {
  const [executable = "", ...args] = command.trim().split(/\s+/).filter(Boolean);
  const [first = "", ...rest] = Array.from(executable);
  if (!first) return "";
  const executablePattern = `[${escapeCharClass(first)}]${escapeEre(rest.join(""))}`;
  const commandPattern = [executablePattern, ...args.map(escapeEre)].join("[[:space:]]+");
  return `${commandPattern}([[:space:]]|$)`;
}

/**
 * Build the legacy SSH recovery shell for custom gateway agents. OpenClaw and
 * Hermes are deliberately excluded: their topology-specific controllers own
 * lifecycle control and must never be raced by a second regex-based launcher.
 */
export function buildRecoveryScript(
  agent: AgentDefinition & { runtime: { kind: "terminal" } },
  port?: number,
): typeof TERMINAL_AGENT_RECOVERY_SCRIPT;
export function buildRecoveryScript(agent: AgentDefinition | null, port?: number): string | null;
export function buildRecoveryScript(
  agent: AgentDefinition | null,
  port = agent?.forwardPort ?? agent?.healthProbe?.port ?? DASHBOARD_PORT,
): AgentRecoveryScript {
  if (!agent) return null;
  if (isTerminalAgent(agent)) return TERMINAL_AGENT_RECOVERY_SCRIPT;
  if (agent.name === "openclaw" || agent.name === "hermes") return null;

  const probeUrl = getRecoveryHealthProbeUrl(agent, port);
  const binaryPath = agent.binary_path || "/usr/local/bin/openclaw";
  const binaryName = binaryPath.split("/").pop() ?? "openclaw";
  const defaultGatewayCommand = `${binaryName} gateway run`;
  const configuredGatewayCommand = agent.gateway_command?.trim() || defaultGatewayCommand;
  const usesValidatedBinary = configuredGatewayCommand === defaultGatewayCommand;
  const customGatewayExecutable = configuredGatewayCommand.split(/\s+/)[0] ?? binaryName;
  const staleGatewayPattern = selfSafeGatewayProcessPattern(configuredGatewayCommand);
  const validationSteps = usesValidatedBinary
    ? [
        `AGENT_BIN=${shellQuote(binaryPath)}; if [ ! -x "$AGENT_BIN" ]; then AGENT_BIN="$(command -v ${shellQuote(binaryName)})"; fi;`,
        'if [ -z "$AGENT_BIN" ]; then echo AGENT_MISSING; exit 1; fi;',
      ]
    : [
        `GATEWAY_CMD_BIN=${shellQuote(customGatewayExecutable)};`,
        'case "$GATEWAY_CMD_BIN" in */*) [ -x "$GATEWAY_CMD_BIN" ] || { echo AGENT_MISSING; exit 1; } ;; *) command -v "$GATEWAY_CMD_BIN" >/dev/null 2>&1 || { echo AGENT_MISSING; exit 1; } ;; esac;',
      ];
  // Append (>>) rather than truncate (>) so the [gateway-recovery] WARNING
  // lines that the recovery script writes to gateway.log moments earlier
  // survive past the gateway launch. Otherwise the warning explaining why the
  // gateway is about to crash gets wiped by the same launch that is about to
  // crash on a missing guard. (#2478)
  const launchCommand = usesValidatedBinary
    ? gatewayLaunchCommand(`"$AGENT_BIN" gateway run --port ${port}`)
    : gatewayLaunchCommand(`${configuredGatewayCommand} --port ${port}`);

  // Validate or rebuild /tmp/nemoclaw-proxy-env.sh before shell init and the
  // health fast path so a healthy gateway cannot leave a wiped guard chain
  // unrepaired. Recovery also stops stale launcher/gateway processes that may
  // have respawned between the health probe and relaunch.
  return [
    ...buildGatewayLogSetup(false),
    buildGatewayLogSelection(),
    ...buildGatewayGuardRecoveryLines(),
    gatewayGuardRefusalCommand(),
    "[ -f ~/.bashrc ] && . ~/.bashrc;",
    `_GW_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 3 ${shellQuote(probeUrl)} 2>/dev/null || echo 000); case "$_GW_CODE" in 200|401) echo ALREADY_RUNNING; exit 0 ;; esac;`,
    `_GATEWAY_PROC_PATTERN=${shellQuote(staleGatewayPattern)};`,
    `if [ -n "$_GATEWAY_PROC_PATTERN" ]; then pkill -TERM -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; pkill -KILL -f "$_GATEWAY_PROC_PATTERN" 2>/dev/null || true; for _i in 1 2 3 4 5; do pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1 || break; sleep 1; done; if pgrep -f "$_GATEWAY_PROC_PATTERN" >/dev/null 2>&1; then echo ${MARKERS.GATEWAY_STALE_PROCESSES}; exit 1; fi; fi;`,
    ...validationSteps,
    launchCommand,
    "GPID=$!; sleep 2;",
    `if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo ${MARKERS.GATEWAY_FAILED}; tail -5 "$_GATEWAY_LOG" 2>/dev/null; exit 1; fi`,
  ].join(" ");
}
