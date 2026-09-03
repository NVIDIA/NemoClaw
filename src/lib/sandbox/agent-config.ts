// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { AgentDefinition, AgentStateLockPlan } from "../agent/definition-types";
import type { SandboxEntry } from "../state/registry/types";

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const SANDBOX_CONFIG_ROOT = "/sandbox/";

export interface AgentConfigTarget {
  agentName: string;
  configPath: string;
  configDir: string;
  format: string;
  configFile: string;
  sensitiveFiles?: string[];
  stateLockPlan?: AgentStateLockPlan;
  stateLockPlanInImage: boolean;
}

export interface AgentConfigDependencies {
  getSandbox: (name: string) => { agent?: string } | null;
  loadAgent: (name: string) => {
    configPaths: {
      dir: string;
      configFile: string;
      envFile?: string | null;
      format?: string;
      shieldsFiles: readonly string[];
    };
    stateLockPlan: AgentStateLockPlan;
    stateLockPlanInImage: boolean;
  };
}

export const DEFAULT_AGENT_CONFIG: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
  stateLockPlanInImage: true,
};

function defaultDependencies(): AgentConfigDependencies {
  const registry = require("../state/registry");
  const agentDefs = require("../agent/defs");
  return { getSandbox: registry.getSandbox, loadAgent: agentDefs.loadAgent };
}

export interface RegisteredSandboxAgentAuthority {
  readonly sandbox: SandboxEntry;
  readonly agent: AgentDefinition;
}

/** Resolve one exact registry entry together with its current manifest authority. */
export function resolveRegisteredSandboxAgentAuthority(
  sandboxName: string,
): RegisteredSandboxAgentAuthority {
  const registry: typeof import("../state/registry") = require("../state/registry");
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox || sandbox.name !== sandboxName || !sandbox.agent) {
    throw new Error(`Sandbox '${sandboxName}' has no exact registered agent-definition authority`);
  }
  const agent = resolveCurrentAgentDefinition(sandbox.agent);
  if (agent.name !== sandbox.agent) {
    throw new Error(
      `Sandbox '${sandboxName}' agent-definition authority changed during resolution`,
    );
  }
  return Object.freeze({ sandbox, agent });
}

/** Load the current manifest without exposing the high-fan-in definition facade. */
export function resolveCurrentAgentDefinition(agentName: string): AgentDefinition {
  const agentDefs: typeof import("../agent/defs") = require("../agent/defs");
  return agentDefs.loadAgent(agentName);
}

export function resolveAgentStateLockContract(
  agentName: string,
  loadAgent: AgentConfigDependencies["loadAgent"] = defaultDependencies().loadAgent,
): Pick<AgentConfigTarget, "stateLockPlan" | "stateLockPlanInImage"> {
  const agent = loadAgent(agentName);
  return {
    stateLockPlan: agent.stateLockPlan,
    stateLockPlanInImage: agent.stateLockPlanInImage,
  };
}

function requireCanonicalConfigDir(value: string): string {
  if (
    !path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    CONTROL_CHAR_RE.test(value) ||
    value.includes("\\") ||
    value === SANDBOX_CONFIG_ROOT ||
    !value.startsWith(SANDBOX_CONFIG_ROOT)
  ) {
    throw new Error(
      `Agent config directory ${JSON.stringify(value)} must be a canonical absolute path below ${SANDBOX_CONFIG_ROOT}`,
    );
  }
  return value;
}

function resolveConfigFile(configDir: string, value: string, field: string): string {
  const components = value.split("/");
  if (
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    CONTROL_CHAR_RE.test(value) ||
    value.includes("\\") ||
    components.some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`Agent config field '${field}' must be a canonical relative path`);
  }
  const resolved = path.posix.resolve(configDir, value);
  if (!resolved.startsWith(`${configDir}/`)) {
    throw new Error(`Agent config field '${field}' must stay below '${configDir}'`);
  }
  return resolved;
}

export function resolveAgentConfig(
  sandboxName: string,
  dependencies: AgentConfigDependencies = defaultDependencies(),
): AgentConfigTarget {
  const entry = dependencies.getSandbox(sandboxName);
  const agentName = entry?.agent ?? DEFAULT_AGENT_CONFIG.agentName;
  const agent = dependencies.loadAgent(agentName);
  const cfg = agent.configPaths;

  const dir = requireCanonicalConfigDir(cfg.dir);
  const configPath = resolveConfigFile(dir, cfg.configFile, "config_file");
  const sensitiveFiles = [resolveConfigFile(dir, ".config-hash", "config hash")];
  if (cfg.envFile !== undefined && cfg.envFile !== null) {
    resolveConfigFile(dir, cfg.envFile, "env_file");
  }
  if (
    !Array.isArray(cfg.shieldsFiles) ||
    cfg.shieldsFiles.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Agent manifest field 'config.shields_files' must be a string array");
  }
  if (agentName !== "hermes" && cfg.shieldsFiles.length > 0) {
    throw new Error(
      `Agent '${agentName}' declares config.shields_files, but protected top-level config files are currently supported only for Hermes`,
    );
  }
  for (const [index, shieldsFile] of cfg.shieldsFiles.entries()) {
    const resolved = resolveConfigFile(dir, shieldsFile, `shields_files[${String(index)}]`);
    if (resolved === configPath || sensitiveFiles.includes(resolved)) {
      throw new Error(
        `Agent config field 'shields_files[${String(index)}]' duplicates a protected config file`,
      );
    }
    sensitiveFiles.push(resolved);
  }

  return {
    agentName,
    configPath,
    configDir: dir,
    format: cfg.format || "json",
    configFile: cfg.configFile,
    sensitiveFiles,
    stateLockPlan: agent.stateLockPlan,
    stateLockPlanInImage: agent.stateLockPlanInImage,
  };
}
