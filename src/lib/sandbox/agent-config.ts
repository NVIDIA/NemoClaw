// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const SANDBOX_CONFIG_ROOT = "/sandbox/";

export interface AgentConfigTarget {
  agentName: string;
  configPath: string;
  configDir: string;
  format: string;
  configFile: string;
  sensitiveFiles?: string[];
}

export interface AgentConfigDependencies {
  getSandbox: (name: string) => { agent?: string } | null;
  loadAgent: (name: string) => {
    configPaths: {
      dir: string;
      configFile: string;
      envFile?: string | null;
      format?: string;
    };
  };
}

export const DEFAULT_AGENT_CONFIG: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

function defaultDependencies(): AgentConfigDependencies {
  const registry = require("../state/registry");
  const agentDefs = require("../agent/defs");
  return { getSandbox: registry.getSandbox, loadAgent: agentDefs.loadAgent };
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
    sensitiveFiles.push(resolveConfigFile(dir, cfg.envFile, "env_file"));
  }

  return {
    agentName,
    configPath,
    configDir: dir,
    format: cfg.format || "json",
    configFile: cfg.configFile,
    sensitiveFiles,
  };
}
