// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent definition loader — reads agents/*/manifest.yaml and provides
// accessors for agent-specific configuration used during onboarding.

import fs from "node:fs";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml: { load(input: string): unknown } = require("js-yaml");

import { ROOT } from "./runner";
import { DASHBOARD_PORT } from "./ports";

export const AGENTS_DIR = path.join(ROOT, "agents");

type ManifestScalar = string | number | boolean | null | Date;
type ManifestValue = ManifestScalar | ManifestRecord | ManifestValue[];
type ManifestRecord = { [key: string]: ManifestValue };
type StringMap = { [key: string]: string };

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

export type AgentDashboardKind = "ui" | "api";

export interface AgentDashboard {
  kind: AgentDashboardKind;
  label: string;
  path: string;
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
  config?: ManifestRecord;
  state_dirs?: string[];
  messaging_platforms?: { supported?: string[] };
  _legacy_paths?: StringMap;
  agentDir: string;
  manifestPath: string;
  readonly displayName: string;
  readonly healthProbe: AgentHealthProbe;
  readonly forwardPort: number;
  readonly dashboard: AgentDashboard;
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

function isManifestValue(value: unknown): value is ManifestValue {
  if (value === null || value instanceof Date) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isManifestValue(entry));
  }
  return isManifestRecord(value);
}

function isManifestRecord(value: unknown): value is ManifestRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every((entry) => isManifestValue(entry));
}

function readString(record: ManifestRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(record: ManifestRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readObject(record: ManifestRecord, key: string): ManifestRecord | undefined {
  const value = record[key];
  return isManifestRecord(value) ? value : undefined;
}

function readStringArray(record: ManifestRecord, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function readPortArray(record: ManifestRecord, key: string): number[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Agent manifest field '${key}' must be an array of TCP ports`);
  }

  const ports = value.map((entry, index) => {
    if (!isValidPort(entry)) {
      throw new Error(
        `Agent manifest field '${key}[${String(index)}]' must be an integer TCP port between 1 and 65535`,
      );
    }
    return entry;
  });

  return ports.length > 0 ? ports : undefined;
}

function readStringMap(record: ManifestRecord, key: string): StringMap | undefined {
  const value = readObject(record, key);
  if (!value) return undefined;

  const result: StringMap = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      result[entryKey] = entryValue;
    }
  }
  return result;
}

function readHealthProbe(record: ManifestRecord): AgentHealthProbe | undefined {
  const healthProbe = readObject(record, "health_probe");
  if (!healthProbe) return undefined;

  const url = readString(healthProbe, "url");
  const port = healthProbe.port;
  const timeoutSeconds = healthProbe.timeout_seconds;

  if (port !== undefined && !isValidPort(port)) {
    throw new Error(
      "Agent manifest field 'health_probe.port' must be an integer TCP port between 1 and 65535",
    );
  }

  if (
    typeof url === "string" &&
    isValidPort(port) &&
    typeof timeoutSeconds === "number" &&
    Number.isFinite(timeoutSeconds)
  ) {
    return {
      url,
      port,
      timeout_seconds: timeoutSeconds,
    };
  }

  return undefined;
}

function readMessagingPlatforms(record: ManifestRecord): { supported?: string[] } | undefined {
  const messagingPlatforms = readObject(record, "messaging_platforms");
  if (!messagingPlatforms) return undefined;

  const supported = readStringArray(messagingPlatforms, "supported");
  return supported ? { supported } : {};
}

function loadManifestRecord(manifestPath: string): ManifestRecord {
  const parsed = yaml.load(fs.readFileSync(manifestPath, "utf8"));
  if (!isManifestRecord(parsed)) {
    throw new Error(`Agent manifest must be a YAML object: ${manifestPath}`);
  }
  return parsed;
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
  const gatewayCommand = readString(raw, "gateway_command");
  const forwardPorts = readPortArray(raw, "forward_ports");
  const healthProbe = readHealthProbe(raw);
  const config = readObject(raw, "config");
  const stateDirs = readStringArray(raw, "state_dirs");
  const phoneHomeHosts = readStringArray(raw, "phone_home_hosts");
  const messagingPlatforms = readMessagingPlatforms(raw);
  const legacyPathConfig = readStringMap(raw, "_legacy_paths");

  const agent: AgentDefinition = {
    ...raw,
    name: manifestName,
    description,
    display_name: displayName,
    binary_path: binaryPath,
    version_command: versionCommand,
    expected_version: expectedVersion,
    gateway_command: gatewayCommand,
    device_pairing: readBoolean(raw, "device_pairing"),
    phone_home_hosts: phoneHomeHosts,
    forward_ports: forwardPorts,
    health_probe: healthProbe,
    config,
    state_dirs: stateDirs,
    messaging_platforms: messagingPlatforms,
    _legacy_paths: legacyPathConfig,
    agentDir,
    manifestPath,

    get displayName(): string {
      return displayName ?? manifestName;
    },

    get healthProbe(): AgentHealthProbe {
      return (
        healthProbe ?? {
          url: `http://localhost:${String(DASHBOARD_PORT)}/`,
          port: DASHBOARD_PORT,
          timeout_seconds: 30,
        }
      );
    },

    get forwardPort(): number {
      return forwardPorts?.[0] ?? DASHBOARD_PORT;
    },

    get dashboard(): AgentDashboard {
      const d = (raw.dashboard as Partial<AgentDashboard>) || {};
      const kind: AgentDashboardKind = d.kind === "api" ? "api" : "ui";
      const defaultLabel = kind === "api" ? "API" : "UI";
      const normalizedLabel = typeof d.label === "string" ? d.label.trim() : "";
      const rawPath = typeof d.path === "string" ? d.path.trim() : "";
      const path = rawPath ? (rawPath.startsWith("/") ? rawPath : `/${rawPath}`) : "/";
      return {
        kind,
        label: normalizedLabel || defaultLabel,
        path,
      };
    },

    get configPaths(): AgentConfigPaths {
      return {
        immutableDir: readString(config ?? {}, "immutable_dir") ?? "/sandbox/.openclaw",
        writableDir: readString(config ?? {}, "writable_dir") ?? "/sandbox/.openclaw-data",
        configFile: readString(config ?? {}, "config_file") ?? "openclaw.json",
        envFile: readString(config ?? {}, "env_file") ?? null,
        format: readString(config ?? {}, "format") ?? "json",
      };
    },

    get stateDirs(): string[] {
      return stateDirs ?? [];
    },

    get versionCommand(): string {
      return versionCommand ?? `${binaryPath ?? "unknown"} --version`;
    },

    get expectedVersion(): string | null {
      return expectedVersion ?? null;
    },

    get hasDevicePairing(): boolean {
      return readBoolean(raw, "device_pairing") === true;
    },

    get phoneHomeHosts(): string[] {
      return phoneHomeHosts ?? [];
    },

    get messagingPlatforms(): string[] {
      return messagingPlatforms?.supported ?? [];
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
  const agents = listAgents().map((name) => {
    const agent = loadAgent(name);
    return {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description ?? "",
    };
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

  if (session?.agent) {
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
