// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

import type { JsonObject, JsonValue } from "../core/json-types";
import {
  getMessagingPolicyKeyAliases,
  getMessagingPolicyPresetValidationWarnings,
  isMessagingChannelPolicyPreset,
  listBuiltInMessagingChannelManifests,
  listMessagingChannelPolicyPresets,
  listMessagingPolicyPresetMetadata,
  loadMessagingChannelPolicyPreset,
} from "../messaging/channels";
import {
  buildPolicyGetCommand,
  buildPolicyGetFullCommand,
  buildPolicySetCommand,
} from "./commands";
import {
  parseOpenShellPolicy,
  stripProviderComposedPolicies,
  withoutProviderComposedPolicies,
} from "./merge";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const YAML = require("yaml");
const { ROOT, run, runCapture } = require("../runner");
const registry = require("../state/registry");
const { loadAgent } = require("../agent/defs");
// Late-binding access via the module exports so tests can spy on
// resolveOpenshell without rewiring requires.
const openshellResolveModule = require("../adapters/openshell/resolve");

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

const MAX_PRESET_FILE_BYTES = 10_000_000;

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

type PresetLoadOptions = {
  agent?: string | null;
};

type PresetListOptions = {
  agent?: string | null;
};

type MergePresetNamesOptions = {
  agent?: string | null;
};

type SetupPolicyPresetSupportOptions = {
  webSearchSupported?: boolean | null;
  agent?: string | null;
};

function isPolicyDocument(value: PolicyValue): value is PolicyDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Enumerate every built-in preset and return `{ file, name, description }`
 * triples parsed from each file's `preset:` header. Non-messaging presets live
 * under `nemoclaw-blueprint/policies/presets/`; messaging channel presets live
 * beside their channel manifests under `src/lib/messaging/channels/<channel>/policy/`.
 */
function listPresets(options: PresetListOptions = {}): PresetInfo[] {
  const channelPresets = listMessagingChannelPolicyPresets({ agent: options.agent }).map(
    ({ file, name, description }) => ({
      file,
      name,
      description,
    }),
  );
  const channelPresetNames = new Set(channelPresets.map((preset) => preset.name));
  if (!fs.existsSync(PRESETS_DIR)) return channelPresets;
  const centralPresets = fs
    .readdirSync(PRESETS_DIR)
    .filter((f: string) => f.endsWith(".yaml"))
    .map((f: string) => {
      const content = fs.readFileSync(path.join(PRESETS_DIR, f), "utf-8");
      const nameMatch = content.match(/^\s*name:\s*(.+)$/m);
      const descMatch = content.match(/^\s*description:\s*"?([^\n"]*)"?$/m);
      return {
        file: f,
        name: nameMatch ? nameMatch[1].trim() : f.replace(".yaml", ""),
        description: descMatch ? descMatch[1].trim() : "",
      };
    })
    .filter((preset: PresetInfo) => !channelPresetNames.has(preset.name));
  return [...centralPresets, ...channelPresets];
}

/**
 * Read a non-messaging built-in preset by short name from `PRESETS_DIR`.
 * Guards against path traversal and returns `null` if the preset does not
 * exist.
 */
function loadCentralPreset(name: string, options: { reportMissing?: boolean } = {}): string | null {
  const file = path.resolve(PRESETS_DIR, `${name}.yaml`);
  if (!file.startsWith(PRESETS_DIR + path.sep) && file !== PRESETS_DIR) {
    console.error(`  Invalid preset name: ${name}`);
    return null;
  }
  if (!fs.existsSync(file)) {
    if (options.reportMissing !== false) console.error(`  Preset not found: ${name}`);
    return null;
  }
  return fs.readFileSync(file, "utf-8");
}

function loadPresetForAgent(name: string, options: PresetLoadOptions = {}): string | null {
  const channelPreset = loadMessagingChannelPolicyPreset(name, { agent: options.agent });
  if (channelPreset) return channelPreset;
  if (isMessagingChannelPolicyPreset(name)) return null;
  return loadCentralPreset(name);
}

function loadPreset(name: string): string | null {
  return loadPresetForAgent(name, { agent: "openclaw" });
}

function isPolicyObject(value: PolicyValue): value is PolicyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresetPolicyMap(value: PolicyValue): value is PolicyObject {
  return (
    isPolicyObject(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(isPolicyObject)
  );
}

function parseNetworkPolicies(content: string | null | undefined): PolicyObject | null {
  if (!content) return null;
  try {
    const parsed = YAML.parse(content);
    const networkPolicies = isPolicyDocument(parsed) ? parsed.network_policies : null;
    return isPolicyObject(networkPolicies) ? networkPolicies : null;
  } catch {
    return null;
  }
}

// The single sandbox->host bridge hostname OpenShell provisions. An endpoint
// that pins `allowed_ips` for THIS host is the legitimate host-gateway flow
// (e.g. web_fetch to host.openshell.internal); `allowed_ips` on any other host
// is a user-preset egress-bypass attempt (#6073). Mirrors the
// ALLOWED_PRIVATE_CUSTOM_ENDPOINT_HOSTS trust boundary in
// src/lib/actions/inference-set.ts.
const HOST_GATEWAY_BRIDGE_HOST = "host.openshell.internal";

function endpointHostIsGatewayBridge(ep: PolicyObject): boolean {
  const host = (ep as { host?: unknown }).host;
  return (
    typeof host === "string" && host.replace(/\.$/, "").toLowerCase() === HOST_GATEWAY_BRIDGE_HOST
  );
}

function networkPoliciesHasAllowedIps(np: PolicyObject): boolean {
  for (const policyVal of Object.values(np)) {
    if (!isPolicyObject(policyVal)) continue;
    // Object-level `allowed_ips` has no endpoint host context and is never a
    // legitimate shape; always reject. Use `in` (not `Object.hasOwn`) so an
    // inherited/prototype-chain `allowed_ips` can't bypass the guard (#6072).
    if ("allowed_ips" in policyVal) return true;
    const endpoints = (policyVal as PolicyObject).endpoints;
    if (!Array.isArray(endpoints)) continue;
    for (const ep of endpoints) {
      if (!isPolicyObject(ep) || !("allowed_ips" in ep)) continue;
      // Trust-boundary exemption: `allowed_ips` is permitted only to pin the
      // sandbox->host bridge; reject it for every other host (#6073).
      if (endpointHostIsGatewayBridge(ep)) continue;
      return true;
    }
  }
  return false;
}

function parsePresetPolicyKeys(presetContent: string | null | undefined): string[] {
  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) return [];
  return Object.keys(parseNetworkPolicies(`network_policies:\n${presetEntries}`) || {});
}

const AGENT_PRESET_KEY_ALIASES: Readonly<Record<string, readonly string[]>> =
  getMessagingPolicyKeyAliases();

function selectAgentPolicyKeys(
  agentPolicies: PolicyObject,
  presetName: string,
  builtinPresetContent: string,
): string[] {
  const builtinKeys = parsePresetPolicyKeys(builtinPresetContent);
  if (
    builtinKeys.length > 0 &&
    builtinKeys.every((key) => Object.prototype.hasOwnProperty.call(agentPolicies, key))
  ) {
    return builtinKeys;
  }

  if (Object.prototype.hasOwnProperty.call(agentPolicies, presetName)) {
    return [presetName];
  }

  const aliases = AGENT_PRESET_KEY_ALIASES[presetName] || [];
  const aliasMatches = aliases.filter((key) =>
    Object.prototype.hasOwnProperty.call(agentPolicies, key),
  );
  if (aliasMatches.length > 0) return aliasMatches;

  return Object.entries(agentPolicies)
    .filter(([, value]) => isPolicyObject(value) && value.name === presetName)
    .map(([key]) => key);
}

function loadAgentPresetContent(
  sandboxName: string,
  presetName: string,
  builtinPresetContent: string,
): string | null {
  try {
    const sandbox = registry.getSandbox(sandboxName);
    if (!sandbox?.agent) return null;

    const agent = loadAgent(sandbox.agent);
    if (!agent?.policyAdditionsPath || !fs.existsSync(agent.policyAdditionsPath)) return null;

    const agentPolicies = parseNetworkPolicies(fs.readFileSync(agent.policyAdditionsPath, "utf-8"));
    if (!agentPolicies) return null;

    const keys = selectAgentPolicyKeys(agentPolicies, presetName, builtinPresetContent);
    if (keys.length === 0) return null;

    const selectedPolicies: PolicyObject = {};
    for (const key of keys) selectedPolicies[key] = agentPolicies[key];

    return YAML.stringify({
      preset: {
        name: presetName,
        description: `${agent.displayName} ${presetName} policy`,
      },
      network_policies: selectedPolicies,
    });
  } catch {
    return null;
  }
}

function loadPresetForSandbox(sandboxName: string, presetName: string): string | null {
  let sandboxAgent: string | null = null;
  try {
    sandboxAgent = registry.getSandbox(sandboxName)?.agent ?? null;
  } catch {
    sandboxAgent = null;
  }

  const channelPresetContent = loadMessagingChannelPolicyPreset(presetName, {
    agent: sandboxAgent,
  });
  if (channelPresetContent) return channelPresetContent;
  if (isMessagingChannelPolicyPreset(presetName)) return null;

  const builtinPresetContent = loadCentralPreset(presetName);
  if (!builtinPresetContent) return null;
  return (
    loadAgentPresetContent(sandboxName, presetName, builtinPresetContent) || builtinPresetContent
  );
}

/**
 * Extract the bare hostnames declared in a preset YAML (anything matched by
 * `host: <value>`), with surrounding quotes stripped. Used to show the
 * "endpoints that would be opened" preview before applying a preset.
 */
function getPresetEndpoints(content: string): string[] {
  const hosts: string[] = [];
  const regex = /^[ \t]*(?:-[ \t]*)?host:[ \t]*([^#\s,}]+)/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    hosts.push(match[1].replace(/^["']|["']$/g, ""));
  }
  return hosts;
}

/**
 * Messaging channel presets only open network egress to the provider's API;
 * the bot token, channel configuration, and in-sandbox bridge are wired up at
 * `nemoclaw onboard` time, so applying these presets after onboarding without
 * having enabled the channel opens the firewall but leaves the sandbox
 * without a running bridge. See #1691.
 */
const MESSAGING_PRESET_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  listMessagingPolicyPresetMetadata().flatMap((preset) => {
    const manifest = listBuiltInMessagingChannelManifests().find(
      (entry) => entry.id === preset.channelId,
    );
    return manifest ? [[preset.presetName, manifest.displayName]] : [];
  }),
);

const MESSAGING_PRESET_VALIDATION_WARNING_LINES: Readonly<Record<string, readonly string[]>> =
  getMessagingPolicyPresetValidationWarnings();

function getPresetValidationWarning(presetName: string): string | null {
  if (presetName === "jira") {
    return [
      "Jira preset validation uses per-binary policy signals.",
      "Node HTTPS is allowed for Atlassian API traffic:",
      "node -e \"require('https').get('https://api.atlassian.com', r => console.log(r.statusCode))\"",
      "curl is intentionally not in the preset binary allowlist. Avoid plain",
      "curl -s probes for auth.atlassian.com: Atlassian can return an empty",
      "redirect body, which looks the same as a blocked request. Empty curl -s",
      "output from that endpoint is inconclusive before or after approval. Use a",
      "body-visible API probe instead:",
      "curl -sS --max-time 10 -w '\\n%{http_code}\\n' https://api.atlassian.com/oauth/token/accessible-resources",
      "Before approval, expect 000 or a local policy denial. After explicitly",
      "approving curl for api.atlassian.com, expect Atlassian's 401 JSON",
      "response, which proves curl reached the service without Jira credentials.",
    ].join("\n  ");
  }

  const label = MESSAGING_PRESET_LABELS[presetName];
  if (!label) return null;
  const lines = [
    `Note: the '${presetName}' preset only opens network egress to the ${label} API.`,
    `To actually enable ${label} messaging, re-run 'nemoclaw onboard' and select ${label}`,
    "in the messaging channels step. Channel setup, pairing, and runtime",
    "configuration are wired up at onboard time and are not added by applying",
    "this preset alone.",
  ];
  lines.push(...(MESSAGING_PRESET_VALIDATION_WARNING_LINES[presetName] ?? []));

  return lines.join("\n  ");
}

function setupPolicyPresetSupported(
  name: string,
  options: SetupPolicyPresetSupportOptions = {},
): boolean {
  return name !== "brave" || options.webSearchSupported !== false;
}

function filterSetupPolicyPresets<T extends { name: string }>(
  presets: T[],
  options: SetupPolicyPresetSupportOptions = {},
): T[] {
  return presets.filter((preset) => setupPolicyPresetSupported(preset.name, options));
}

function listSetupPolicyPresets(
  sandboxName: string,
  options: SetupPolicyPresetSupportOptions = {},
): PresetInfo[] {
  let sandboxAgent: string | null = null;
  try {
    sandboxAgent = registry.getSandbox(sandboxName)?.agent ?? null;
  } catch {
    sandboxAgent = null;
  }
  return [
    ...filterSetupPolicyPresets(listPresets({ agent: options.agent ?? sandboxAgent }), options),
    ...listCustomPresets(sandboxName),
  ];
}

function clampSetupPolicyPresetNames(
  presetNames: string[],
  allowedPresets: Array<{ name: string }>,
  options: SetupPolicyPresetSupportOptions = {},
  customPresetNames: ReadonlySet<string> = new Set(),
): string[] {
  const knownPresets = new Set(allowedPresets.map((p) => p.name));
  return presetNames.filter((name) => {
    if (!knownPresets.has(name)) return false;
    if (customPresetNames.has(name)) return true;
    return setupPolicyPresetSupported(name, options);
  });
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
 * Parse the output of `openshell policy get --base` or `--full`, which has a
 * metadata header (Version, Hash, etc.) followed by `---` and then the actual
 * YAML.
 */
// invalidState: metadata-only, diagnostic, malformed, or empty CLI output is
// not a policy and must remain distinguishable from a parsed YAML mapping.
// sourceBoundary: OpenShell owns CLI output; the canonical parser owns what
// NemoClaw admits as policy YAML.
// whyNotSourceFix: NemoClaw supports CLI releases whose process output is the
// only available boundary, including versionless network_policies bodies.
// regressionTest: nemoclaw/src/shared/openshell-policy-boundary.test.ts and
// test/policy-mutation-read-failure.test.ts.
// removalCondition: remove this fail-soft adapter when every caller consumes a
// typed OpenShell policy API.
function parseCurrentPolicyOrEmpty(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return parseOpenShellPolicy(raw).yamlBody;
  } catch {
    return "";
  }
}

/**
 * Pre-spawn check used at command entry points before any
 * `run(buildPolicy*Command(...))`. If the binary cannot be resolved, prints
 * every location checked and an install hint, then exits nonzero — instead
 * of letting the spawn surface as the opaque `spawnSync openshell ENOENT`
 * (issue #4224).
 */
function assertOpenshellResolvable(): void {
  if (openshellResolveModule.resolveOpenshell()) return;

  const home = process.env.HOME;
  const override = process.env.NEMOCLAW_OPENSHELL_BIN;
  const currentPath = process.env.PATH;
  const checked: string[] = [];
  if (override) checked.push(`NEMOCLAW_OPENSHELL_BIN=${override}`);
  // Log the concrete PATH so bug reports name what was actually searched.
  // The whole point of #4224 is that non-interactive shells drop ~/.local/bin
  // from PATH; the value is the most actionable single piece of context.
  checked.push(
    currentPath
      ? `PATH=${currentPath} (via \`command -v openshell\`)`
      : "PATH=<unset> (via `command -v openshell`)",
  );
  if (home?.startsWith("/")) checked.push(`${home}/.local/bin/openshell`);
  checked.push("/usr/local/bin/openshell", "/usr/bin/openshell");

  console.error("  openshell binary not found. Checked:");
  for (const location of checked) {
    console.error(`    - ${location}`);
  }
  console.error(
    "  Install OpenShell (https://github.com/NVIDIA/OpenShell) or set NEMOCLAW_OPENSHELL_BIN to an absolute, executable path.",
  );
  process.exit(1);
}

/**
 * Merge preset entries into existing policy YAML using structured YAML
 * parsing. Invalid input fails closed instead of falling back to text
 * manipulation that could produce a syntactically valid but unsafe policy.
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
  const parsedCurrentPolicy = parseCurrentPolicyOrEmpty(currentPolicy);
  if (currentPolicy.trim() && !parsedCurrentPolicy) {
    throw new Error(
      "Cannot merge policy preset: the current policy is not a valid YAML mapping. " +
        "Re-read the base policy and try again; no policy changes were made.",
    );
  }
  const normalizedCurrentPolicy = stripProviderComposedPolicies(parsedCurrentPolicy);
  if (!presetEntries) {
    return normalizedCurrentPolicy || "version: 1\n\nnetwork_policies:\n";
  }

  // Parse preset entries. They come as indented content under network_policies:,
  // so we wrap them to make valid YAML for parsing.
  let presetPolicies: PolicyObject;
  try {
    const wrapped = "network_policies:\n" + presetEntries;
    const parsed = YAML.parse(wrapped);
    if (!isPolicyDocument(parsed) || !isPresetPolicyMap(parsed.network_policies)) {
      throw new Error("network_policies must be a non-empty mapping of policy objects");
    }
    presetPolicies = withoutProviderComposedPolicies(parsed.network_policies);
  } catch {
    throw new Error(
      "Cannot merge policy preset: preset network_policies entries must be a valid YAML mapping. " +
        "Check the preset file and try again; no policy changes were made.",
    );
  }

  if (!normalizedCurrentPolicy) {
    return YAML.stringify({ version: 1, network_policies: presetPolicies });
  }

  // Parse the current policy as structured YAML
  let current: PolicyDocument | null;
  try {
    const parsed = YAML.parse(normalizedCurrentPolicy);
    current = isPolicyDocument(parsed) ? parsed : null;
  } catch {
    current = null;
  }
  if (!current) {
    throw new Error(
      "Cannot merge policy preset: the normalized current policy could not be parsed. " +
        "Re-read the base policy and try again; no policy changes were made.",
    );
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

function mergePresetNamesIntoPolicy(
  currentPolicy: string,
  presetNames: string[],
  options: MergePresetNamesOptions = {},
): { policy: string; appliedPresets: string[]; missingPresets: string[] } {
  let merged = currentPolicy;
  const appliedPresets: string[] = [];
  const missingPresets: string[] = [];

  for (const presetName of [...new Set(presetNames)]) {
    const presetContent = loadPresetForAgent(presetName, { agent: options.agent });
    const presetEntries = extractPresetEntries(presetContent);
    if (!presetEntries) {
      missingPresets.push(presetName);
      continue;
    }

    merged = mergePresetIntoPolicy(merged, presetEntries);
    appliedPresets.push(presetName);
  }

  return { policy: merged, appliedPresets, missingPresets };
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
  const parsedCurrentPolicy = parseCurrentPolicyOrEmpty(currentPolicy);
  if (currentPolicy.trim() && !parsedCurrentPolicy) {
    throw new Error(
      "Cannot remove policy preset: the current policy is not a valid YAML mapping. " +
        "Re-read the base policy and try again; no policy changes were made.",
    );
  }
  const normalizedCurrentPolicy = stripProviderComposedPolicies(parsedCurrentPolicy);
  if (!presetEntries) {
    return normalizedCurrentPolicy || "version: 1\n\nnetwork_policies:\n";
  }

  // Parse preset entries to extract the network_policies key names.
  // They come as indented content under network_policies:,
  // so we wrap them to make valid YAML for parsing.
  let presetPolicies: PolicyObject;
  try {
    const wrapped = "network_policies:\n" + presetEntries;
    const parsed = YAML.parse(wrapped);
    if (!isPolicyDocument(parsed) || !isPresetPolicyMap(parsed.network_policies)) {
      throw new Error("network_policies must be a non-empty mapping of policy objects");
    }
    presetPolicies = parsed.network_policies;
  } catch {
    throw new Error(
      "Cannot remove policy preset: preset network_policies entries must be a valid YAML mapping. " +
        "Check the preset file and try again; no policy changes were made.",
    );
  }

  const presetKeys = Object.keys(presetPolicies);
  if (presetKeys.length === 0) return normalizedCurrentPolicy;
  if (!normalizedCurrentPolicy) return "version: 1\n\nnetwork_policies:\n";

  // Parse the current policy as structured YAML
  let current: PolicyDocument | null;
  try {
    const parsed = YAML.parse(normalizedCurrentPolicy);
    current = isPolicyDocument(parsed) ? parsed : null;
  } catch {
    current = null;
  }

  if (!current) {
    throw new Error(
      "Cannot remove policy preset: the normalized current policy could not be parsed. " +
        "Re-read the base policy and try again; no policy changes were made.",
    );
  }

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
  let presetContent: string | null = loadPresetForSandbox(sandboxName, presetName);
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
    // Mutations start from round-trippable --base, never provider-composed --full.
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName));
  } catch {
    /* ignored */
  }

  const currentPolicy = parseCurrentPolicyOrEmpty(rawPolicy);
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

  // Run before creating temp resources so a missing-binary exit doesn't
  // orphan files in $TMPDIR (the finally cleanup doesn't run on process.exit).
  assertOpenshellResolvable();

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

  if (options.custom) {
    const np = parseNetworkPolicies(presetContent);
    if (np && networkPoliciesHasAllowedIps(np)) {
      console.error(
        `  Preset '${presetName}' contains 'allowed_ips', which is not permitted in user-supplied presets.`,
      );
      return false;
    }
  }

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }

  // Get current policy YAML from sandbox
  let rawPolicy: string | null = null;
  try {
    // Mutations start from round-trippable --base, never provider-composed --full.
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName));
  } catch {
    /* Refused below. */
  }

  const currentPolicy = parseCurrentPolicyOrEmpty(rawPolicy);
  // A live mutation requires a usable policy; empty is an invalid read, not a
  // fresh sandbox whose unknown policy may be replaced with a scaffold.
  if (!currentPolicy) {
    console.error(
      `  Could not read the current policy for sandbox '${sandboxName}'; refusing to apply '${presetName}' to avoid overwriting it.`,
    );
    return false;
  }
  const merged = mergePresetIntoPolicy(currentPolicy, presetEntries);

  const endpoints = getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Widening sandbox egress — adding: ${endpoints.join(", ")}`);
  }

  // Run before creating temp resources so a missing-binary exit doesn't
  // orphan files in $TMPDIR (the finally cleanup doesn't run on process.exit).
  assertOpenshellResolvable();

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
  } else if (options.custom) {
    // The preset reached the gateway, but sandbox `sandboxName` has no local
    // registry entry, so it cannot be recorded under `customPolicies`. Custom
    // presets are surfaced only from the registry (both `listCustomPresets`
    // and `getGatewayPresets` read `registry.getCustomPolicies`), so an
    // unrecorded custom preset never appears in `policy-list` or `status`.
    // Report the gap instead of exiting 0 as if the preset were fully applied. (#4510)
    console.error(
      `  Warning: '${presetName}' was applied to the gateway but could not be ` +
        `recorded locally because sandbox '${sandboxName}' is not in the ` +
        `registry, so it will not appear in policy-list or status. Recover or ` +
        `re-onboard the sandbox, then re-apply.`,
    );
    return false;
  }

  return true;
}

/**
 * Apply a built-in preset (by name) to a running sandbox. Loads messaging
 * presets from channel-owned policy files and non-messaging presets from the
 * central preset directory, then delegates to `applyPresetContent`. Returns
 * `false` if the named preset does not exist.
 */
function applyPreset(
  sandboxName: string,
  presetName: string,
  options: Record<string, unknown> = {},
): boolean {
  const presetContent = loadPresetForSandbox(sandboxName, presetName);
  if (!presetContent) {
    console.error(`  Cannot load preset: ${presetName}`);
    return false;
  }
  return applyPresetContent(sandboxName, presetName, presetContent, options);
}

/**
 * Apply multiple built-in presets to a running sandbox with a single gateway
 * policy mutation. This preserves final policy/registry state from applying
 * presets one-by-one, while avoiding one `openshell policy set --wait` per
 * preset during onboarding.
 */
function applyPresets(sandboxName: string, presetNames: string[]): boolean {
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
        `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`,
    );
  }

  const uniquePresetNames = [...new Set(presetNames)].filter(Boolean);
  if (uniquePresetNames.length === 0) return true;

  let rawPolicy: string | null = null;
  try {
    // Mutations start from round-trippable --base, never provider-composed --full.
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName));
  } catch {
    /* Refused below. */
  }

  let merged = parseCurrentPolicyOrEmpty(rawPolicy);
  // Keep the batch entrypoint on the same fail-closed source boundary as
  // applyPresetContent: an unusable successful read is still a failed read.
  if (!merged) {
    console.error(
      `  Could not read the current policy for sandbox '${sandboxName}'; refusing to apply presets to avoid overwriting it.`,
    );
    return false;
  }
  const endpointLogs: string[][] = [];

  for (const presetName of uniquePresetNames) {
    const presetContent = loadPresetForSandbox(sandboxName, presetName);
    if (!presetContent) {
      console.error(`  Cannot load preset: ${presetName}`);
      return false;
    }

    const presetEntries = extractPresetEntries(presetContent);
    if (!presetEntries) {
      console.error(`  Preset ${presetName} has no network_policies section.`);
      return false;
    }

    const endpoints = getPresetEndpoints(presetContent);
    endpointLogs.push(endpoints);
    merged = mergePresetIntoPolicy(merged, presetEntries);
  }

  for (const endpoints of endpointLogs) {
    if (endpoints.length > 0) {
      console.log(`  Widening sandbox egress — adding: ${endpoints.join(", ")}`);
    }
  }

  // Run before creating temp resources so a missing-binary exit doesn't
  // orphan files in $TMPDIR (the finally cleanup doesn't run on process.exit).
  assertOpenshellResolvable();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(tmpFile, merged, { encoding: "utf-8", mode: 0o600 });

  try {
    run(buildPolicySetCommand(tmpFile, sandboxName));

    for (const presetName of uniquePresetNames) {
      console.log(`  Applied preset: ${presetName}`);
    }
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
    for (const presetName of uniquePresetNames) {
      if (!pols.includes(presetName)) {
        pols.push(presetName);
      }
    }
    registry.updateSandbox(sandboxName, { policies: pols });
  }

  return true;
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
  if (!/\.ya?ml$/i.test(abs)) {
    console.error(`  Preset file must be .yaml or .yml: ${filePath}`);
    return null;
  }
  const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP" || code === "EMLINK") {
      console.error(
        `  Preset file must not be a symbolic link: ${filePath} (resolve with 'realpath' and pass the target path).`,
      );
    } else if (code === "ENOENT" || code === "ENOTDIR") {
      console.error(`  Preset file not found: ${filePath}`);
    } else if (code === "EACCES" || code === "EPERM") {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Cannot read ${filePath}: ${message}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Cannot read ${filePath}: ${message}`);
    }
    return null;
  }
  let content: string;
  let parsed: PolicyValue;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      console.error(`  Preset file not found: ${filePath}`);
      return null;
    }
    if (stat.size > MAX_PRESET_FILE_BYTES) {
      console.error(
        `  Preset file too large: ${filePath} (${stat.size} bytes; max ${MAX_PRESET_FILE_BYTES} bytes).`,
      );
      return null;
    }
    try {
      const buffer = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      content = buffer.toString("utf-8", 0, offset);
      parsed = YAML.parse(content);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Invalid YAML in ${filePath}: ${message}`);
      return null;
    }
  } finally {
    fs.closeSync(fd);
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
  if (typeof presetName === "string" && presetName.startsWith("_provider_")) {
    console.error(
      `  Preset name cannot start with '_provider_' (reserved by OpenShell): ${filePath}`,
    );
    return null;
  }
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
  if (Object.keys(parsed.network_policies).some((name) => name.startsWith("_provider_"))) {
    console.error(
      `  Preset network_policies keys cannot start with '_provider_' (reserved by OpenShell): ${filePath}`,
    );
    return null;
  }
  const np = parsed.network_policies as PolicyObject;
  if (networkPoliciesHasAllowedIps(np)) {
    console.error(
      `  Preset '${presetName}' contains 'allowed_ips', which is not permitted in user-supplied presets: ${filePath}`,
    );
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
 * True when every `network_policies` key declared in `content` is present in
 * `gatewayPolicyNames`. Works for both built-in preset YAML and the custom
 * preset YAML stored under a sandbox's registry entry — keeping a single
 * matching rule means `policy-list` and `status` stay consistent for either
 * preset source. (#3590)
 */
function presetMatchesGateway(
  content: string | null,
  gatewayPolicyNames: ReadonlySet<string>,
): boolean {
  const entries = extractPresetEntries(content);
  if (!entries) return false;

  let presetPolicies;
  try {
    const presetParsed = YAML.parse("network_policies:\n" + entries);
    presetPolicies = presetParsed?.network_policies;
  } catch {
    return false;
  }

  if (!presetPolicies || typeof presetPolicies !== "object") return false;

  const presetKeys = Object.keys(presetPolicies);
  return presetKeys.length > 0 && presetKeys.every((k) => gatewayPolicyNames.has(k));
}

/**
 * Query the gateway for the currently loaded policy and determine which
 * presets are actually enforced by matching network_policies entries
 * against known preset definitions. Considers both built-in presets and
 * sandbox-scoped custom presets recorded in the registry. (#3590)
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
    rawPolicy = runCapture(buildPolicyGetFullCommand(sandboxName), { ignoreError: true });
  } catch {
    return null;
  }

  const currentPolicy = parseCurrentPolicyOrEmpty(rawPolicy);
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
  const matched: string[] = [];
  let sandboxAgent: string | null = null;
  try {
    sandboxAgent = registry.getSandbox(sandboxName)?.agent ?? null;
  } catch {
    sandboxAgent = null;
  }

  for (const preset of listPresets({ agent: sandboxAgent })) {
    if (presetMatchesGateway(loadPresetForSandbox(sandboxName, preset.name), gatewayPolicyNames)) {
      matched.push(preset.name);
    }
  }

  for (const entry of registry.getCustomPolicies(sandboxName)) {
    if (presetMatchesGateway(entry.content, gatewayPolicyNames)) {
      matched.push(entry.name);
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
  assertOpenshellResolvable();
  run(buildPolicySetCommand(policyPath, sandboxName));
  console.log("  Applied permissive policy.");
}

export {
  applyPermissivePolicy,
  applyPreset,
  applyPresetContent,
  applyPresets,
  assertOpenshellResolvable,
  buildPolicyGetCommand,
  buildPolicyGetFullCommand,
  buildPolicySetCommand,
  clampSetupPolicyPresetNames,
  extractPresetEntries,
  filterSetupPolicyPresets,
  getAppliedPresets,
  getGatewayPresets,
  getPresetEndpoints,
  getPresetValidationWarning,
  isMessagingChannelPolicyPreset,
  listCustomPresets,
  listPresets,
  listSetupPolicyPresets,
  loadPreset,
  loadPresetForSandbox,
  loadPresetFromFile,
  mergePresetIntoPolicy,
  mergePresetNamesIntoPolicy,
  networkPoliciesHasAllowedIps,
  PERMISSIVE_POLICY_PATH,
  PRESETS_DIR,
  parseCurrentPolicyOrEmpty as parseCurrentPolicy,
  parsePresetPolicyKeys,
  removePreset,
  removePresetFromPolicy,
  resolvePermissivePolicyPath,
  selectForRemoval,
  selectFromList,
  setupPolicyPresetSupported,
};
