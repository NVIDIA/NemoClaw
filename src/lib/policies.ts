// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

import type { JsonValue, JsonObject } from "./json-types";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const YAML = require("yaml");
const { ROOT, run, runCapture } = require("./runner");
const registry = require("./registry");
const { loadAgent } = require("./agent-defs");

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

type PresetInfo = {
  file: string;
  name: string;
  description: string;
};

// Re-use shared JSON types under policy-domain names.
type PolicyValue = JsonValue;
type PolicyObject = JsonObject;

type PolicyDocument = PolicyObject & {
  version?: number;
  network_policies?: PolicyObject;
};

type SelectionOptions = {
  applied?: string[];
};

function isPolicyDocument(value: PolicyValue): value is PolicyDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Enumerate every preset YAML under `nemoclaw-blueprint/policies/presets/`
 * and return `{ file, name, description }` triples parsed from the file's
 * `preset:` header.
 */
function listPresets(): PresetInfo[] {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs
    .readdirSync(PRESETS_DIR)
    .filter((f: string) => f.endsWith(".yaml"))
    .map((f: string) => {
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

/**
 * Read a built-in preset by short name from `PRESETS_DIR`. Guards against
 * path traversal and returns `null` if the preset does not exist.
 */
function loadPreset(name: string): string | null {
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

/**
 * Extract the bare hostnames declared in a preset YAML (anything matched by
 * `host: <value>`), with surrounding quotes stripped. Used to show the
 * "endpoints that would be opened" preview before applying a preset.
 */
function getPresetEndpoints(content: string): string[] {
  const hosts: string[] = [];
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
function extractPresetEntries(presetContent: string | null | undefined): string | null {
  if (!presetContent) return null;
  const npMatch = presetContent.match(/^network_policies:\n([\s\S]*)$/m);
  if (!npMatch) return null;
  return npMatch[1].trimEnd();
}

/**
 * Parse the output of `openshell policy get --full` which has a metadata
 * header (Version, Hash, etc.) followed by `---` and then the actual YAML.
 */
function parseCurrentPolicy(raw: string | null | undefined): string {
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
function buildPolicySetCommand(policyFile: string, sandboxName: string): string[] {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
  return [binary, "policy", "set", "--policy", policyFile, "--wait", sandboxName];
}

/**
 * Build the openshell policy get command as an argv array.
 */
function buildPolicyGetCommand(sandboxName: string): string[] {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
  return [binary, "policy", "get", "--full", sandboxName];
}

/**
 * Text-based fallback for merging preset entries into policy YAML.
 * Used when preset entries cannot be parsed as structured YAML.
 */
function textBasedMerge(currentPolicy: string, presetEntries: string): string {
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
function mergePresetIntoPolicy(currentPolicy: string, presetEntries: string): string {
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
  let current: PolicyDocument | null;
  try {
    const parsed = YAML.parse(normalizedCurrentPolicy);
    current = isPolicyDocument(parsed) ? parsed : {};
  } catch {
    return textBasedMerge(normalizedCurrentPolicy, presetEntries);
  }

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

  const output: PolicyDocument = { version: Number(current.version) || 1 };
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
 * @param {string | null | undefined} presetEntries - Indented network_policies entries from preset
 * @returns {string} Policy YAML with the preset's entries removed
 */
function removePresetFromPolicy(
  currentPolicy: string,
  presetEntries: string | null | undefined,
): string {
  const normalizedCurrentPolicy = parseCurrentPolicy(currentPolicy);
  if (!presetEntries) {
    return normalizedCurrentPolicy || "version: 1\n\nnetwork_policies:\n";
  }

  if (!normalizedCurrentPolicy) return "version: 1\n\nnetwork_policies:\n";

  // Parse preset entries to extract the network_policies key names.
  // They come as indented content under network_policies:,
  // so we wrap them to make valid YAML for parsing.
  let presetKeys: string[];
  try {
    const wrapped = "network_policies:\n" + presetEntries;
    const parsed = YAML.parse(wrapped);
    presetKeys = parsed?.network_policies ? Object.keys(parsed.network_policies) : [];
  } catch {
    presetKeys = [];
  }

  if (presetKeys.length === 0) return normalizedCurrentPolicy;

  // Parse the current policy as structured YAML
  let current: PolicyDocument | null;
  try {
    const parsed = YAML.parse(normalizedCurrentPolicy);
    current = isPolicyDocument(parsed) ? parsed : null;
  } catch {
    return normalizedCurrentPolicy;
  }

  if (!current) return normalizedCurrentPolicy;

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

/**
 * Remove a previously-applied preset from the running sandbox policy and
 * delete its name from the registry entry. Resolves the preset's content
 * from the built-in presets directory first, then from the registry's
 * `customPolicies` list for presets applied via `--from-file`/`--from-dir`.
 * Returns `false` if the preset is unknown or has no `network_policies`
 * section.
 */
function removePreset(sandboxName: string, presetName: string): boolean {
  // Guard against truncated sandbox names — WSL can truncate hyphenated
  // names during argument parsing, e.g. "my-assistant" → "m"
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
        `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`,
    );
  }

  // Resolve preset content: built-in first, then custom presets persisted
  // in the registry. `isCustom` controls which registry bucket to prune on
  // success.
  let presetContent: string | null = loadPreset(presetName);
  let isCustom = false;
  if (!presetContent) {
    const custom = registry
      .getCustomPolicies(sandboxName)
      .find((p: { name: string }) => p.name === presetName);
    if (custom) {
      presetContent = custom.content;
      isCustom = true;
    }
  }
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
    if (isCustom) {
      registry.removeCustomPolicyByName(sandboxName, presetName);
    } else {
      const pols = (sandbox.policies || []).filter((p: string) => p !== presetName);
      registry.updateSandbox(sandboxName, { policies: pols });
    }
  }

  return true;
}

/**
 * Interactive preset picker for the `policy-remove` command. Prompts on
 * stderr and resolves to the chosen preset name, or `null` if the user
 * cancels or enters an invalid selection.
 */
function selectForRemoval(
  items: PresetInfo[],
  { applied = [] }: SelectionOptions = {},
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
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
    // Re-attach stdin to the event loop — unref() on exit is sticky and
    // would otherwise leave a follow-up prompt waiting on a detached handle.
    if (typeof process.stdin.ref === "function") process.stdin.ref();
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer: string) => {
      rl.close();
      // pause+unref so the process exits naturally after the last prompt.
      // The matching ref() above keeps subsequent prompts working.
      if (typeof process.stdin.pause === "function") process.stdin.pause();
      if (typeof process.stdin.unref === "function") process.stdin.unref();
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

/**
 * Apply raw preset content (already loaded in memory) to a running sandbox.
 * Validates the sandbox name, extracts the `network_policies` entries, merges
 * them into the sandbox's current policy, runs `openshell policy set --wait`,
 * and records the preset name in the registry. Returns `false` if the content
 * has no `network_policies` section. Used by both `applyPreset` (built-in
 * presets) and the `--from-file` / `--from-dir` paths (custom preset files).
 *
 * When `options.custom` is set, the preset content is also persisted under
 * `customPolicies` in the registry so `removePreset` can later undo a
 * custom preset purely by name.
 */
function applyPresetContent(
  sandboxName: string,
  presetName: string,
  presetContent: string,
  options: { custom?: { sourcePath?: string } } = {},
): boolean {
  // Guard against truncated sandbox names — WSL can truncate hyphenated
  // names during argument parsing, e.g. "my-assistant" → "m"
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
        `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`,
    );
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
    if (options.custom) {
      // Custom preset: persist full content so it can be removed later
      // without requiring the user to still have the file on disk.
      registry.addCustomPolicy(sandboxName, {
        name: presetName,
        content: presetContent,
        sourcePath: options.custom.sourcePath,
      });
    } else {
      const pols = sandbox.policies || [];
      if (!pols.includes(presetName)) {
        pols.push(presetName);
      }
      registry.updateSandbox(sandboxName, { policies: pols });
    }
  }

  return true;
}

/**
 * Apply a built-in preset (by name) to a running sandbox. Loads the preset
 * from `nemoclaw-blueprint/policies/presets/<name>.yaml` and delegates to
 * `applyPresetContent`. Returns `false` if the named preset does not exist.
 */
function applyPreset(
  sandboxName: string,
  presetName: string,
  options: Record<string, unknown> = {},
): boolean {
  const presetContent = loadPreset(presetName);
  if (!presetContent) {
    console.error(`  Cannot load preset: ${presetName}`);
    return false;
  }
  return applyPresetContent(sandboxName, presetName, presetContent, options);
}

/**
 * Load a user-authored preset YAML from an arbitrary path on disk, validate
 * its shape, and return `{ presetName, content }` for use with
 * `applyPresetContent`. Returns `null` (and logs a specific error) for any
 * of: missing/non-file path, non-`.yaml`/`.yml` extension, invalid YAML,
 * missing or malformed `preset.name`, missing `network_policies` object, or
 * a name collision with a built-in preset (built-ins must be addressed by
 * their own name, so the custom file must be renamed).
 */
function loadPresetFromFile(filePath: string): { presetName: string; content: string } | null {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    console.error(`  Preset file not found: ${filePath}`);
    return null;
  }
  if (!/\.ya?ml$/i.test(abs)) {
    console.error(`  Preset file must be .yaml or .yml: ${filePath}`);
    return null;
  }
  let content: string;
  let parsed: PolicyValue;
  try {
    content = fs.readFileSync(abs, "utf-8");
    parsed = YAML.parse(content);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const message = err instanceof Error ? err.message : String(err);
    const msg =
      code === "ENOENT" || code === "EACCES"
        ? `Cannot read ${filePath}: ${message}`
        : `Invalid YAML in ${filePath}: ${message}`;
    console.error(`  ${msg}`);
    return null;
  }
  if (!isPolicyDocument(parsed)) {
    console.error(`  Preset must be a YAML mapping: ${filePath}`);
    return null;
  }
  const presetMeta = parsed.preset;
  const presetName =
    presetMeta && typeof presetMeta === "object" && !Array.isArray(presetMeta)
      ? (presetMeta as PolicyObject).name
      : undefined;
  if (typeof presetName !== "string" || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(presetName)) {
    console.error(
      `  Preset must declare preset.name (lowercase, hyphenated RFC 1123 label): ${filePath}`,
    );
    return null;
  }
  if (
    !parsed.network_policies ||
    typeof parsed.network_policies !== "object" ||
    Array.isArray(parsed.network_policies)
  ) {
    console.error(`  Preset missing network_policies section: ${filePath}`);
    return null;
  }
  const builtin = listPresets().map((p) => p.name);
  if (builtin.includes(presetName)) {
    console.error(
      `  Preset name '${presetName}' collides with a built-in preset. Rename 'preset.name' in ${filePath}.`,
    );
    return null;
  }
  return { presetName, content };
}

/**
 * Return the list of preset names currently recorded as applied to the
 * sandbox (both built-in names and custom-preset names), or an empty array
 * if the sandbox is not tracked in the registry.
 */
function getAppliedPresets(sandboxName: string): string[] {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return [];
  const builtin = sandbox.policies || [];
  const custom = (sandbox.customPolicies || []).map((p: { name: string }) => p.name);
  return [...builtin, ...custom];
}

/**
 * Return the custom preset entries recorded on the sandbox as
 * `PresetInfo`-shaped objects, so they can be mixed with built-in presets
 * in listing / selection UIs. `file` is populated from `sourcePath` when
 * available for a user hint; `description` is empty.
 */
function listCustomPresets(sandboxName: string): PresetInfo[] {
  const entries = registry.getCustomPolicies(sandboxName);
  return entries.map((e: { name: string; sourcePath?: string }) => ({
    file: e.sourcePath || `${e.name}.yaml`,
    name: e.name,
    description: "custom preset",
  }));
}

/**
 * Query the gateway for the currently loaded policy and determine which
 * presets are actually enforced by matching network_policies entries
 * against known preset definitions.
 *
 * Returns an array of preset names whose network_policies keys are all
 * found in the gateway's loaded policy, or `null` when the gateway
 * cannot be reached / returns an unparseable response.  Callers use
 * `null` to distinguish "gateway unreachable" from "gateway has no
 * matching presets" (`[]`).
 */
function getGatewayPresets(sandboxName: string): string[] | null {
  let rawPolicy = "";
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {
    return null;
  }

  const currentPolicy = parseCurrentPolicy(rawPolicy);
  if (!currentPolicy) return null;

  let parsed;
  try {
    parsed = YAML.parse(currentPolicy);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  // Gateway returned valid YAML but has no network_policies section —
  // this is a reachable gateway with an empty/default policy.
  const gatewayPolicies = parsed.network_policies;
  if (!gatewayPolicies || typeof gatewayPolicies !== "object" || Array.isArray(gatewayPolicies)) {
    return [];
  }

  const gatewayPolicyNames = new Set(Object.keys(gatewayPolicies));
  const matched = [];

  for (const preset of listPresets()) {
    const content = loadPreset(preset.name);
    if (!content) continue;
    const entries = extractPresetEntries(content);
    if (!entries) continue;

    let presetPolicies;
    try {
      const wrapped = "network_policies:\n" + entries;
      const presetParsed = YAML.parse(wrapped);
      presetPolicies = presetParsed?.network_policies;
    } catch {
      continue;
    }

    if (!presetPolicies || typeof presetPolicies !== "object") continue;

    // A preset is considered "active on gateway" if ALL of its
    // network_policies keys exist in the gateway's loaded policy.
    const presetKeys = Object.keys(presetPolicies);
    if (presetKeys.length > 0 && presetKeys.every((k) => gatewayPolicyNames.has(k))) {
      matched.push(preset.name);
    }
  }

  return matched;
}

/**
 * Interactive preset picker for the `policy-add` command. Prints the
 * presets on stderr (● applied, ○ not applied), prompts for a number, and
 * resolves to the chosen preset name or `null` on cancel.
 */
function selectFromList(
  items: PresetInfo[],
  { applied = [] }: SelectionOptions = {},
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
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
    // Re-attach stdin to the event loop — unref() on exit is sticky and
    // would otherwise leave a follow-up prompt waiting on a detached handle.
    if (typeof process.stdin.ref === "function") process.stdin.ref();
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer: string) => {
      rl.close();
      // pause+unref so the process exits naturally after the last prompt.
      // The matching ref() above keeps subsequent prompts working.
      if (typeof process.stdin.pause === "function") process.stdin.pause();
      if (typeof process.stdin.unref === "function") process.stdin.unref();
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

/**
 * Resolve the on-disk path to the permissive policy YAML for the given
 * sandbox, honoring the agent-specific override registered in
 * `agent-defs.ts`. Returns `null` if no permissive policy is configured.
 */
function resolvePermissivePolicyPath(sandboxName: string): string {
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

function applyPermissivePolicy(sandboxName: string): void {
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

  console.log("  Applying permissive policy...");
  run(buildPolicySetCommand(policyPath, sandboxName));
  console.log("  Applied permissive policy.");
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
  applyPresetContent,
  loadPresetFromFile,
  removePreset,
  applyPermissivePolicy,
  getAppliedPresets,
  getGatewayPresets,
  listCustomPresets,
  selectFromList,
  selectForRemoval,
};
