// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface AgentConfigTarget {
  agentName: string;
  configPath: string;
  configDir: string;
  format: string;
  configFile: string;
  sensitiveFiles?: string[];
}

export const DEFAULT_AGENT_CONFIG: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

export function resolveAgentConfig(sandboxName: string): AgentConfigTarget {
  try {
    const registry = require("../state/registry");
    const entry = registry.getSandbox(sandboxName);
    if (!entry || !entry.agent) return DEFAULT_AGENT_CONFIG;

    const agentDefs = require("../agent/defs");
    const agent = agentDefs.loadAgent(entry.agent);
    const cfg = agent.configPaths;

    const dir = cfg.dir;
    const sensitiveFiles = [`${dir}/.config-hash`];
    if (entry.agent === "hermes") sensitiveFiles.push(`${dir}/.env`);

    return {
      agentName: entry.agent,
      configPath: `${dir}/${cfg.configFile}`,
      configDir: dir,
      format: cfg.format || "json",
      configFile: cfg.configFile,
      sensitiveFiles,
    };
  } catch {
    return DEFAULT_AGENT_CONFIG;
  }
}
