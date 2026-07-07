// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific runtime logic — called from nemoclaw.ts when the active
// sandbox uses a non-OpenClaw agent. Reads the agent from the onboard session
// and provides agent-aware health probes, recovery scripts, and display names.
// When the session agent is openclaw (or absent), all functions return
// defaults that match the hardcoded OpenClaw values on main.

import { DASHBOARD_PORT } from "../core/ports";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { type AgentDefinition, isTerminalAgent, loadAgent } from "./defs";
import { getTerminalCommand } from "./gateway-restart-scripts";

export {
  type AgentRecoveryScript,
  buildRecoveryScript,
  getTerminalCommand,
  isTerminalAgentRecoveryScript,
  TERMINAL_AGENT_RECOVERY_SCRIPT,
} from "./gateway-restart-scripts";

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
 * Returns the agent's configured probe URL, or the OpenClaw /health endpoint.
 *
 * Uses /health (not /) because /health returns 200 regardless of device auth
 * state, while / returns 401 when device auth is enabled. This ensures
 * health probes work correctly in all configurations. Fixes #2342.
 */
export function getHealthProbeUrl(agent: AgentDefinition | null): string {
  if (!agent) return `http://127.0.0.1:${DASHBOARD_PORT}/health`;
  if (isTerminalAgent(agent)) return "";
  return agent.healthProbe?.url || `http://127.0.0.1:${DASHBOARD_PORT}/health`;
}

export function hasGatewayRuntime(
  agent: { runtime?: { kind?: unknown } | null } | null | undefined,
): boolean {
  return !isTerminalAgent(agent);
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
  if (agent && isTerminalAgent(agent)) return getTerminalCommand(agent) ?? agent.versionCommand;
  return agent?.gateway_command || "openclaw gateway run";
}
