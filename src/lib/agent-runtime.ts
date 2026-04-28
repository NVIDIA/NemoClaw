// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific runtime logic — called from nemoclaw.ts when the active
// sandbox uses a non-OpenClaw agent. Reads the agent from the onboard session
// and provides agent-aware health probes, recovery scripts, and display names.
// When the session agent is openclaw (or absent), all functions return
// defaults that match the hardcoded OpenClaw values on main.

import * as registry from "./registry";
import { DASHBOARD_PORT } from "./ports";
import * as onboardSession from "./onboard-session";
import { loadAgent, type AgentDefinition } from "./agent-defs";
import { shellQuote } from "./runner";

/**
 * Resolve the agent for a sandbox. Checks the per-sandbox registry first
 * (so status/connect/recovery use the right agent even when multiple
 * sandboxes exist), then falls back to the global onboard session.
 * Returns the loaded agent definition for non-OpenClaw agents, or null.
 */
export function getSessionAgent(sandboxName?: string): AgentDefinition | null {
  try {
    if (sandboxName) {
      const sb = registry.getSandbox(sandboxName);
      if (sb?.agent && sb.agent !== "openclaw") {
        return loadAgent(sb.agent);
      }
      if (sb?.agent === "openclaw" || (sb && !sb.agent)) {
        return null;
      }
    }
    const session = onboardSession.loadSession();
    const name = session?.agent || "openclaw";
    if (name === "openclaw") return null;
    return loadAgent(name);
  } catch {
    return null;
  }
}

/**
 * Get the health probe URL for the agent.
 * Returns the agent's configured probe URL, or the OpenClaw default.
 */
export function getHealthProbeUrl(agent: AgentDefinition | null): string {
  if (!agent) return `http://127.0.0.1:${DASHBOARD_PORT}/`;
  return agent.healthProbe?.url || `http://127.0.0.1:${DASHBOARD_PORT}/`;
}

/**
 * Build the recovery shell script for a non-OpenClaw agent.
 * Returns the script string, or null if agent is null (use existing inline
 * OpenClaw script instead).
 */
export function buildRecoveryScript(agent: AgentDefinition | null, port: number): string | null {
  if (!agent) return null;

  const probeUrl = getHealthProbeUrl(agent);
  const binaryPath = agent.binary_path || "/usr/local/bin/openclaw";
  const binaryName = binaryPath.split("/").pop() ?? "openclaw";
  const defaultGatewayCommand = `${binaryName} gateway run`;
  const configuredGatewayCommand = agent.gateway_command?.trim() || defaultGatewayCommand;
  const usesValidatedBinary = configuredGatewayCommand === defaultGatewayCommand;
  const customGatewayExecutable = configuredGatewayCommand.split(/\s+/)[0] ?? binaryName;
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
  // survive past the gateway launch — otherwise the warning explaining
  // *why* the gateway is about to crash gets wiped by the same launch
  // that's about to crash on a missing guard. (#2478)
  const launchCommand = usesValidatedBinary
    ? `nohup "$AGENT_BIN" gateway run --port ${port} >> /tmp/gateway.log 2>&1 &`
    : `nohup ${configuredGatewayCommand} --port ${port} >> /tmp/gateway.log 2>&1 &`;
  const isHermes = agent.name === "hermes";
  const hermesHome = isHermes ? "export HERMES_HOME=/sandbox/.hermes-data; " : "";

  // Source /tmp/nemoclaw-proxy-env.sh explicitly before launching. That file
  // is the single source of truth for NODE_OPTIONS preload guards (safety-net,
  // ciao networkInterfaces, slack, http-proxy, ws-proxy, nemotron). On the
  // first start it reaches the gateway transitively via .bashrc, but on
  // gateway respawn (laptop sleep, health-monitor restart) silent sourcing
  // failures left guards out of NODE_OPTIONS and the gateway crash-looped
  // on the next library error (#2478). Source it explicitly, log when the
  // file is missing, and warn when the safety-net preload is not in the
  // resulting NODE_OPTIONS so future regressions stay observable instead
  // of silently regressing into a crash loop.
  // Source proxy-env.sh and check NODE_OPTIONS first, but defer warning
  // emission until AFTER touch+chmod gateway.log so warnings land in the
  // fresh log a sysadmin would tail. Writing to stderr alone hides them
  // because the recovery script's stderr is captured by executeSandboxCommand
  // (returned to nemoclaw status, not displayed). Routing them through
  // /tmp/gateway.log makes the diagnostic discoverable for both real users
  // and the #2478 e2e regression test.
  return [
    "if [ -r /tmp/nemoclaw-proxy-env.sh ]; then . /tmp/nemoclaw-proxy-env.sh; _PE_MISSING=0; else _PE_MISSING=1; fi;",
    "[ -f ~/.bashrc ] && . ~/.bashrc;",
    'case "${NODE_OPTIONS:-}" in *nemoclaw-sandbox-safety-net*) _GUARDS_MISSING=0 ;; *) _GUARDS_MISSING=1 ;; esac;',
    hermesHome,
    `if curl -sf --max-time 3 ${shellQuote(probeUrl)} > /dev/null 2>&1; then echo ALREADY_RUNNING; exit 0; fi;`,
    "rm -f /tmp/gateway.log;",
    "touch /tmp/gateway.log; chmod 600 /tmp/gateway.log;",
    '[ "$_PE_MISSING" = "1" ] && { _W="[gateway-recovery] WARNING: /tmp/nemoclaw-proxy-env.sh missing — gateway launching without library guards (#2478)"; echo "$_W" >&2; echo "$_W" >> /tmp/gateway.log; };',
    '[ "$_GUARDS_MISSING" = "1" ] && { _W="[gateway-recovery] WARNING: NODE_OPTIONS missing safety-net preload — gateway may crash on unhandled library errors (#2478)"; echo "$_W" >&2; echo "$_W" >> /tmp/gateway.log; };',
    ...validationSteps,
    launchCommand,
    "GPID=$!; sleep 2;",
    'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; cat /tmp/gateway.log 2>/dev/null | tail -5; fi',
  ].join(" ");
}

/**
 * Get the display name for the current agent.
 */
export function getAgentDisplayName(agent: AgentDefinition | null): string {
  return agent ? agent.displayName : "OpenClaw";
}

/**
 * Get the gateway command for the current agent.
 */
export function getGatewayCommand(agent: AgentDefinition | null): string {
  return agent?.gateway_command || "openclaw gateway run";
}
