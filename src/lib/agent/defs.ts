// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent definition loader — each agent's definition already lives in its
// agents/*/manifest.yaml. This facade scans those per-agent files and builds
// the stable derived accessors used during onboarding; schema types and
// validation readers stay in focused sibling modules.

import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_PORT } from "../core/ports";
import { ROOT } from "../runner";
import {
  formatAgentAliasSuffix,
  resolveAgentNameAlias as resolveKnownAgentNameAlias,
} from "./aliases";
import { type AgentDashboardUi, readDashboardUi } from "./dashboard-ui";
import type {
  AgentChoice,
  AgentConfigPaths,
  AgentDashboard,
  AgentDefinition,
  AgentHealthProbe,
  AgentLegacyPaths,
  AgentMcpCapability,
  AgentStateFile,
  AgentVersionScheme,
} from "./definition-types";
import {
  loadManifestRecord,
  readBoolean,
  readDashboard,
  readHealthProbe,
  readInference,
  readMcpCapability,
  readObject,
  readPortArray,
  readStateFiles,
  readString,
  readStringArray,
  readStringMap,
  readUserManagedFiles,
  readVersionScheme,
} from "./manifest-readers";
import { type AgentRuntime, readAgentRuntime } from "./runtime-manifest";
import { type AgentWebAuth, readWebAuth } from "./web-auth";

export type {
  AgentChoice,
  AgentConfigPaths,
  AgentDashboard,
  AgentDashboardKind,
  AgentDefinition,
  AgentHealthProbe,
  AgentInference,
  AgentLegacyPaths,
  AgentMcpAdapter,
  AgentMcpCapability,
  AgentMcpSupport,
  AgentStateFile,
  AgentStateFileStrategy,
  AgentVersionScheme,
} from "./definition-types";
export type { AgentRuntime, AgentRuntimeKind } from "./runtime-manifest";
export { getAgentRuntimeKind, isTerminalAgent } from "./runtime-manifest";
export type { AgentWebAuth, AgentWebAuthMethod } from "./web-auth";

export const AGENTS_DIR = path.join(ROOT, "agents");

const _cache = new Map<string, AgentDefinition>();

export { agentAliasSummary } from "./aliases";

export function resolveAgentNameAlias(
  value: string | null | undefined,
  availableAgents: readonly string[] = listAgents(),
): string | null {
  return resolveKnownAgentNameAlias(value, availableAgents);
}

function unknownAgentMessage(
  value: string,
  context: string | null,
  available: readonly string[],
): string {
  const choices = available.join(", ");
  const suffix = context ? ` ${context}` : "";
  return `Unknown agent '${value}'${suffix}. Available: ${choices}${formatAgentAliasSuffix(available)}`;
}

/**
 * List available agent names by scanning agents/ for directories with
 * a manifest.yaml file.
 */
export function listAgents(): string[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(AGENTS_DIR, entry.name, "manifest.yaml")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Load and parse an agent manifest.
 */
export function loadAgent(name: string): AgentDefinition {
  const cached = _cache.get(name);
  if (cached) return cached;

  const manifestPath = path.join(AGENTS_DIR, name, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Agent '${name}' not found: ${manifestPath}`);
  }

  const raw = loadManifestRecord(manifestPath);
  const agentDir = path.join(AGENTS_DIR, name);
  const manifestName = readString(raw, "name") ?? name;
  const description = readString(raw, "description");
  const displayName = readString(raw, "display_name");
  const binaryPath = readString(raw, "binary_path");
  const versionCommand = readString(raw, "version_command");
  const expectedVersion = readString(raw, "expected_version");
  const versionScheme = readVersionScheme(raw);
  const gatewayCommand = readString(raw, "gateway_command");
  const runtime = readAgentRuntime(raw);
  const forwardPorts = readPortArray(raw, "forward_ports");
  const dashboard = readDashboard(raw);
  const webAuth = readWebAuth(raw);
  const healthProbe = readHealthProbe(raw);
  const config = readObject(raw, "config");
  const inference = readInference(raw);
  const mcp = readMcpCapability(raw);
  const stateDirs = readStringArray(raw, "state_dirs");
  const stateFiles = readStateFiles(raw);
  const userManagedFiles = readUserManagedFiles(raw);
  const phoneHomeHosts = readStringArray(raw, "phone_home_hosts");
  const legacyPathConfig = readStringMap(raw, "_legacy_paths");
  const dashboardUi = readDashboardUi(raw);

  const agent: AgentDefinition = {
    ...raw,
    name: manifestName,
    description,
    display_name: displayName,
    binary_path: binaryPath,
    version_command: versionCommand,
    expected_version: expectedVersion,
    version_scheme: versionScheme,
    gateway_command: gatewayCommand,
    runtime,
    device_pairing: readBoolean(raw, "device_pairing"),
    phone_home_hosts: phoneHomeHosts,
    forward_ports: forwardPorts,
    health_probe: healthProbe,
    config,
    inference,
    mcp,
    state_dirs: stateDirs,
    state_files: stateFiles,
    user_managed_files: userManagedFiles,
    _legacy_paths: legacyPathConfig,
    agentDir,
    manifestPath,

    get displayName(): string {
      return displayName ?? manifestName;
    },

    get healthProbe(): AgentHealthProbe | null {
      if (runtime.kind === "terminal" && !healthProbe) {
        return null;
      }
      return (
        healthProbe ?? {
          url: `http://localhost:${String(DASHBOARD_PORT)}/`,
          port: DASHBOARD_PORT,
          timeout_seconds: 30,
        }
      );
    },

    get forwardPort(): number {
      if (runtime.kind === "terminal" && !forwardPorts?.[0]) {
        return 0;
      }
      return forwardPorts?.[0] ?? DASHBOARD_PORT;
    },

    get dashboard(): AgentDashboard {
      return dashboard;
    },

    get webAuth(): AgentWebAuth {
      return webAuth;
    },

    get dashboardUi(): AgentDashboardUi | null {
      return dashboardUi;
    },

    get configPaths(): AgentConfigPaths {
      return {
        dir: readString(config ?? {}, "dir") ?? "/sandbox/.openclaw",
        configFile: readString(config ?? {}, "config_file") ?? "openclaw.json",
        envFile: readString(config ?? {}, "env_file") ?? null,
        format: readString(config ?? {}, "format") ?? "json",
      };
    },

    get inferenceProviderOptions(): string[] {
      return inference?.provider_options ?? [];
    },

    get mcpCapability(): AgentMcpCapability {
      return mcp;
    },

    get stateDirs(): string[] {
      return stateDirs ?? [];
    },

    get stateFiles(): AgentStateFile[] {
      return stateFiles ?? [];
    },

    get userManagedFiles(): string[] {
      return userManagedFiles ?? [];
    },

    get versionCommand(): string {
      return versionCommand ?? `${binaryPath ?? "unknown"} --version`;
    },

    get expectedVersion(): string | null {
      return expectedVersion ?? null;
    },

    get versionScheme(): AgentVersionScheme | null {
      return versionScheme ?? null;
    },

    get hasDevicePairing(): boolean {
      return readBoolean(raw, "device_pairing") === true;
    },

    get phoneHomeHosts(): string[] {
      return phoneHomeHosts ?? [];
    },

    get dockerfileBasePath(): string | null {
      const dockerfileBase = path.join(agentDir, "Dockerfile.base");
      return fs.existsSync(dockerfileBase) ? dockerfileBase : null;
    },

    get dockerfilePath(): string | null {
      const dockerfilePath = path.join(agentDir, "Dockerfile");
      return fs.existsSync(dockerfilePath) ? dockerfilePath : null;
    },

    get startScriptPath(): string | null {
      const startScriptPath = path.join(agentDir, "start.sh");
      return fs.existsSync(startScriptPath) ? startScriptPath : null;
    },

    get policyAdditionsPath(): string | null {
      const policyAdditionsPath = path.join(agentDir, "policy-additions.yaml");
      return fs.existsSync(policyAdditionsPath) ? policyAdditionsPath : null;
    },

    get policyPermissivePath(): string | null {
      const policyPermissivePath = path.join(agentDir, "policy-permissive.yaml");
      return fs.existsSync(policyPermissivePath) ? policyPermissivePath : null;
    },

    get pluginDir(): string | null {
      const pluginDir = path.join(agentDir, "plugin");
      return fs.existsSync(pluginDir) ? pluginDir : null;
    },

    get legacyPaths(): AgentLegacyPaths | null {
      if (!legacyPathConfig) return null;
      return {
        dockerfileBase: legacyPathConfig.dockerfile_base
          ? path.join(ROOT, legacyPathConfig.dockerfile_base)
          : null,
        dockerfile: legacyPathConfig.dockerfile
          ? path.join(ROOT, legacyPathConfig.dockerfile)
          : null,
        startScript: legacyPathConfig.start_script
          ? path.join(ROOT, legacyPathConfig.start_script)
          : null,
        policy: legacyPathConfig.policy ? path.join(ROOT, legacyPathConfig.policy) : null,
        plugin: legacyPathConfig.plugin ? path.join(ROOT, legacyPathConfig.plugin) : null,
      };
    },
  };

  _cache.set(name, agent);
  return agent;
}

/**
 * Get agent choices for interactive prompt (name, display_name, description).
 * OpenClaw is listed first as the default.
 */
export function getAgentChoices(): AgentChoice[] {
  // Build the menu defensively: a single malformed non-default manifest must
  // not abort interactive onboarding (e.g. an OpenClaw user accepting the
  // default). Skip agents that fail to load and surface a warning instead.
  const agents = listAgents().flatMap((name) => {
    try {
      const agent = loadAgent(name);
      return [
        {
          name: agent.name,
          displayName: agent.displayName,
          description: agent.description ?? "",
        },
      ];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`  Warning: skipping agent '${name}' — failed to load manifest: ${reason}`);
      return [];
    }
  });

  agents.sort((left, right) => {
    if (left.name === "openclaw") return -1;
    if (right.name === "openclaw") return 1;
    return left.name.localeCompare(right.name);
  });

  return agents;
}

/**
 * Resolve the effective agent from CLI flags, env vars, or session state.
 * Priority: explicit flag > env var > session > default ("openclaw").
 */
export function resolveAgentName({
  agentFlag = null,
  session = null,
}: {
  agentFlag?: string | null;
  session?: { agent?: string } | null;
} = {}): string {
  if (agentFlag) {
    const available = listAgents();
    const resolved = resolveAgentNameAlias(agentFlag, available);
    if (!resolved) {
      throw new Error(unknownAgentMessage(agentFlag, null, available));
    }
    return resolved;
  }

  const envAgent = process.env.NEMOCLAW_AGENT;
  if (envAgent) {
    const available = listAgents();
    const resolved = resolveAgentNameAlias(envAgent, available);
    if (!resolved) {
      throw new Error(unknownAgentMessage(envAgent, "(from NEMOCLAW_AGENT)", available));
    }
    return resolved;
  }

  if (session?.agent) {
    const available = listAgents();
    const resolved = resolveAgentNameAlias(session.agent, available);
    if (!resolved) {
      console.error(
        `  Warning: session references unknown agent '${session.agent}', falling back to openclaw.`,
      );
      return "openclaw";
    }
    return resolved;
  }

  return "openclaw";
}
