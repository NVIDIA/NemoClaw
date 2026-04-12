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
const { ROOT, run, runCapture, shellQuote } = require("./runner");
const registry = require("./registry");
const { loadAgent } = require("./agent-defs");

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
    hosts.push(match[1].replace(/^["']|["']$/g, ""));
  }
  return hosts;
}

function extractPresetEntries(presetContent) {
  if (!presetContent) return null;
  const npMatch = presetContent.match(/^network_policies:\n([\s\S]*)$/m);
  if (!npMatch) return null;
  return npMatch[1].trimEnd();
}

function normalizePolicyCandidate(raw) {
  if (!raw) return "";
  const sep = raw.indexOf("---");
  return (sep === -1 ? raw : raw.slice(sep + 3)).trim();
}

function isLikelyPolicyYaml(candidate) {
  if (!candidate) return false;
  if (/^(error|failed|invalid|warning|status)\b/i.test(candidate)) {
    return false;
  }
  return /^[a-z_][a-z0-9_]*\s*:/m.test(candidate);
}

function parseCurrentPolicy(raw) {
  const candidate = normalizePolicyCandidate(raw);
  if (!isLikelyPolicyYaml(candidate)) {
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

function buildPolicySetCommand(policyFile, sandboxName) {
  return `${getOpenshellCommand()} policy set --policy ${shellQuote(policyFile)} --wait ${shellQuote(sandboxName)}`;
}

function buildPolicyGetCommand(sandboxName) {
  return `${getOpenshellCommand()} policy get --full ${shellQuote(sandboxName)} 2>/dev/null`;
}

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

function parsePresetPolicies(presetEntries) {
  try {
    const wrapped = "network_policies:\n" + presetEntries;
    const parsed = YAML.parse(wrapped);
    return parsed?.network_policies;
  } catch {
    return null;
  }
}

function parsePolicyYamlOrFallback(currentPolicy, presetEntries) {
  try {
    const current = YAML.parse(currentPolicy);
    return current && typeof current === "object" ? current : {};
  } catch {
    return textBasedMerge(currentPolicy, presetEntries);
  }
}

function mergeNetworkPolicies(current, presetPolicies) {
  const existingNp = current.network_policies;
  if (existingNp && typeof existingNp === "object" && !Array.isArray(existingNp)) {
    return { ...existingNp, ...presetPolicies };
  }
  return presetPolicies;
}

function buildMergedPolicyOutput(current, mergedNp) {
  const output = { version: current.version || 1 };
  for (const [key, val] of Object.entries(current)) {
    if (key !== "version" && key !== "network_policies") {
      output[key] = val;
    }
  }
  output.network_policies = mergedNp;
  return YAML.stringify(output);
}

function mergePresetIntoPolicy(currentPolicy, presetEntries) {
  const normalizedCurrentPolicy = parseCurrentPolicy(currentPolicy);
  if (!presetEntries) {
    return normalizedCurrentPolicy || "version: 1\n\nnetwork_policies:\n";
  }

  const presetPolicies = parsePresetPolicies(presetEntries);
  if (!presetPolicies || typeof presetPolicies !== "object" || Array.isArray(presetPolicies)) {
    return textBasedMerge(normalizedCurrentPolicy, presetEntries);
  }

  if (!normalizedCurrentPolicy) {
    return YAML.stringify({ version: 1, network_policies: presetPolicies });
  }

  const current = parsePolicyYamlOrFallback(normalizedCurrentPolicy, presetEntries);
  if (typeof current === "string") {
    return current;
  }

  const mergedNp = mergeNetworkPolicies(current, presetPolicies);
  return buildMergedPolicyOutput(current, mergedNp);
}

function validateSandboxName(sandboxName) {
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
        `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`,
    );
  }
}

function readCurrentPolicy(sandboxName) {
  try {
    return runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {
    return "";
  }
}

function writeMergedPolicyFile(merged) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(tmpFile, merged, { encoding: "utf-8", mode: 0o600 });
  return { tmpDir, tmpFile };
}

function cleanupPolicyTempFile(tmpDir, tmpFile) {
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

function updateSandboxPolicies(sandboxName, presetName) {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return;
  const pols = sandbox.policies || [];
  if (!pols.includes(presetName)) {
    pols.push(presetName);
  }
  registry.updateSandbox(sandboxName, { policies: pols });
}

function applyPreset(sandboxName, presetName) {
  validateSandboxName(sandboxName);

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

  const currentPolicy = parseCurrentPolicy(readCurrentPolicy(sandboxName));
  const merged = mergePresetIntoPolicy(currentPolicy, presetEntries);

  const endpoints = getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Widening sandbox egress — adding: ${endpoints.join(", ")}`);
  }

  const { tmpDir, tmpFile } = writeMergedPolicyFile(merged);
  try {
    run(buildPolicySetCommand(tmpFile, sandboxName));
    console.log(`  Applied preset: ${presetName}`);
  } finally {
    cleanupPolicyTempFile(tmpDir, tmpFile);
  }

  updateSandboxPolicies(sandboxName, presetName);
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
  validateSandboxName(sandboxName);

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
  applyPreset,
  applyPermissivePolicy,
  getAppliedPresets,
  selectFromList,
};
