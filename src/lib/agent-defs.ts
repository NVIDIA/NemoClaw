// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent definition loader — reads agents/*/manifest.yaml and provides
// accessors for agent-specific configuration used during onboarding.

import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require("js-yaml");

import { ROOT } from "./runner";
import { DASHBOARD_PORT } from "./ports";

export const AGENTS_DIR = path.join(ROOT, "agents");

export interface AgentHealthProbe {
  url: string;
  port: number;
  timeout_seconds: number;
}

export interface AgentConfigPaths {
  immutableDir: string;
  writableDir: string;
  configFile: string;
  envFile: string | null;
  format: string;
}

export interface AgentLegacyPaths {
  dockerfileBase: string | null;
  dockerfile: string | null;
  startScript: string | null;
  policy: string | null;
  plugin: string | null;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  display_name?: string;
  binary_path?: string;
  version_command?: string;
  expected_version?: string;
  gateway_command?: string;
  device_pairing?: boolean;
  phone_home_hosts?: string[];
  forward_ports?: number[];
  health_probe?: AgentHealthProbe;
  config?: Record<string, unknown>;
  state_dirs?: string[];
  messaging_platforms?: { supported?: string[] };
  _legacy_paths?: Record<string, string>;
  agentDir: string;
  manifestPath: string;
  readonly displayName: string;
  readonly healthProbe: AgentHealthProbe;
  readonly forwardPort: number;
  readonly configPaths: AgentConfigPaths;
  readonly stateDirs: string[];
  readonly versionCommand: string;
  readonly expectedVersion: string | null;
  readonly hasDevicePairing: boolean;
  readonly phoneHomeHosts: string[];
  readonly messagingPlatforms: string[];
  readonly dockerfileBasePath: string | null;
  readonly dockerfilePath: string | null;
  readonly startScriptPath: string | null;
  readonly policyAdditionsPath: string | null;
  readonly policyPermissivePath: string | null;
  readonly pluginDir: string | null;
  readonly legacyPaths: AgentLegacyPaths | null;
  [key: string]: unknown;
}

export interface AgentChoice {
  name: string;
  displayName: string;
  description: string;
}

const _cache = new Map<string, AgentDefinition>();

/**
 * List available agent names by scanning agents/ for directories with
 * a manifest.yaml file.
 */
export function listAgents(): string[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => fs.existsSync(path.join(AGENTS_DIR, d.name, "manifest.yaml")))
    .map((d) => d.name)
    .sort();
}

/**
 * Load and parse an agent manifest.
 */
export function loadAgent(name: string): AgentDefinition {
  if (_cache.has(name)) return _cache.get(name)!;

  const manifestPath = path.join(AGENTS_DIR, name, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Agent '${name}' not found: ${manifestPath}`);
  }

  const raw = yaml.load(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const agentDir = path.join(AGENTS_DIR, name);

  const agent: AgentDefinition = {
    // Raw manifest fields
    ...raw,

    // Computed paths
    agentDir,
    manifestPath,

    get displayName(): string {
      return (raw.display_name as string) || (raw.name as string);
    },

    get healthProbe(): AgentHealthProbe {
      return (
        (raw.health_probe as AgentHealthProbe) || {
          url: `http://localhost:${DASHBOARD_PORT}/`,
          port: DASHBOARD_PORT,
          timeout_seconds: 30,
        }
      );
    },

    get forwardPort(): number {
      const ports = (raw.forward_ports as number[]) || [];
      return ports[0] || DASHBOARD_PORT;
    },

    get configPaths(): AgentConfigPaths {
      const cfg = (raw.config as Record<string, string>) || {};
      return {
        immutableDir: cfg.immutable_dir || "/sandbox/.openclaw",
        writableDir: cfg.writable_dir || "/sandbox/.openclaw-data",
        configFile: cfg.config_file || "openclaw.json",
        envFile: cfg.env_file || null,
        format: cfg.format || "json",
      };
    },

    get stateDirs(): string[] {
      return (raw.state_dirs as string[]) || [];
    },

    get versionCommand(): string {
      return (raw.version_command as string) || `${raw.binary_path || "unknown"} --version`;
    },

    get expectedVersion(): string | null {
      return (raw.expected_version as string) || null;
    },

    get hasDevicePairing(): boolean {
      return raw.device_pairing === true;
    },

    get phoneHomeHosts(): string[] {
      return (raw.phone_home_hosts as string[]) || [];
    },

    get messagingPlatforms(): string[] {
      const mp = (raw.messaging_platforms as { supported?: string[] }) || {};
      return mp.supported || [];
    },

    get dockerfileBasePath(): string | null {
      const p = path.join(agentDir, "Dockerfile.base");
      return fs.existsSync(p) ? p : null;
    },

    get dockerfilePath(): string | null {
      const p = path.join(agentDir, "Dockerfile");
      return fs.existsSync(p) ? p : null;
    },

    get startScriptPath(): string | null {
      const p = path.join(agentDir, "start.sh");
      return fs.existsSync(p) ? p : null;
    },

    get policyAdditionsPath(): string | null {
      const p = path.join(agentDir, "policy-additions.yaml");
      return fs.existsSync(p) ? p : null;
    },

    get policyPermissivePath(): string | null {
      const p = path.join(agentDir, "policy-permissive.yaml");
      return fs.existsSync(p) ? p : null;
    },

    get pluginDir(): string | null {
      const p = path.join(agentDir, "plugin");
      return fs.existsSync(p) ? p : null;
    },

    get legacyPaths(): AgentLegacyPaths | null {
      if (!raw._legacy_paths) return null;
      const lp = raw._legacy_paths as Record<string, string>;
      return {
        dockerfileBase: lp.dockerfile_base ? path.join(ROOT, lp.dockerfile_base) : null,
        dockerfile: lp.dockerfile ? path.join(ROOT, lp.dockerfile) : null,
        startScript: lp.start_script ? path.join(ROOT, lp.start_script) : null,
        policy: lp.policy ? path.join(ROOT, lp.policy) : null,
        plugin: lp.plugin ? path.join(ROOT, lp.plugin) : null,
      };
    },
  } as AgentDefinition;

  _cache.set(name, agent);
  return agent;
}

/**
 * Get agent choices for interactive prompt (name, display_name, description).
 * OpenClaw is listed first as the default.
 */
export function getAgentChoices(): AgentChoice[] {
  const agents = listAgents().map((name) => {
    const a = loadAgent(name);
    return {
      name: a.name as string,
      displayName: a.displayName,
      description: (a.description as string) || "",
    };
  });

  agents.sort((a, b) => {
    if (a.name === "openclaw") return -1;
    if (b.name === "openclaw") return 1;
    return a.name.localeCompare(b.name);
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
    if (!available.includes(agentFlag)) {
      const choices = available.join(", ");
      throw new Error(`Unknown agent '${agentFlag}'. Available: ${choices}`);
    }
    return agentFlag;
  }

  const envAgent = process.env.NEMOCLAW_AGENT;
  if (envAgent) {
    const available = listAgents();
    if (!available.includes(envAgent)) {
      const choices = available.join(", ");
      throw new Error(`Unknown agent '${envAgent}' (from NEMOCLAW_AGENT). Available: ${choices}`);
    }
    return envAgent;
  }

  if (session && session.agent) {
    const available = listAgents();
    if (!available.includes(session.agent)) {
      console.error(
        `  Warning: session references unknown agent '${session.agent}', falling back to openclaw.`,
      );
      return "openclaw";
    }
    return session.agent;
  }

  return "openclaw";
}
