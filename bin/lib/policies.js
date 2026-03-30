// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { ROOT, run, runCapture, shellQuote } = require("./runner");
const registry = require("./registry");

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

function getOpenshellCommand() {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (!binary) return "openshell";
  return shellQuote(binary);
}

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
    hosts.push(match[1]);
  }
  return hosts;
}

/**
 * Extract just the network_policies entries (indented content under
 * the `network_policies:` key) from a preset file, stripping the
 * `preset:` metadata header.
 */
function extractPresetEntries(presetContent) {
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
  if (sep === -1) return raw;
  return raw.slice(sep + 3).trim();
}

/**
 * Build the openshell policy set command with properly quoted arguments.
 */
function buildPolicySetCommand(policyFile, sandboxName) {
  return `${getOpenshellCommand()} policy set --policy ${shellQuote(policyFile)} --wait ${shellQuote(sandboxName)}`;
}

/**
 * Build the openshell policy get command with properly quoted arguments.
 */
function buildPolicyGetCommand(sandboxName) {
  return `${getOpenshellCommand()} policy get --full ${shellQuote(sandboxName)} 2>/dev/null`;
}

/**
 * Merge preset entries into existing policy YAML. Handles versionless policies
 * by ensuring the merged result has a version header when the current policy
 * has content but no version field. Pure function for testing.
 *
 * @param {string} currentPolicy - Existing policy YAML (may be versionless)
 * @param {string} presetEntries - Indented network_policies entries from preset
 * @returns {string} Merged YAML with version header when missing
 */
function mergePresetIntoPolicy(currentPolicy, presetEntries) {
  if (!presetEntries) {
    return currentPolicy || "version: 1\n\nnetwork_policies:\n";
  }
  if (!currentPolicy) {
    return "version: 1\n\nnetwork_policies:\n" + presetEntries;
  }

  let merged;
  if (/^network_policies\s*:/m.test(currentPolicy)) {
    const lines = currentPolicy.split("\n");
    const result = [];
    let inNetworkPolicies = false;
    let inserted = false;

    for (const line of lines) {
      const isTopLevel = /^\S.*:/.test(line);

      if (/^network_policies\s*:/.test(line)) {
        inNetworkPolicies = true;
        result.push(line);
        continue;
      }

      if (inNetworkPolicies && isTopLevel && !inserted) {
        result.push(presetEntries);
        inserted = true;
        inNetworkPolicies = false;
      }

      result.push(line);
    }

    if (inNetworkPolicies && !inserted) {
      result.push(presetEntries);
    }

    merged = result.join("\n");
  } else {
    merged = currentPolicy.trimEnd() + "\n\nnetwork_policies:\n" + presetEntries;
  }

  if (!merged.trimStart().startsWith("version:")) {
    merged = "version: 1\n" + merged;
  }
  return merged;
}
function applyPreset(sandboxName, presetName) {
  // Guard against truncated sandbox names — WSL can truncate hyphenated
  // names during argument parsing, e.g. "my-assistant" → "m"
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
      `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`
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
    rawPolicy = runCapture(
      buildPolicyGetCommand(sandboxName),
      { ignoreError: true }
    );
  } catch { /* ignored */ }

  const currentPolicy = parseCurrentPolicy(rawPolicy);
  const merged = mergePresetIntoPolicy(currentPolicy, presetEntries);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(tmpFile, merged, { encoding: "utf-8", mode: 0o600 });

  try {
    run(buildPolicySetCommand(tmpFile, sandboxName));

    console.log(`  Applied preset: ${presetName}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignored */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignored */ }
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

module.exports = {
  PRESETS_DIR,
  listPresets,
  loadPreset,
  getPresetEndpoints,
  extractPresetEntries,
  parseCurrentPolicy,
  buildPolicySetCommand,
  buildPolicyGetCommand,
  mergePresetIntoPolicy,
  applyPreset,
  getAppliedPresets,
};
