// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentDefinition,
  type AgentMcpAdapter,
  listAgents,
  loadAgent,
} from "../../agent/defs";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { buildOpenShellRuntimeSelectionEnv } from "../../adapters/openshell/runtime-selection";
import { buildOpenShellSubprocessEnv } from "../../adapters/openshell/resolve-shared";
import { captureSanitizedResolvedOpenshell } from "../../adapters/openshell/sanitized-capture";
import { isOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import {
  recoverNamedGatewayRuntime,
  getNamedGatewayLifecycleState,
  replaceOpenShellRuntimeSelectionEnv,
} from "../../gateway-runtime-action";
import type { SandboxEntry } from "../../state/registry";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import * as registry from "../../state/registry";
import { ConfigCorruptError } from "../../state/config-io";
import { getReportedGatewayName } from "../../state/gateway";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import {
  getPersistedSandboxTargetGateway,
  getPersistedSandboxTargetGatewayName,
} from "./gateway-target";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  getMcpProviderInspectionRuntimeSelection,
  type McpProviderInspectionRuntimeSelection,
} from "./mcp-bridge-provider-inspection";
import { validateSandboxName } from "./mcp-bridge-validation";

function registeredMcpSandbox(sandboxName: string): SandboxEntry | null {
  try {
    return registry.getSandbox(sandboxName);
  } catch (error) {
    if (!(error instanceof ConfigCorruptError)) throw error;
    return null;
  }
}

function requireMcpTargetGateway(gatewayName: string | null) {
  try {
    if (!gatewayName) throw new Error("Gateway identity is missing.");
    return getPersistedSandboxTargetGateway({ gatewayName });
  } catch {
    throw new McpBridgeError(
      "The selected OpenShell gateway is not a supported exact NemoClaw MCP target.",
      1,
    );
  }
}

const LIVE_AGENT_PROBE = `
import json, os, stat, sys
def trusted_executable(path):
    pending = path.split("/")[1:]
    current = "/"
    links = 0
    info = os.lstat(current)
    if info.st_uid != 0 or info.st_mode & 0o022:
        return False
    for _ in range(96):
        if not pending:
            return stat.S_ISREG(info.st_mode) and bool(info.st_mode & 0o111)
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            current = os.path.dirname(current)
            info = os.lstat(current)
            continue
        candidate = os.path.join(current, part)
        info = os.lstat(candidate)
        if info.st_uid != 0:
            return False
        if stat.S_ISLNK(info.st_mode):
            links += 1
            if links > 16:
                return False
            target = os.readlink(candidate)
            if os.path.isabs(target):
                current = "/"
            pending = target.split("/") + pending
            continue
        if info.st_mode & 0o022 or (pending and not stat.S_ISDIR(info.st_mode)):
            return False
        current = candidate
    return False
agents = []
unsafe = False
for name, binary in json.loads(sys.argv[1]):
    try:
        os.lstat(binary)
    except FileNotFoundError:
        continue
    except OSError:
        unsafe = True
        continue
    try:
        if trusted_executable(binary):
            agents.append(name)
        else:
            unsafe = True
    except OSError:
        unsafe = True
print(json.dumps({"agents": agents, "unsafe": unsafe}))
`.trim();

function captureMcpTarget(
  args: string[],
  runtimeSelection?: OpenShellRuntimeSelection,
  stream: "stdout" | "combined" = "stdout",
): string {
  const result = captureSanitizedResolvedOpenshell(args, {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    maxBuffer: 1024 * 1024,
    timeout: 20_000,
    ...(runtimeSelection
      ? {
          env: buildOpenShellRuntimeSelectionEnv(
            buildOpenShellSubprocessEnv() as Record<string, string>,
            runtimeSelection,
          ),
          replaceEnv: true as const,
        }
      : {}),
  });
  if (result.status !== 0 || result.error) {
    throw new McpBridgeError(
      "Could not inspect the requested MCP target on its selected OpenShell gateway.",
      1,
    );
  }
  return stream === "combined" ? result.output : (result.stdout ?? result.output);
}

function liveSandboxIdentity(
  sandboxName: string,
  runtimeSelection: OpenShellRuntimeSelection,
): string {
  try {
    const value = JSON.parse(
      captureMcpTarget(["sandbox", "get", sandboxName, "-o", "json"], runtimeSelection),
    );
    if (
      value.name === sandboxName &&
      value.workspace === runtimeSelection.workspace &&
      isOpenShellSandboxId(value.id)
    ) {
      return value.id;
    }
  } catch {
    // Raw OpenShell output can contain policy data; do not reflect it.
  }
  throw new McpBridgeError(
    `Sandbox '${sandboxName}' could not be identified on the selected OpenShell gateway.`,
    1,
  );
}

export interface McpOperationTarget {
  readonly sandbox: SandboxEntry;
  readonly runtimeSelection: McpProviderInspectionRuntimeSelection;
  readonly liveIdentity?: {
    readonly sandboxId: string;
    assertCurrent(): void;
    assertRuntimeResource?(providerId: string, resourceHandle: string): void;
  };
}

/** Resolve one command's target without reconstructing a sandbox registry. */
export function resolveMcpOperationTarget(sandboxName: string): McpOperationTarget {
  validateSandboxName(sandboxName);
  const registered = registeredMcpSandbox(sandboxName);
  if (registered)
    return {
      sandbox: registered,
      runtimeSelection: getMcpProviderInspectionRuntimeSelection(registered),
    };
  assertNoOpenShellGatewayEndpointOverride();
  const explicitGateway = process.env.OPENSHELL_GATEWAY;
  if (explicitGateway) requireMcpTargetGateway(explicitGateway);
  const args = ["gateway", "info", ...(explicitGateway ? ["-g", explicitGateway] : [])];
  const { gatewayName, gatewayPort } = requireMcpTargetGateway(
    getReportedGatewayName(captureMcpTarget(args, undefined, "combined")),
  );
  if (explicitGateway && explicitGateway !== gatewayName) {
    throw new McpBridgeError(
      "The selected OpenShell gateway is not a supported exact NemoClaw MCP target.",
      1,
    );
  }
  if (process.env.OPENSHELL_WORKSPACE && process.env.OPENSHELL_WORKSPACE !== "default") {
    throw new McpBridgeError(
      "MCP target resolution requires the selected default OpenShell workspace.",
      1,
    );
  }
  const target = { name: sandboxName, gatewayName, gatewayPort };
  const runtimeSelection = getMcpProviderInspectionRuntimeSelection(target);
  const identity = liveSandboxIdentity(sandboxName, runtimeSelection);
  const agents = listAgents()
    .map((name) => loadAgent(name))
    .filter(
      (agent) =>
        agent.mcpCapability.support === "bridge" &&
        typeof agent.binary_path === "string" &&
        agent.binary_path.startsWith("/"),
    );
  let observed: { agents?: unknown; unsafe?: unknown };
  try {
    observed = JSON.parse(
      captureMcpTarget(
        [
          "sandbox",
          "exec",
          "--name",
          sandboxName,
          "--timeout",
          "15",
          "--",
          "/usr/bin/python3",
          "-I",
          "-S",
          "-c",
          LIVE_AGENT_PROBE,
          JSON.stringify(agents.map((agent) => [agent.name, agent.binary_path])),
        ],
        runtimeSelection,
      ),
    );
  } catch {
    throw new McpBridgeError(
      `Could not identify a supported live MCP agent for sandbox '${sandboxName}'.`,
      1,
    );
  }
  const [agentName] = Array.isArray(observed?.agents) ? observed.agents : [];
  if (
    observed?.unsafe !== false ||
    !Array.isArray(observed.agents) ||
    observed.agents.length !== 1 ||
    !agents.some((agent) => agent.name === agentName)
  ) {
    throw new McpBridgeError(
      `Sandbox '${sandboxName}' does not expose exactly one trusted supported MCP agent.`,
      1,
    );
  }
  if (liveSandboxIdentity(sandboxName, runtimeSelection) !== identity) {
    throw new McpBridgeError(
      `Sandbox '${sandboxName}' changed identity during MCP target resolution.`,
      1,
    );
  }
  const sandbox = Object.freeze({ ...target, agent: agentName });
  const capturedSelection = Object.freeze({ ...runtimeSelection });
  let runtimeResource: readonly [string, string] | undefined;
  return Object.freeze({
    sandbox,
    runtimeSelection: capturedSelection,
    liveIdentity: Object.freeze({
      sandboxId: identity,
      assertRuntimeResource(providerId: string, resourceHandle: string) {
        if (
          runtimeResource &&
          (runtimeResource[0] !== providerId || runtimeResource[1] !== resourceHandle)
        ) {
          throw new McpBridgeError(
            "The MCP sandbox runtime resource changed during this operation.",
          );
        }
        runtimeResource ??= Object.freeze([providerId, resourceHandle] as const);
      },
      assertCurrent() {
        // Permission failures remain terminal even if the command began with no row.
        const current = registeredMcpSandbox(sandboxName);
        if (
          current &&
          (current.agent !== agentName ||
            getPersistedSandboxTargetGatewayName(current) !== gatewayName)
        ) {
          throw new McpBridgeError("The MCP sandbox registration changed during this operation.");
        }
        assertNoOpenShellGatewayEndpointOverride();
        if (liveSandboxIdentity(sandboxName, capturedSelection) !== identity) {
          throw new McpBridgeError("The MCP sandbox identity changed during this operation.");
        }
      },
    }),
  });
}

/** Retained for callers which only consume the resolved sandbox description. */
export function getSandboxOrThrow(sandboxName: string): SandboxEntry {
  validateSandboxName(sandboxName);
  const registered = registeredMcpSandbox(sandboxName);
  if (registered) return registered;
  return resolveMcpOperationTarget(sandboxName).sandbox;
}

function getSandboxAgentName(sandbox: SandboxEntry): string {
  return sandbox.agent || "openclaw";
}

export function getSandboxAgent(sandbox: SandboxEntry): AgentDefinition {
  return loadAgent(getSandboxAgentName(sandbox));
}

/** Return the configured state directory for a registered agent. */
export function getAgentConfigDir(agentName: string, defaultConfigDir?: string): string {
  try {
    return loadAgent(agentName).configPaths.dir;
  } catch (error) {
    if (defaultConfigDir) return defaultConfigDir;
    throw error;
  }
}

function unsupportedMessage(agent: AgentDefinition): string {
  const reason = agent.mcpCapability.reason
    ? ` ${agent.mcpCapability.reason}`
    : " MCP support is disabled for this agent.";
  return `${agent.displayName} does not support managed MCP servers yet.${reason} Issue #566 tracks future design.`;
}

function assertBridgeSupported(agent: AgentDefinition): void {
  if (agent.mcpCapability.support === "bridge") return;
  throw new McpBridgeError(unsupportedMessage(agent), 1);
}

export function getBridgeAdapter(agent: AgentDefinition): AgentMcpAdapter {
  assertBridgeSupported(agent);
  const adapter = agent.mcpCapability.adapter;
  if (!adapter) {
    throw new McpBridgeError(
      `${agent.displayName} declares MCP support but does not declare an adapter.`,
      1,
    );
  }
  return adapter;
}

export function assertNoDerivedResourceCollision(
  bridges: Readonly<Record<string, McpSourceEntry>>,
  server: string,
  providerName: string | undefined,
  policyName: string,
): void {
  for (const entry of Object.values(bridges)) {
    if (entry.server === server) continue;
    const providerCollision =
      providerName !== undefined &&
      entry.providerName !== undefined &&
      entry.providerName === providerName;
    if (providerCollision || entry.policyName === policyName) {
      throw new McpBridgeError(
        `MCP server '${server}' conflicts with existing server '${entry.server}' after OpenShell resource-name normalization. Choose a name that differs beyond case, hyphens, and underscores.`,
        2,
      );
    }
  }
}

export async function ensureSandboxGatewaySelected(
  sandboxName: string,
  runtimeSelection: OpenShellRuntimeSelection,
): Promise<void> {
  const registered = registeredMcpSandbox(sandboxName);
  const gatewayName = registered
    ? getPersistedSandboxTargetGatewayName(registered)
    : runtimeSelection.gatewayName;
  if (gatewayName !== runtimeSelection.gatewayName) {
    throw new McpBridgeError("MCP runtime selection disagrees with the sandbox gateway.", 1);
  }
  if (!registered) {
    const observed = getNamedGatewayLifecycleState(gatewayName, {
      ignoreProbeErrors: true,
      runtimeSelection,
    });
    if (observed.state !== "healthy_named") {
      throw new McpBridgeError(
        `Selected OpenShell gateway '${gatewayName}' is not healthy. Refusing MCP target recovery without registry authority.`,
        1,
      );
    }
    replaceOpenShellRuntimeSelectionEnv(process.env, runtimeSelection);
    return;
  }
  const recovery = await recoverNamedGatewayRuntime({
    gatewayName,
    runtimeSelection,
  });
  if (!recovery.recovered || recovery.after.state !== "healthy_named") {
    throw new McpBridgeError(
      `Could not select healthy OpenShell gateway '${gatewayName}' for sandbox '${sandboxName}' (before: ${recovery.before.state}, after: ${recovery.after.state}). Refusing to mutate MCP resources on another gateway.`,
    );
  }
  // Pin every subsequent OpenShell subprocess in this lifecycle operation to
  // the sandbox's recorded gateway. The globally selected gateway is mutable
  // shared metadata and another NemoClaw process may select a sibling between
  // this health check and the provider/policy mutation.
  replaceOpenShellRuntimeSelectionEnv(process.env, runtimeSelection);
}
