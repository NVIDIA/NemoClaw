// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side sandbox configuration management.
//
// All config commands are agent-aware: the sandbox registry records which
// agent runs in each sandbox (openclaw, hermes, etc.), and agent-defs.ts
// provides the per-agent config paths and formats. This module resolves
// those at runtime so the same CLI surface works for any agent.
//
// config get:          Read-only inspection with credential redaction.

const { validateName } = require("./runner");
const credentialFilter: typeof import("./credential-filter") = require("./credential-filter");
const { stripCredentials, isConfigObject } = credentialFilter;

type ConfigObject = import("./credential-filter").ConfigObject;
type ConfigValue = import("./credential-filter").ConfigValue;
const { captureOpenshellCommand } = require("./openshell");

// ---------------------------------------------------------------------------
// Agent-aware config resolution
//
// Each agent defines its own config layout in agents/*/manifest.yaml:
//   - openclaw: /sandbox/.openclaw/openclaw.json  (JSON)
//   - hermes:   /sandbox/.hermes/config.yaml      (YAML)
//
// resolveAgentConfig() looks up the sandbox's agent from the registry,
// loads the agent definition, and returns the paths and format needed
// to read/write that agent's config from the host.
// ---------------------------------------------------------------------------

interface AgentConfigTarget {
  /** Agent name (e.g. "openclaw", "hermes") */
  agentName: string;
  /** Absolute path inside sandbox to the config file */
  configPath: string;
  /** Directory containing the config (for chown after cp) */
  configDir: string;
  /** Config file format: "json" or "yaml" */
  format: string;
  /** Config file basename */
  configFile: string;
  /** Additional files to lock/unlock alongside the main config (e.g. .env, .config-hash) */
  sensitiveFiles?: string[];
}

const DEFAULT_AGENT_CONFIG: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

function resolveAgentConfig(sandboxName: string): AgentConfigTarget {
  try {
    const registry = require("./registry");
    const entry = registry.getSandbox(sandboxName);
    if (!entry || !entry.agent) return DEFAULT_AGENT_CONFIG;

    const agentDefs = require("./agent-defs");
    const agent = agentDefs.loadAgent(entry.agent);
    const cfg = agent.configPaths;

    const dir = cfg.dir;
    const sensitiveFiles = [`${dir}/.config-hash`];
    // Hermes stores credentials in .env alongside the config
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
    // Registry or agent-defs unavailable (e.g., during tests) — fall back
    return DEFAULT_AGENT_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOpenshellBinary(): string {
  return process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
}

function extractDotpath(obj: ConfigValue, dotpath: string): ConfigValue | undefined {
  const keys = dotpath.split(".");
  let current: ConfigValue = obj;
  for (const key of keys) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (!isConfigObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Parse a config file's raw text according to its format.
 */
function parseConfig(raw: string, format: string): ConfigObject {
  const parsed = format === "yaml" ? require("yaml").parse(raw) : JSON.parse(raw);
  if (!isConfigObject(parsed)) {
    throw new Error("Config is not an object.");
  }
  return parsed;
}

/**
 * Read the agent's config from a running sandbox.
 * Resolves the correct config path based on the agent type.
 */
function readSandboxConfig(sandboxName: string, target: AgentConfigTarget): ConfigObject {
  const binary = getOpenshellBinary();
  let raw: string;
  try {
    const result = captureOpenshellCommand(
      binary,
      ["sandbox", "exec", "--name", sandboxName, "--", "cat", target.configPath],
      { ignoreError: true, errorLine: console.error, exit: (code: number) => process.exit(code) },
    );
    raw = result.output || "";
  } catch {
    raw = "";
  }

  if (!raw || !raw.trim()) {
    console.error(`  Cannot read ${target.agentName} config (${target.configPath}).`);
    console.error("  Is the sandbox running?");
    process.exit(1);
  }

  try {
    return parseConfig(raw, target.format);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to parse ${target.agentName} config: ${message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------

interface ConfigGetOpts {
  key?: string | null;
  format?: string;
}

function configGet(sandboxName: string, opts: ConfigGetOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  const target = resolveAgentConfig(sandboxName);
  let config: ConfigValue = stripCredentials(readSandboxConfig(sandboxName, target));

  // Remove gateway section for openclaw (contains auth tokens)
  if (isConfigObject(config)) {
    delete config.gateway;
  }

  // Extract dotpath if specified
  if (opts.key) {
    const value = extractDotpath(config, opts.key);
    if (value === undefined) {
      console.error(`  Key "${opts.key}" not found in ${target.agentName} config.`);
      process.exit(1);
    }
    config = value;
  }

  // Format output — default to the agent's native format
  const outputFormat = opts.format || target.format;
  if (outputFormat === "yaml") {
    const YAML = require("yaml");
    console.log(YAML.stringify(config));
  } else {
    console.log(JSON.stringify(config, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  DEFAULT_AGENT_CONFIG,
  configGet,
  resolveAgentConfig,
  readSandboxConfig,
  extractDotpath,
  parseConfig,
};
