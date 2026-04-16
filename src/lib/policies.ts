// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const YAML = require("yaml");
const { ROOT, run, runCapture } = require("./runner");
const registry = require("./registry");
const { loadAgent } = require("./agent-defs");

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

function listPresets() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs
    .readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const content = fs.readFileSync(path.join(PRESETS_DIR, f), "utf-8");
      const nameMatch = content.match(/^\s*name:\s*(.+)$/m);
      const descMatch = content.match(/^\s*description:\s*"?([^"]*)"?$/m);
      return {
        file: f,
        name: nameMatch ? nameMatch[1].trim() : f.replace(".yaml", ""),
        description: descMatch ? descMatch[1].trim() : "",
      };
    });
}

function loadPreset(name) {
  const file = path.resolve(PRESETS_DIR, `${name}.yaml`);
  if (!file.startsWith(PRESETS_DIR + path.sep) && file !== PRESETS_DIR) {
    console.error(`  Invalid preset name: ${name}`);
    return null;
  }
  if (!fs.existsSync(file)) {
    console.error(`  Preset not found: ${name}`);
    return null;
  }
  return fs.readFileSync(file, "utf-8");
}

function getPresetEndpoints(content) {
  const hosts = [];
  const regex = /host:\s*([^\s,}]+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    hosts.push(match[1].replace(/^["']|["']$/g, ""));
  }
  return hosts;
}

/**
 * Extract just the network_policies entries (indented content under
 * the `network_policies:` key) from a preset file, stripping the
 * `preset:` metadata header.
 */
function extractPresetEntries(presetContent) {
  if (!presetContent) return null;
  const npMatch = presetContent.match(/^network_policies:\n([\s\S]*)$/m);
  if (!npMatch) return null;
  return npMatch[1].trimEnd();
}

/**
 * Parse the output of `openshell policy get --full` which has a metadata
 * header (Version, Hash, etc.) followed by `---` and then the actual YAML.
 */
function parseCurrentPolicy(raw) {
  if (!raw) return "";
  const sep = raw.indexOf("---");
  const candidate = (sep === -1 ? raw : raw.slice(sep + 3)).trim();
  if (!candidate) return "";
  if (/^(error|failed|invalid|warning|status)\b/i.test(candidate)) {
    return "";
  }
  if (!/^[a-z_][a-z0-9_]*\s*:/m.test(candidate)) {
    return "";
  }
  try {
    const parsed = YAML.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "";
    }
  } catch {
    return "";
  }
  return candidate;
}

/**
 * Build the openshell policy set command as an argv array.
 */
function buildPolicySetCommand(policyFile, sandboxName) {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
  return [binary, "policy", "set", "--policy", policyFile, "--wait", sandboxName];
}

/**
 * Build the openshell policy get command as an argv array.
 */
function buildPolicyGetCommand(sandboxName) {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
  return [binary, "policy", "get", "--full", sandboxName];
}

/**
 * Text-based fallback for merging preset entries into policy YAML.
 * Used when preset entries cannot be parsed as structured YAML.
 */
function textBasedMerge(currentPolicy, presetEntries) {
  if (!currentPolicy) {
    return "version: 1\n\nnetwork_policies:\n" + presetEntries;
  }
  let merged;
  if (/^network_policies\s*:/m.test(currentPolicy)) {
    const lines = currentPolicy.split("\n");
    const result = [];
    let inNp = false;
    let inserted = false;
    for (const line of lines) {
      if (/^network_policies\s*:/.test(line)) {
        inNp = true;
        result.push(line);
        continue;
      }
      if (inNp && /^\S.*:/.test(line) && !inserted) {
        result.push(presetEntries);
        inserted = true;
        inNp = false;
      }
      result.push(line);
    }
    if (inNp && !inserted) result.push(presetEntries);
    merged = result.join("\n");
  } else {
    merged = currentPolicy.trimEnd() + "\n\nnetwork_policies:\n" + presetEntries;
  }
  if (!merged.trimStart().startsWith("version:")) merged = "version: 1\n\n" + merged;
  return merged;
}

/**
 * Merge preset entries into existing policy YAML using structured YAML
 * parsing. Replaces the previous text-based manipulation which could
 * produce invalid YAML when indentation or ordering varied.
 *
 * Behavior:
 *   - Parses both current policy and preset entries as YAML
 *   - Merges network_policies by name (preset overrides on collision)
 *   - Preserves all non-network sections (filesystem_policy, process, etc.)
 *   - Ensures version: 1 exists
 *
 * @param {string} currentPolicy - Existing policy YAML (may be empty/versionless)
 * @param {string} presetEntries - Indented network_policies entries from preset
 * @returns {string} Merged YAML
 */
function mergePresetIntoPolicy(currentPolicy, presetEntries) {
  const normalizedCurrentPolicy = parseCurrentPolicy(currentPolicy);
  if (!presetEntries) {
    return normalizedCurrentPolicy || "version: 1\n\nnetwork_policies:\n";
  }

  // Parse preset entries. They come as indented content under network_policies:,
  // so we wrap them to make valid YAML for parsing.
  let presetPolicies;
  try {
    const wrapped = "network_policies:\n" + presetEntries;
    const parsed = YAML.parse(wrapped);
    presetPolicies = parsed?.network_policies;
  } catch {
    presetPolicies = null;
  }

  // If YAML parsing failed or entries are not a mergeable object,
  // fall back to the text-based approach for backward compatibility.
  if (!presetPolicies || typeof presetPolicies !== "object" || Array.isArray(presetPolicies)) {
    return textBasedMerge(normalizedCurrentPolicy, presetEntries);
  }

  if (!normalizedCurrentPolicy) {
    return YAML.stringify({ version: 1, network_policies: presetPolicies });
  }

  // Parse the current policy as structured YAML
  let current;
  try {
    current = YAML.parse(normalizedCurrentPolicy);
  } catch {
    return textBasedMerge(normalizedCurrentPolicy, presetEntries);
  }

  if (!current || typeof current !== "object") current = {};

  // Structured merge: preset entries override existing on name collision.
  // Guard: network_policies may be an array in legacy policies — only
  // object-merge when both sides are plain objects.
  const existingNp = current.network_policies;
  let mergedNp;
  if (existingNp && typeof existingNp === "object" && !Array.isArray(existingNp)) {
    mergedNp = { ...existingNp, ...presetPolicies };
  } else {
    mergedNp = presetPolicies;
  }

  const output = { version: current.version || 1 };
  for (const [key, val] of Object.entries(current)) {
    if (key !== "version" && key !== "network_policies") output[key] = val;
  }
  output.network_policies = mergedNp;

  return YAML.stringify(output);
}

/**
 * Remove preset entries from existing policy YAML using structured YAML
 * parsing. Identifies which network_policies keys belong to the preset,
 * removes them, and returns the resulting YAML.
 *
 * @param {string} currentPolicy - Existing policy YAML
 * @param {string} presetEntries - Indented network_policies entries from preset
 * @returns {string} Policy YAML with the preset's entries removed
 */
function removePresetFromPolicy(currentPolicy, presetEntries) {
  const normalizedCurrentPolicy = parseCurrentPolicy(currentPolicy);
  if (!presetEntries) {
    return normalizedCurrentPolicy || "version: 1\n\nnetwork_policies:\n";
  }

  if (!normalizedCurrentPolicy) return "version: 1\n\nnetwork_policies:\n";

  // Parse preset entries to extract the network_policies key names.
  // They come as indented content under network_policies:,
  // so we wrap them to make valid YAML for parsing.
  let presetKeys;
  try {
    const wrapped = "network_policies:\n" + presetEntries;
    const parsed = YAML.parse(wrapped);
    presetKeys = parsed?.network_policies
      ? Object.keys(parsed.network_policies)
      : [];
  } catch {
    presetKeys = [];
  }

  if (presetKeys.length === 0) return normalizedCurrentPolicy;

  // Parse the current policy as structured YAML
  let current;
  try {
    current = YAML.parse(normalizedCurrentPolicy);
  } catch {
    return normalizedCurrentPolicy;
  }

  if (!current || typeof current !== "object") return normalizedCurrentPolicy;

  // Guard: network_policies may be an array in legacy policies — only
  // delete keys when it is a plain object.
  const existingNp = current.network_policies;
  if (!existingNp || typeof existingNp !== "object" || Array.isArray(existingNp)) {
    return normalizedCurrentPolicy;
  }

  for (const key of presetKeys) {
    delete existingNp[key];
  }

  current.network_policies = existingNp;
  return YAML.stringify(current);
}

function removePreset(sandboxName, presetName) {
  // Guard against truncated sandbox names — WSL can truncate hyphenated
  // names during argument parsing, e.g. "my-assistant" → "m"
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
        `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`,
    );
  }

  const presetContent = loadPreset(presetName);
  if (!presetContent) {
    console.error(`  Cannot load preset: ${presetName}`);
    return false;
  }

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }

  // Get current policy YAML from sandbox
  let rawPolicy = "";
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {
    /* ignored */
  }

  const currentPolicy = parseCurrentPolicy(rawPolicy);
  if (!currentPolicy) {
    console.error(`  Could not read current policy for sandbox '${sandboxName}'.`);
    return false;
  }

  const updated = removePresetFromPolicy(currentPolicy, presetEntries);

  if (updated === currentPolicy) {
    console.error(`  Preset '${presetName}' could not be removed from the current policy.`);
    return false;
  }

  const endpoints = getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Narrowing sandbox egress — removing: ${endpoints.join(", ")}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(tmpFile, updated, { encoding: "utf-8", mode: 0o600 });

  try {
    run(buildPolicySetCommand(tmpFile, sandboxName));
    console.log(`  Removed preset: ${presetName}`);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignored */
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignored */
    }
  }

  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    const pols = (sandbox.policies || []).filter((p) => p !== presetName);
    registry.updateSandbox(sandboxName, { policies: pols });
  }

  return true;
}

function selectForRemoval(items, { applied = [] } = {}) {
  return new Promise((resolve) => {
    const appliedItems = items.filter((item) => applied.includes(item.name));
    if (appliedItems.length === 0) {
      process.stderr.write("\n  No presets are currently applied.\n\n");
      resolve(null);
      return;
    }
    process.stderr.write("\n  Applied presets:\n");
    appliedItems.forEach((item, i) => {
      const description = item.description ? ` — ${item.description}` : "";
      process.stderr.write(`    ${i + 1}) ${item.name}${description}\n`);
    });
    process.stderr.write("\n");
    const question = "  Choose preset to remove: ";
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      if (!process.stdin.isTTY) {
        if (typeof process.stdin.pause === "function") process.stdin.pause();
        if (typeof process.stdin.unref === "function") process.stdin.unref();
      }
      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      if (!/^\d+$/.test(trimmed)) {
        process.stderr.write("\n  Invalid preset number.\n");
        resolve(null);
        return;
      }
      const num = Number(trimmed);
      const item = appliedItems[num - 1];
      if (!item) {
        process.stderr.write("\n  Invalid preset number.\n");
        resolve(null);
        return;
      }
      resolve(item.name);
    });
  });
}

function applyPreset(sandboxName, presetName, _options = {}) {
  // Guard against truncated sandbox names — WSL can truncate hyphenated
  // names during argument parsing, e.g. "my-assistant" → "m"
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
        `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`,
    );
  }

  const presetContent = loadPreset(presetName);
  if (!presetContent) {
    console.error(`  Cannot load preset: ${presetName}`);
    return false;
  }

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }

  // Get current policy YAML from sandbox
  let rawPolicy = "";
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {
    /* ignored */
  }

  const currentPolicy = parseCurrentPolicy(rawPolicy);
  const merged = mergePresetIntoPolicy(currentPolicy, presetEntries);

  const endpoints = getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Widening sandbox egress — adding: ${endpoints.join(", ")}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(tmpFile, merged, { encoding: "utf-8", mode: 0o600 });

  try {
    run(buildPolicySetCommand(tmpFile, sandboxName));

    console.log(`  Applied preset: ${presetName}`);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignored */
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignored */
    }
  }

  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    const pols = sandbox.policies || [];
    if (!pols.includes(presetName)) {
      pols.push(presetName);
    }
    registry.updateSandbox(sandboxName, { policies: pols });
  }

  return true;
}

function getAppliedPresets(sandboxName) {
  const sandbox = registry.getSandbox(sandboxName);
  return sandbox ? sandbox.policies || [] : [];
}

function selectFromList(items, { applied = [] } = {}) {
  return new Promise((resolve) => {
    process.stderr.write("\n  Available presets:\n");
    items.forEach((item, i) => {
      const marker = applied.includes(item.name) ? "●" : "○";
      const description = item.description ? ` — ${item.description}` : "";
      process.stderr.write(`    ${i + 1}) ${marker} ${item.name}${description}\n`);
    });
    process.stderr.write("\n  ● applied, ○ not applied\n\n");
    const defaultIdx = items.findIndex((item) => !applied.includes(item.name));
    const defaultNum = defaultIdx >= 0 ? defaultIdx + 1 : null;
    const question = defaultNum ? `  Choose preset [${defaultNum}]: ` : "  Choose preset: ";
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      if (!process.stdin.isTTY) {
        if (typeof process.stdin.pause === "function") process.stdin.pause();
        if (typeof process.stdin.unref === "function") process.stdin.unref();
      }
      const trimmed = answer.trim();
      const effectiveInput = trimmed || (defaultNum ? String(defaultNum) : "");
      if (!effectiveInput) {
        resolve(null);
        return;
      }
      if (!/^\d+$/.test(effectiveInput)) {
        process.stderr.write("\n  Invalid preset number.\n");
        resolve(null);
        return;
      }
      const num = Number(effectiveInput);
      const item = items[num - 1];
      if (!item) {
        process.stderr.write("\n  Invalid preset number.\n");
        resolve(null);
        return;
      }
      if (applied.includes(item.name)) {
        process.stderr.write(`\n  Preset '${item.name}' is already applied.\n`);
        resolve(null);
        return;
      }
      resolve(item.name);
    });
  });
}

const PERMISSIVE_POLICY_PATH = path.join(
  ROOT,
  "nemoclaw-blueprint",
  "policies",
  "openclaw-sandbox-permissive.yaml",
);

function resolvePermissivePolicyPath(sandboxName) {
  // Use agent-specific permissive policy if the sandbox has an agent with one.
  try {
    const sandbox = registry.getSandbox(sandboxName);
    if (sandbox?.agent && sandbox.agent !== "openclaw") {
      const agent = loadAgent(sandbox.agent);
      if (agent?.policyPermissivePath) return agent.policyPermissivePath;
    }
    if (sandbox?.agent === "openclaw") {
      const agent = loadAgent("openclaw");
      if (agent?.policyPermissivePath) return agent.policyPermissivePath;
    }
  } catch {
    // Fall through to global permissive policy
  }
  return PERMISSIVE_POLICY_PATH;
}

function applyPermissivePolicy(sandboxName) {
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
        `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`,
    );
  }

  const policyPath = resolvePermissivePolicyPath(sandboxName);
  if (!fs.existsSync(policyPath)) {
    throw new Error(`Permissive policy not found: ${policyPath}`);
  }

  console.log("  Applying permissive policy (--dangerously-skip-permissions)...");
  run(buildPolicySetCommand(policyPath, sandboxName));
  console.log("  Applied permissive policy.");

  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    registry.updateSandbox(sandboxName, { dangerouslySkipPermissions: true });
  }
}

export {
  PRESETS_DIR,
  PERMISSIVE_POLICY_PATH,
  listPresets,
  loadPreset,
  getPresetEndpoints,
  extractPresetEntries,
  parseCurrentPolicy,
  buildPolicySetCommand,
  buildPolicyGetCommand,
  mergePresetIntoPolicy,
  removePresetFromPolicy,
  applyPreset,
  removePreset,
  applyPermissivePolicy,
  getAppliedPresets,
  selectFromList,
  selectForRemoval,
};
