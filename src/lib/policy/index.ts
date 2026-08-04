// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

// Namespace access keeps resolveOpenshell spyable in focused policy tests.
import * as openshellResolveModule from "../adapters/openshell/resolve";
import { loadAgent, requireAgentPolicyAdditionsPath } from "../agent/defs";
import { CLI_NAME } from "../cli/branding";
import {
  getMessagingPolicyKeyAliases,
  getMessagingPolicyPresetValidationWarnings,
  isMessagingChannelPolicyPreset,
  listBuiltInMessagingChannelManifests,
  listMessagingChannelPolicyPresets,
  listMessagingPolicyPresetMetadata,
  loadMessagingChannelPolicyPreset,
} from "../messaging/channels";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import { assertNoOpenShellGatewayEndpointOverride } from "../openshell-gateway-endpoint-guard";
import { OPENSHELL_SANDBOX_HOST_BRIDGE } from "../private-networks";
import { ROOT, run, runCapture } from "../runner";
import * as registry from "../state/registry";
import type { BaselineExclusionRuntimeStatus } from "./baseline-exclusion";
import {
  digestBaselineEntry,
  evaluateBaselineExclusionRuntimeStatus,
  getBaselineEntry,
  mergeBaselineEntryIntoPolicy,
  removeBaselineEntryFromPolicy,
} from "./baseline-exclusion";
import {
  buildPolicyGetCommand,
  buildPolicyGetFullCommand,
  buildPolicySetCommand,
} from "./commands";
import { inspectGatewayPresetNames, inspectPresetContentGatewayState } from "./gateway-state";
import {
  parseOpenShellPolicy,
  stripProviderComposedPolicies,
  withoutProviderComposedPolicies,
} from "./merge";
import { findUnexpectedExistingPolicyKey } from "./preset-ownership";
import {
  isPolicyDocument,
  isPolicyObject,
  isPresetPolicyMap,
  type PolicyDocument,
  type PolicyObject,
  type PolicyValue,
  parseNetworkPolicies,
} from "./preset-parsing";
import { escapeTerminalText, logPresetScope, renderPresetScope } from "./preset-scope-render";
import { parseAndValidateSandboxPolicy } from "./sandbox-policy-validation";
import { splitSemanticFindings, validatePolicySemantics } from "./semantic-validation";

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

const MAX_PRESET_FILE_BYTES = 10_000_000;

type PresetInfo = {
  file: string;
  name: string;
  description: string;
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
  excludedBaselineKeys?: readonly string[];
};

type SetupPolicyPresetSupportOptions = {
  webSearchSupported?: boolean | null;
  agent?: string | null;
};

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
// The single sandbox->host bridge hostname OpenShell provisions. An endpoint
// that pins `allowed_ips` for THIS host is the legitimate host-gateway flow
// (e.g. web_fetch to host.openshell.internal); `allowed_ips` on any other host
// is a user-preset egress-bypass attempt (#6073). Keep this hostname shared
// with the config-set and inference endpoint bridge trust boundary.
const HOST_GATEWAY_BRIDGE_HOST = OPENSHELL_SANDBOX_HOST_BRIDGE;

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

/** Preserve invalid registered content as indeterminate for ownership decisions. */
function parsePresetPolicyKeysForOwnership(presetContent: string): string[] | null {
  const networkPolicies = parseNetworkPolicies(presetContent);
  return networkPolicies === null ? null : Object.keys(networkPolicies);
}

function findExcludedBaselineKeyForPolicy(
  sandboxName: string,
  presetContent: string,
): string | null {
  const excludedKeys = new Set(
    registry.getBaselineExclusions(sandboxName).map((exclusion) => exclusion.key),
  );
  const transition = registry.getBaselineExclusionTransition(sandboxName);
  if (transition?.operation === "exclude") excludedKeys.add(transition.exclusion.key);
  return parsePresetPolicyKeys(presetContent).find((key) => excludedKeys.has(key)) ?? null;
}

function findAppliedPolicyOwnerForKey(sandboxName: string, key: string): string | null {
  const sandbox = registry.getSandbox(sandboxName);
  for (const presetName of sandbox?.policies ?? []) {
    const content = loadPresetForSandbox(sandboxName, presetName);
    if (content && parsePresetPolicyKeys(content).includes(key)) return presetName;
  }
  for (const custom of registry.getCustomPolicies(sandboxName)) {
    if (parsePresetPolicyKeys(custom.content).includes(key)) return custom.name;
  }
  return null;
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
  const isWebSearchPreset = name === "brave" || name === "tavily";
  return !isWebSearchPreset || options.webSearchSupported !== false;
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
 * every location checked and an install hint. Normal command entry points
 * exit nonzero; transactional lifecycle callers can request `nonFatal` and
 * retain control for rollback instead of surfacing the opaque
 * `spawnSync openshell ENOENT` (issue #4224).
 */
function assertOpenshellResolvable(options: { nonFatal?: boolean } = {}): boolean {
  if (openshellResolveModule.resolveOpenshell()) return true;

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
  if (options.nonFatal) return false;
  process.exit(1);
}

/**
 * Apply a policy file while optionally keeping control in the caller on
 * failure. Lifecycle code that owns compensating actions must use nonFatal so
 * a failed OpenShell mutation cannot bypass its rollback through process.exit.
 */
function setPolicyFile(
  policyFile: string,
  sandboxName: string,
  options: { nonFatal?: boolean; gatewayName?: string } = {},
): boolean {
  const result = run(buildPolicySetCommand(policyFile, sandboxName), {
    ignoreError: options.nonFatal === true,
    ...(options.gatewayName ? { env: { OPENSHELL_GATEWAY: options.gatewayName } } : {}),
  });
  if (!options.nonFatal) return true;
  if (!result.error && result.status === 0) return true;

  const detail = result.error?.message ?? `exit ${result.status ?? "unknown"}`;
  console.error(`  Failed to update policy for sandbox '${sandboxName}' (${detail}).`);
  return false;
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

export type PresetPolicyState = "absent" | "drift" | "match";

function classifyPresetEntries(currentPolicy: string, presetEntries: string): PresetPolicyState {
  try {
    const current = YAML.parse(currentPolicy)?.network_policies;
    const expected = YAML.parse(`network_policies:\n${presetEntries}`)?.network_policies;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      return "drift";
    }
    const expectedEntries = Object.entries(expected);
    if (expectedEntries.length === 0) return "drift";
    if (!current || typeof current !== "object" || Array.isArray(current)) return "absent";
    const presentEntries = expectedEntries.filter(([key]) => Object.hasOwn(current, key));
    if (presentEntries.length === 0) return "absent";
    return expectedEntries.every(
      ([key, value]) => Object.hasOwn(current, key) && isDeepStrictEqual(current[key], value),
    )
      ? "match"
      : "drift";
  } catch {
    return "drift";
  }
}

function policyDocumentsMatch(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(YAML.parse(left), YAML.parse(right));
  } catch {
    return false;
  }
}

function logPresetNoNewEgress(
  presetName: string,
  logger: (line: string) => void = console.log,
): void {
  logger(
    `  Preset '${escapeTerminalText(presetName)}' is already effective; no new egress would be opened.`,
  );
}

function logPresetScopeForState(
  presetName: string,
  content: string,
  state: PresetPolicyState | null,
  logger: (line: string) => void = console.log,
): void {
  if (state === "match") {
    logPresetNoNewEgress(presetName, logger);
    return;
  }
  const heading =
    state === "absent"
      ? "  Effective egress that would be opened:"
      : state === "drift"
        ? "  Effective egress scope that would replace the current preset policy:"
        : "  Effective egress scope to be applied (live delta unavailable):";
  for (const line of renderPresetScope(content, { heading })) logger(line);
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

    const excludedKeys = new Set(options.excludedBaselineKeys ?? []);
    const collision = parsePresetPolicyKeys(presetContent).find((key) => excludedKeys.has(key));
    if (collision) {
      throw new Error(
        `Cannot compose policy preset '${presetName}': network policy key '${collision}' is reserved by a baseline exclusion. Restore that baseline key before applying the preset.`,
      );
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
function removePreset(
  sandboxName: string,
  presetName: string,
  options: { nonFatal?: boolean; skipRegistryUpdate?: boolean } = {},
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
  if (!assertOpenshellResolvable(options)) return false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(tmpFile, updated, { encoding: "utf-8", mode: 0o600 });

  try {
    if (!setPolicyFile(tmpFile, sandboxName, options)) return false;
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

  const sandbox = options.skipRegistryUpdate ? undefined : registry.getSandbox(sandboxName);
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

/** Push a policy YAML body to a sandbox's live gateway via a private temp file. */
function pushPolicyYaml(
  sandboxName: string,
  updatedPolicy: string,
  options: { nonFatal?: boolean; gatewayName?: string } = {},
): boolean {
  if (!assertOpenshellResolvable(options)) return false;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(tmpFile, updatedPolicy, { encoding: "utf-8", mode: 0o600 });
  try {
    return setPolicyFile(tmpFile, sandboxName, options);
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
}

/** Round-trippable live policy body from `--base`, or null when unreadable. */
function readCurrentSandboxPolicy(sandboxName: string, gatewayName?: string): string | null {
  let rawPolicy = "";
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), {
      ...(gatewayName ? { env: { OPENSHELL_GATEWAY: gatewayName } } : {}),
    });
  } catch {
    /* ignored */
  }
  return parseCurrentPolicyOrEmpty(rawPolicy) || null;
}

/** Resolve and validate one agent's reviewed baseline policy source. */
function resolveAgentBaselinePolicy(
  agentName: string | null | undefined,
): { agent: string; policyPath: string; content: string } | null {
  const resolvedAgent = agentName || "openclaw";
  const usesOpenClawBaseline = !agentName || agentName === "openclaw";
  const policyPath = usesOpenClawBaseline
    ? path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml")
    : requireAgentPolicyAdditionsPath(loadAgent(resolvedAgent));
  let content: string;
  try {
    content = fs.readFileSync(policyPath, "utf-8");
  } catch {
    if (!usesOpenClawBaseline) {
      throw new Error(
        `Agent '${resolvedAgent}' baseline policy became unreadable. Refusing to substitute the OpenClaw baseline.`,
      );
    }
    return null;
  }
  parseAndValidateSandboxPolicy(content);
  return { agent: resolvedAgent, policyPath, content };
}

/** Resolve the reviewed baseline policy source recorded for a sandbox. */
function resolveSandboxBaselinePolicy(
  sandboxName: string,
): { agent: string; policyPath: string; content: string } | null {
  return resolveAgentBaselinePolicy(registry.getSandbox(sandboxName)?.agent);
}

/** The current baseline entry for a key, or null when the baseline omits it. */
function getSandboxBaselineEntry(sandboxName: string, key: string): PolicyObject | null {
  const baseline = resolveSandboxBaselinePolicy(sandboxName);
  return baseline ? getBaselineEntry(baseline.content, key) : null;
}

/** Content digest of a sandbox's current baseline entry, or null when absent. */
function getSandboxBaselineEntryDigest(sandboxName: string, key: string): string | null {
  const entry = getSandboxBaselineEntry(sandboxName, key);
  return entry ? digestBaselineEntry(entry) : null;
}

/** Digest of an observed live policy key, null when absent, or throw when unreadable. */
function getLiveSandboxPolicyEntryDigest(sandboxName: string, key: string): string | null {
  assertNoOpenShellGatewayEndpointOverride();
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) throw new Error(`Sandbox '${sandboxName}' is not registered.`);
  const gatewayName = resolveSandboxGatewayName(sandbox);
  const currentPolicy = readCurrentSandboxPolicy(sandboxName, gatewayName);
  if (!currentPolicy) throw new Error(`Live policy for '${sandboxName}' is unreadable.`);
  const live = inspectLiveBaselineEntry(currentPolicy, key);
  if (live.state === "invalid") {
    throw new Error(`Live policy key '${key}' for '${sandboxName}' is malformed.`);
  }
  return live.digest;
}

/** Three-way status across agent source, reviewed baseline, and observed live policy. */
function getBaselineExclusionRuntimeStatus(
  sandboxName: string,
  exclusion: registry.BaselineExclusionEntry,
): BaselineExclusionRuntimeStatus {
  const currentAgent = registry.getSandbox(sandboxName)?.agent || "openclaw";
  if (exclusion.agent !== currentAgent) return "agent-changed";
  let currentBaselineDigest: string | null;
  try {
    currentBaselineDigest = getSandboxBaselineEntryDigest(sandboxName, exclusion.key);
  } catch {
    return "baseline-unreadable";
  }
  const baselineStatus = evaluateBaselineExclusionRuntimeStatus(
    exclusion,
    currentAgent,
    currentBaselineDigest,
    undefined,
  );
  if (baselineStatus !== "live-policy-unreadable") return baselineStatus;
  try {
    const liveDigest = getLiveSandboxPolicyEntryDigest(sandboxName, exclusion.key);
    return evaluateBaselineExclusionRuntimeStatus(
      exclusion,
      currentAgent,
      currentBaselineDigest,
      liveDigest,
    );
  } catch {
    return "live-policy-unreadable";
  }
}

/** Run one baseline transaction against the sandbox's durable gateway binding. */
function withRecordedSandboxGateway(
  sandboxName: string,
  operation: (gatewayName: string) => boolean,
): boolean {
  assertNoOpenShellGatewayEndpointOverride();
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    console.error(`  Sandbox '${sandboxName}' is not registered; no policy changes were made.`);
    return false;
  }
  const gatewayName = resolveSandboxGatewayName(sandbox);
  // Never rewrite process.env here: two sandbox operations may run in the
  // same CLI process. Every live read/write receives this binding explicitly.
  return operation(gatewayName);
}

type BaselineTransitionReconciliation =
  | { state: "none" }
  | { state: "excluded" | "restored" }
  | { state: "resume"; transition: registry.BaselineExclusionTransition };

function registryTransitionStep(action: () => boolean, failureMessage: string): boolean {
  try {
    if (action()) return true;
  } catch {
    // The durable journal remains authoritative; do not hide it with a second
    // best-effort mutation after a persistence exception.
  }
  console.error(`  ${failureMessage}`);
  return false;
}

type LiveBaselineEntryState =
  | { state: "absent"; digest: null }
  | { state: "present"; digest: string }
  | { state: "invalid"; digest: null };

function inspectLiveBaselineEntry(policy: string, key: string): LiveBaselineEntryState {
  try {
    const document = YAML.parse(policy);
    if (!isPolicyDocument(document)) {
      return { state: "invalid", digest: null };
    }
    if (document.network_policies === undefined || document.network_policies === null) {
      return { state: "absent", digest: null };
    }
    if (!isPolicyObject(document.network_policies)) return { state: "invalid", digest: null };
    if (!Object.prototype.hasOwnProperty.call(document.network_policies, key)) {
      return { state: "absent", digest: null };
    }
    const entry = document.network_policies[key];
    return isPolicyObject(entry)
      ? { state: "present", digest: digestBaselineEntry(entry) }
      : { state: "invalid", digest: null };
  } catch {
    return { state: "invalid", digest: null };
  }
}

/**
 * Recover an interrupted registry/live-policy transaction from exact live
 * state. The journal is finalized only at its exact target and rolled back
 * only at its exact source; any third state remains visible and fail-closed.
 */
function reconcileBaselineExclusionTransition(
  sandboxName: string,
  requestedKey: string,
  gatewayName: string,
): BaselineTransitionReconciliation | null {
  const transition = registry.getBaselineExclusionTransition(sandboxName);
  if (!transition) return { state: "none" };
  const key = transition.exclusion.key;
  if (key !== requestedKey) {
    console.error(
      `  Baseline policy repair for '${key}' is still pending. Re-run 'policy ${transition.operation} ${key}' before changing another baseline entry.`,
    );
    return null;
  }
  if (transition.operation === "restore") {
    const committed = registry
      .getBaselineExclusions(sandboxName)
      .find((entry) => entry.key === transition.exclusion.key);
    if (!committed || !isDeepStrictEqual(committed, transition.exclusion)) {
      console.error(
        `  The durable exclusion for '${key}' changed during the pending restore. The journal was preserved; inspect registry intent before retrying.`,
      );
      return null;
    }
  }
  const currentPolicy = readCurrentSandboxPolicy(sandboxName, gatewayName);
  if (!currentPolicy) {
    console.error(
      `  Could not inspect the live policy needed to repair the pending '${transition.operation}' for '${key}'. The journal remains pending and rebuild is blocked.`,
    );
    return null;
  }
  const live = inspectLiveBaselineEntry(currentPolicy, key);
  const atTarget =
    transition.targetLiveDigest === null
      ? live.state === "absent"
      : live.state === "present" && live.digest === transition.targetLiveDigest;
  if (atTarget) {
    if (!finalizeBaselineExclusionTransition(sandboxName, transition)) return null;
    return { state: transition.operation === "exclude" ? "excluded" : "restored" };
  }

  const atSource =
    transition.operation === "exclude"
      ? live.state === "present" && live.digest === transition.exclusion.digest
      : live.state === "absent";
  if (atSource) {
    const committed = registry
      .getBaselineExclusions(sandboxName)
      .some((entry) => entry.key === transition.exclusion.key);
    // A re-exclude can begin from a pre-existing inconsistent record. Preserve
    // its journal and resume the exact live mutation instead of hiding that
    // divergence by returning to the already-inconsistent committed state.
    if (transition.operation === "exclude" && committed) {
      return { state: "resume", transition };
    }
    if (
      !registryTransitionStep(
        () => registry.clearBaselineExclusionTransition(sandboxName, transition.id),
        `The live policy remains at the pre-${transition.operation} state for '${key}', but the durable journal could not be rolled back. Re-run the same command; rebuild remains blocked.`,
      )
    ) {
      return null;
    }
    return { state: transition.operation === "exclude" ? "restored" : "excluded" };
  }

  console.error(
    `  Live baseline entry '${key}' matches neither side of the pending '${transition.operation}' transaction. The journal was preserved; inspect the live policy and repair it before rebuilding.`,
  );
  return null;
}

function beginBaselineExclusionTransition(
  sandboxName: string,
  operation: registry.BaselineExclusionTransitionOperation,
  exclusion: registry.BaselineExclusionEntry,
  targetLiveDigest: string | null,
): registry.BaselineExclusionTransition | null {
  const transition: registry.BaselineExclusionTransition = {
    id: randomUUID(),
    operation,
    exclusion,
    targetLiveDigest,
    startedAt: new Date().toISOString(),
  };
  return registryTransitionStep(
    () => registry.beginBaselineExclusionTransition(sandboxName, transition),
    `Could not record the pending baseline '${operation}' for '${sandboxName}'; no live policy changes were made.`,
  )
    ? transition
    : null;
}

function restoreTransitionCanFinalize(
  sandboxName: string,
  transition: registry.BaselineExclusionTransition,
): boolean {
  if (transition.operation !== "restore") return true;
  const committed = registry
    .getBaselineExclusions(sandboxName)
    .find((entry) => entry.key === transition.exclusion.key);
  if (!committed || !isDeepStrictEqual(committed, transition.exclusion)) {
    console.error(
      `  The durable exclusion for '${transition.exclusion.key}' no longer matches the pending restore. The journal was preserved; rebuild remains blocked.`,
    );
    return false;
  }
  let currentBaselineDigest: string | null;
  try {
    currentBaselineDigest = getSandboxBaselineEntryDigest(sandboxName, transition.exclusion.key);
  } catch {
    console.error(
      `  The current release baseline for '${transition.exclusion.key}' is unreadable. The pending restore was not finalized; rebuild remains blocked.`,
    );
    return false;
  }
  if (currentBaselineDigest !== transition.targetLiveDigest) {
    console.error(
      `  The current release baseline for '${transition.exclusion.key}' changed during the pending restore. The journal was preserved; re-review the current scope before repairing it.`,
    );
    return false;
  }
  return true;
}

function finalizeBaselineExclusionTransition(
  sandboxName: string,
  transition: registry.BaselineExclusionTransition,
): boolean {
  if (!restoreTransitionCanFinalize(sandboxName, transition)) return false;
  return registryTransitionStep(
    () => registry.commitBaselineExclusionTransition(sandboxName, transition.id),
    `The live policy was updated for '${transition.exclusion.key}', but the durable journal could not be finalized. Re-run 'policy ${transition.operation} ${transition.exclusion.key}' to reconcile it; rebuild remains blocked.`,
  );
}

function compensateBaselineExclusionTransition(
  sandboxName: string,
  transition: registry.BaselineExclusionTransition,
): boolean {
  return registryTransitionStep(
    () => registry.clearBaselineExclusionTransition(sandboxName, transition.id),
    `Failed to roll back the pending baseline '${transition.operation}' for '${transition.exclusion.key}'. The durable journal was preserved; re-run the same command before rebuilding '${sandboxName}'.`,
  );
}

function settleBaselineExclusionTransitionAfterPush(
  sandboxName: string,
  transition: registry.BaselineExclusionTransition,
  pushSucceeded: boolean,
  canRollbackAtSource: boolean,
  gatewayName: string,
): boolean {
  const currentPolicy = readCurrentSandboxPolicy(sandboxName, gatewayName);
  if (!currentPolicy) {
    console.error(
      `  Could not verify the live '${transition.operation}' result for '${transition.exclusion.key}'. The durable journal was preserved and rebuild remains blocked.`,
    );
    return false;
  }
  const live = inspectLiveBaselineEntry(currentPolicy, transition.exclusion.key);
  const atTarget =
    transition.targetLiveDigest === null
      ? live.state === "absent"
      : live.state === "present" && live.digest === transition.targetLiveDigest;
  if (atTarget) {
    return finalizeBaselineExclusionTransition(sandboxName, transition);
  }
  const atSource =
    transition.operation === "exclude"
      ? live.state === "present" && live.digest === transition.exclusion.digest
      : live.state === "absent";
  if (!pushSucceeded && atSource && canRollbackAtSource) {
    compensateBaselineExclusionTransition(sandboxName, transition);
    return false;
  }
  const state = atSource ? "the pre-mutation state" : "an unexpected third state";
  console.error(
    `  Live baseline entry '${transition.exclusion.key}' is in ${state} after the '${transition.operation}' attempt. The durable journal was preserved; re-run the same command before rebuilding.`,
  );
  return false;
}

function attemptBaselineTransitionPolicyPush(
  sandboxName: string,
  updatedPolicy: string,
  options: { nonFatal?: boolean },
  gatewayName: string,
): boolean {
  try {
    return pushPolicyYaml(sandboxName, updatedPolicy, {
      ...options,
      nonFatal: true,
      gatewayName,
    });
  } catch {
    console.error(
      `  The live policy update for '${sandboxName}' raised an unexpected error; verifying the journal before deciding whether it applied.`,
    );
    return false;
  }
}

/**
 * Exclude a baseline entry from the running sandbox policy and record the
 * approval, bound to `digest`, in the registry so create/rebuild replay it.
 */
function excludeBaselineEntry(
  sandboxName: string,
  key: string,
  digest: string,
  options: { nonFatal?: boolean } = {},
): boolean {
  return withRecordedSandboxGateway(sandboxName, (gatewayName) =>
    excludeBaselineEntryOnGateway(sandboxName, key, digest, options, gatewayName),
  );
}

function excludeBaselineEntryOnGateway(
  sandboxName: string,
  key: string,
  digest: string,
  options: { nonFatal?: boolean },
  gatewayName: string,
): boolean {
  const reconciled = reconcileBaselineExclusionTransition(sandboxName, key, gatewayName);
  if (!reconciled) return false;
  if (reconciled.state === "excluded") return true;
  if (reconciled.state === "resume" && reconciled.transition.operation !== "exclude") {
    console.error(`  Finish the pending baseline restore for '${key}' before excluding it again.`);
    return false;
  }
  const appliedOwner = findAppliedPolicyOwnerForKey(sandboxName, key);
  if (appliedOwner) {
    console.error(
      `  Baseline entry '${key}' is also owned by applied policy '${appliedOwner}'. Remove that policy before excluding the baseline key; no policy changes were made.`,
    );
    return false;
  }
  const currentPolicy = readCurrentSandboxPolicy(sandboxName, gatewayName);
  if (!currentPolicy) {
    console.error(`  Could not read current policy for sandbox '${sandboxName}'.`);
    return false;
  }
  const live = inspectLiveBaselineEntry(currentPolicy, key);
  if (live.state === "invalid") {
    console.error(
      `  Live baseline entry '${key}' could not be classified safely; no policy changes were made.`,
    );
    return false;
  }
  if (live.state === "present" && live.digest !== digest) {
    console.error(
      `  Baseline entry '${key}' changed after preview. Rerun the command to review its current scope; no policy changes were made.`,
    );
    return false;
  }
  const { policy: updated, removed } = removeBaselineEntryFromPolicy(currentPolicy, key);
  const previousExclusion = registry
    .getBaselineExclusions(sandboxName)
    .find((entry) => entry.key === key);
  const sandbox = registry.getSandbox(sandboxName);
  const appliedAgentVersion = sandbox?.agentVersion ?? null;
  const exclusion: registry.BaselineExclusionEntry = {
    version: 1,
    agent: sandbox?.agent || "openclaw",
    key,
    digest,
    acknowledgedAt: new Date().toISOString(),
    appliedAgentVersion,
  };
  if (!removed) {
    if (reconciled.state === "resume") {
      return finalizeBaselineExclusionTransition(sandboxName, reconciled.transition);
    }
    return registryTransitionStep(
      () => registry.addBaselineExclusion(sandboxName, exclusion),
      `The already-narrow live policy could not be recorded for '${sandboxName}'.`,
    );
  }
  const transition =
    reconciled.state === "resume"
      ? reconciled.transition
      : beginBaselineExclusionTransition(sandboxName, "exclude", exclusion, null);
  if (!transition) return false;
  const pushSucceeded = attemptBaselineTransitionPolicyPush(
    sandboxName,
    updated,
    options,
    gatewayName,
  );
  // When this was a fresh exclusion, a failed push that verifies at the exact
  // source can clear the journal. A re-exclude that began with committed/live
  // divergence must retain it until the live side reaches the target.
  return settleBaselineExclusionTransitionAfterPush(
    sandboxName,
    transition,
    pushSucceeded,
    !previousExclusion,
    gatewayName,
  );
}

/**
 * Restore a previously excluded baseline entry against the current release
 * baseline and drop its recorded exclusion. When the release removed the entry
 * entirely, only the registry record is cleared.
 */
type RestoreBaselineEntryOptions = {
  nonFatal?: boolean;
  expectedTargetDigest?: string | null;
};

function restoreBaselineEntry(
  sandboxName: string,
  key: string,
  options: RestoreBaselineEntryOptions = {},
): boolean {
  return withRecordedSandboxGateway(sandboxName, (gatewayName) =>
    restoreBaselineEntryOnGateway(sandboxName, key, options, gatewayName),
  );
}

function restoreBaselineEntryOnGateway(
  sandboxName: string,
  key: string,
  options: RestoreBaselineEntryOptions,
  gatewayName: string,
): boolean {
  // Resolve the current agent baseline before changing either durable or live
  // state. A missing non-OpenClaw baseline must not be mistaken for a release
  // that intentionally removed this key.
  // Bind the mutation to the target disclosed before acknowledgement. This
  // check precedes transaction recovery because reconciliation can change the
  // durable journal.
  let entry: PolicyObject | null;
  try {
    entry = getSandboxBaselineEntry(sandboxName, key);
  } catch {
    console.error(
      `  The current release baseline for '${key}' is unreadable. No policy changes were made.`,
    );
    return false;
  }
  const target = entry ? { entry, digest: digestBaselineEntry(entry) } : null;
  const targetDigest = target?.digest ?? null;
  if (
    Object.prototype.hasOwnProperty.call(options, "expectedTargetDigest") &&
    targetDigest !== options.expectedTargetDigest
  ) {
    console.error(
      `  Baseline entry '${key}' changed after preview. Rerun the command to review its current scope; no policy changes were made.`,
    );
    return false;
  }

  const reconciled = reconcileBaselineExclusionTransition(sandboxName, key, gatewayName);
  if (!reconciled) return false;
  if (reconciled.state === "restored") return true;
  if (reconciled.state === "resume" && reconciled.transition.operation !== "restore") {
    console.error(`  Finish the pending baseline exclusion for '${key}' before restoring it.`);
    return false;
  }
  const recordedExclusion = registry
    .getBaselineExclusions(sandboxName)
    .find((entry) => entry.key === key);
  if (!recordedExclusion) {
    console.error(
      `  The exclusion for '${key}' is not recorded; no live policy changes were made.`,
    );
    return false;
  }
  const currentPolicy = readCurrentSandboxPolicy(sandboxName, gatewayName);
  if (!currentPolicy) {
    console.error(`  Could not read current policy for sandbox '${sandboxName}'.`);
    return false;
  }
  if (!target) {
    return registryTransitionStep(
      () => registry.removeBaselineExclusion(sandboxName, key),
      `The obsolete exclusion for '${key}' could not be cleared; no live policy changes were made.`,
    );
  }
  const live = inspectLiveBaselineEntry(currentPolicy, key);
  if (live.state === "invalid") {
    console.error(
      `  Live baseline entry '${key}' could not be classified safely; no policy changes were made.`,
    );
    return false;
  }
  if (live.state === "present" && live.digest !== targetDigest) {
    console.error(
      `  Live baseline entry '${key}' differs from the current release baseline. Refusing to overwrite it; repair the live policy before restoring this exclusion.`,
    );
    return false;
  }
  if (live.state === "present" && live.digest === targetDigest) {
    if (reconciled.state === "resume") {
      return finalizeBaselineExclusionTransition(sandboxName, reconciled.transition);
    }
    return registryTransitionStep(
      () => registry.removeBaselineExclusion(sandboxName, key),
      `The restored live policy could not be recorded for '${sandboxName}'.`,
    );
  }
  const transition =
    reconciled.state === "resume"
      ? reconciled.transition
      : beginBaselineExclusionTransition(sandboxName, "restore", recordedExclusion, targetDigest);
  if (!transition) return false;
  const updated = mergeBaselineEntryIntoPolicy(currentPolicy, key, target.entry);
  const pushSucceeded = attemptBaselineTransitionPolicyPush(
    sandboxName,
    updated,
    options,
    gatewayName,
  );
  return settleBaselineExclusionTransitionAfterPush(
    sandboxName,
    transition,
    pushSucceeded,
    true,
    gatewayName,
  );
}

/**
 * Ask one preset-picker question on stderr and resolve to the raw answer.
 *
 * Rejects with `code: "EOF"` when readline closes before the question is
 * answered. A boot unit runs `nemoclaw <sandbox> policy-add < /dev/null`, and
 * the `question` callback then never fires. Without this handler the picker
 * promise never settles and the command exits 0 having applied nothing
 * (#7418).
 *
 * `finish` marks the prompt done before closing readline, because
 * `rl.close()` itself emits `close`. Only a close that arrives before an
 * answer rejects.
 *
 * Rejects with `code: "SIGINT"` when the operator presses Ctrl-C, and
 * re-raises the signal so the process dies by SIGINT. Readline emits `close`
 * for an interrupt as well as for EOF, so without a SIGINT listener an
 * interrupt would be reported as a closed stdin.
 *
 * This matches the `prompt()` contract in `credentials/store.ts` (#5976).
 */
function askPreset(question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Re-attach stdin to the event loop — unref() on exit is sticky and
    // would otherwise leave a follow-up prompt waiting on a detached handle.
    if (typeof process.stdin.ref === "function") process.stdin.ref();
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      rl.close();
      // pause+unref so the process exits naturally after the last prompt.
      // The matching ref() above keeps subsequent prompts working.
      if (typeof process.stdin.pause === "function") process.stdin.pause();
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      settle();
    };
    // Runs before the `close` listener below, so an interrupt settles as
    // SIGINT and the close that follows is ignored.
    rl.on("SIGINT", () => {
      finish(() => reject(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" })));
      process.kill(process.pid, "SIGINT");
    });
    rl.on("close", () =>
      finish(() => reject(Object.assign(new Error("Prompt closed before input"), { code: "EOF" }))),
    );
    rl.question(question, (answer: string) => finish(() => resolve(answer)));
  });
}

/**
 * Interactive preset picker for the `policy-remove` command. Prompts on
 * stderr and resolves to the chosen preset name, or `null` if the user
 * cancels or enters an invalid selection. Rejects with `code: "EOF"` when
 * stdin closes before an answer (see `askPreset`).
 */
async function selectForRemoval(
  items: PresetInfo[],
  { applied = [] }: SelectionOptions = {},
): Promise<string | null> {
  const appliedItems = items.filter((item) => applied.includes(item.name));
  if (appliedItems.length === 0) {
    process.stderr.write("\n  No presets are currently applied.\n\n");
    return null;
  }
  process.stderr.write("\n  Applied presets:\n");
  appliedItems.forEach((item, i) => {
    const description = item.description ? ` — ${item.description}` : "";
    process.stderr.write(`    ${i + 1}) ${item.name}${description}\n`);
  });
  process.stderr.write("\n");
  const trimmed = (await askPreset("  Choose preset to remove: ")).trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) {
    process.stderr.write("\n  Invalid preset number.\n");
    return null;
  }
  const item = appliedItems[Number(trimmed) - 1];
  if (!item) {
    process.stderr.write("\n  Invalid preset number.\n");
    return null;
  }
  return item.name;
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
  options: {
    custom?: { sourcePath?: string };
    expectedExistingNetworkPolicyContent?: string | null;
    nonFatal?: boolean;
    skipRegistryUpdate?: boolean;
    suppressDisclosure?: boolean;
    disclosedPresetState?: PresetPolicyState | null;
  } = {},
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
    const { errors: semanticErrors, warnings: semanticWarnings } = splitSemanticFindings(
      validatePolicySemantics({ network_policies: np }),
    );
    for (const finding of semanticWarnings) {
      console.warn(
        `  Preset '${presetName}' has a policy warning at ${finding.path}: ${finding.message}`,
      );
    }
    if (semanticErrors.length > 0) {
      for (const finding of semanticErrors) {
        console.error(
          `  Preset '${presetName}' has an unsafe endpoint at ${finding.path}: ${finding.message}`,
        );
      }
      return false;
    }
  }

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }
  const excludedCollision = findExcludedBaselineKeyForPolicy(sandboxName, presetContent);
  if (excludedCollision) {
    console.error(
      `  Network policy key '${excludedCollision}' is reserved by a baseline exclusion. Restore that baseline key before applying '${presetName}'.`,
    );
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
  if (Object.prototype.hasOwnProperty.call(options, "expectedExistingNetworkPolicyContent")) {
    let collision: string | null = null;
    try {
      collision = findUnexpectedExistingPolicyKey(
        currentPolicy,
        presetEntries,
        options.expectedExistingNetworkPolicyContent ?? null,
      );
    } catch {
      console.error(
        `  Could not validate network policy key ownership for '${presetName}'; refusing to apply it.`,
      );
      return false;
    }
    if (collision) {
      console.error(
        `  Network policy key '${collision}' does not match the exact state owned by '${presetName}'; refusing to replace it.`,
      );
      return false;
    }
  }
  const merged = mergePresetIntoPolicy(currentPolicy, presetEntries);

  const presetState = classifyPresetEntries(currentPolicy, presetEntries);
  const disclosedStateStillCurrent =
    Object.prototype.hasOwnProperty.call(options, "disclosedPresetState") &&
    options.disclosedPresetState === presetState;
  if (!options.suppressDisclosure && !disclosedStateStillCurrent) {
    logPresetScopeForState(presetName, presetContent, presetState);
  }

  // Ownership-aware callers use a successful `policy set --wait` as part of
  // their live-policy/registry transaction, even when the desired document is
  // byte-for-byte equivalent to the current policy. Skipping that submission
  // would let the caller commit its ownership reservation without observing a
  // failed gateway mutation. Ordinary preset re-application remains a no-op.
  const requiresOwnedKeyRefresh = Object.prototype.hasOwnProperty.call(
    options,
    "expectedExistingNetworkPolicyContent",
  );
  const policyChanged = requiresOwnedKeyRefresh || !policyDocumentsMatch(currentPolicy, merged);

  // Run before creating temp resources so a missing-binary exit doesn't
  // orphan files in $TMPDIR (the finally cleanup doesn't run on process.exit).
  if (policyChanged && !assertOpenshellResolvable(options)) return false;

  if (policyChanged) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
    const tmpFile = path.join(tmpDir, "policy.yaml");
    fs.writeFileSync(tmpFile, merged, { encoding: "utf-8", mode: 0o600 });

    try {
      if (!setPolicyFile(tmpFile, sandboxName, options)) return false;

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
  }

  // Some multi-resource lifecycle callers reserve ownership in the registry
  // before mutating the live gateway. That ordering prevents a successful
  // policy set followed by a registry-write failure from leaving an unowned
  // live key. They explicitly request no second registry write here.
  if (options.skipRegistryUpdate) return true;

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
        `registry, so it will not appear in policy list or status. Recover or ` +
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
  const presetContents: Array<{
    content: string;
    name: string;
    state: PresetPolicyState;
  }> = [];
  const originalPolicy = merged;

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
    const excludedCollision = findExcludedBaselineKeyForPolicy(sandboxName, presetContent);
    if (excludedCollision) {
      console.error(
        `  Network policy key '${excludedCollision}' is reserved by a baseline exclusion. Restore that baseline key before applying '${presetName}'.`,
      );
      return false;
    }

    const state = classifyPresetEntries(merged, presetEntries);
    presetContents.push({ content: presetContent, name: presetName, state });
    merged = mergePresetIntoPolicy(merged, presetEntries);
  }

  for (const preset of presetContents) {
    logPresetScopeForState(preset.name, preset.content, preset.state);
  }

  const policyChanged = !policyDocumentsMatch(originalPolicy, merged);

  // Run before creating temp resources so a missing-binary exit doesn't
  // orphan files in $TMPDIR (the finally cleanup doesn't run on process.exit).
  if (policyChanged) assertOpenshellResolvable();

  if (policyChanged) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
    const tmpFile = path.join(tmpDir, "policy.yaml");
    fs.writeFileSync(tmpFile, merged, { encoding: "utf-8", mode: 0o600 });

    try {
      run(buildPolicySetCommand(tmpFile, sandboxName));

      for (const preset of presetContents.filter((entry) => entry.state !== "match")) {
        console.log(`  Applied preset: ${preset.name}`);
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
  const { errors: semanticErrors, warnings: semanticWarnings } = splitSemanticFindings(
    validatePolicySemantics(parsed),
  );
  for (const finding of semanticWarnings) {
    console.warn(
      `  Preset '${presetName}' has a policy warning at ${finding.path}: ${finding.message}: ${filePath}`,
    );
  }
  if (semanticErrors.length > 0) {
    for (const finding of semanticErrors) {
      console.error(
        `  Preset '${presetName}' has an unsafe endpoint at ${finding.path}: ${finding.message}: ${filePath}`,
      );
    }
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

/** Return whether registered custom content owns an exact live network-policy key. */
function customPresetOwnsNetworkPolicyKey(sandboxName: string, policyKey: string): boolean {
  let candidates: ReturnType<typeof registry.getCustomPolicies>;
  try {
    candidates = [];
    for (const entry of registry.getCustomPolicies(sandboxName)) {
      const keys = parsePresetPolicyKeysForOwnership(entry.content);
      if (keys === null) {
        throw new Error("invalid registered custom policy content");
      }
      if (keys.includes(policyKey)) candidates.push(entry);
    }
  } catch {
    throw new Error(
      `Could not inspect registered custom policy ownership for '${policyKey}' in sandbox '${sandboxName}'; refusing to reconcile overlapping built-in policy content.`,
    );
  }
  if (candidates.length === 0) return false;

  let rawPolicy: string;
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName));
  } catch {
    throw new Error(
      `Could not read live policy ownership for '${policyKey}' in sandbox '${sandboxName}'; refusing to reconcile overlapping built-in policy content.`,
    );
  }
  const states = candidates.map((entry) =>
    inspectPresetContentGatewayState({
      readPolicy: () => rawPolicy,
      parseCurrentPolicy: parseCurrentPolicyOrEmpty,
      extractPresetEntries,
      presetContent: entry.content,
      policyKey,
    }),
  );
  if (states.includes("match")) return true;
  if (states.includes(null)) {
    throw new Error(
      `Could not determine live policy ownership for '${policyKey}' in sandbox '${sandboxName}'; refusing to reconcile overlapping built-in policy content.`,
    );
  }
  return false;
}

/** Drop built-in registry attribution without mutating overlapping live policy content. */
function removeBuiltinPresetAttribution(sandboxName: string, presetName: string): void {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return;
  const policies = (sandbox.policies ?? []).filter((name) => name !== presetName);
  if (policies.length === (sandbox.policies ?? []).length) return;
  registry.updateSandbox(sandboxName, { policies });
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
  let sandboxAgent: string | null = null;
  try {
    sandboxAgent = registry.getSandbox(sandboxName)?.agent ?? null;
  } catch {
    sandboxAgent = null;
  }
  return inspectGatewayPresetNames({
    readPolicy: () => runCapture(buildPolicyGetFullCommand(sandboxName), { ignoreError: true }),
    parseCurrentPolicy: parseCurrentPolicyOrEmpty,
    extractPresetEntries,
    sources: () => [
      ...listPresets({ agent: sandboxAgent }).map((preset) => ({
        name: preset.name,
        content: loadPresetForSandbox(sandboxName, preset.name),
      })),
      ...registry.getCustomPolicies(sandboxName).map((entry) => ({
        name: entry.name,
        content: entry.content,
      })),
    ],
  });
}

/**
 * Compare the full network-policy entries in a preset with the live gateway
 * policy. Unlike getGatewayPresets(), this detects same-key policy drift.
 */
function getPresetContentGatewayState(
  sandboxName: string,
  presetContent: string,
  policyKey?: string,
): "match" | "absent" | "drift" | null {
  return inspectPresetContentGatewayState({
    readPolicy: () => runCapture(buildPolicyGetCommand(sandboxName)),
    parseCurrentPolicy: parseCurrentPolicyOrEmpty,
    extractPresetEntries,
    presetContent,
    policyKey,
  });
}

function presetContentMatchesGateway(sandboxName: string, presetContent: string): boolean | null {
  const state = getPresetContentGatewayState(sandboxName, presetContent);
  return state === null ? null : state === "match";
}

/**
 * Interactive preset picker for the `policy add` command. Prints the
 * presets on stderr (● applied, ○ not applied), prompts for a number, and
 * resolves to the chosen preset name or `null` on cancel. Rejects with
 * `code: "EOF"` when stdin closes before an answer (see `askPreset`).
 */
async function selectFromList(
  items: PresetInfo[],
  { applied = [] }: SelectionOptions = {},
): Promise<string | null> {
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
  const trimmed = (await askPreset(question)).trim();
  const effectiveInput = trimmed || (defaultNum ? String(defaultNum) : "");
  if (!effectiveInput) return null;
  if (!/^\d+$/.test(effectiveInput)) {
    process.stderr.write("\n  Invalid preset number.\n");
    return null;
  }
  const item = items[Number(effectiveInput) - 1];
  if (!item) {
    process.stderr.write("\n  Invalid preset number.\n");
    return null;
  }
  if (applied.includes(item.name)) {
    // The picker has no live-policy context to classify drift; the named
    // path (`policy add <preset>`) re-applies edited presets (#7323).
    process.stderr.write(`\n  Preset '${item.name}' is already applied.\n`);
    process.stderr.write(
      `  If its preset file changed, run '${CLI_NAME} <sandbox> policy add ${item.name}' to re-apply it.\n`,
    );
    return null;
  }
  return item.name;
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
  customPresetOwnsNetworkPolicyKey,
  excludeBaselineEntry,
  extractPresetEntries,
  filterSetupPolicyPresets,
  getAppliedPresets,
  getBaselineExclusionRuntimeStatus,
  getGatewayPresets,
  getLiveSandboxPolicyEntryDigest,
  getPresetContentGatewayState,
  getPresetEndpoints,
  getPresetValidationWarning,
  getSandboxBaselineEntry,
  getSandboxBaselineEntryDigest,
  isMessagingChannelPolicyPreset,
  listCustomPresets,
  listPresets,
  listSetupPolicyPresets,
  loadPreset,
  loadPresetForSandbox,
  loadPresetFromFile,
  logPresetNoNewEgress,
  logPresetScope,
  logPresetScopeForState,
  mergePresetIntoPolicy,
  mergePresetNamesIntoPolicy,
  networkPoliciesHasAllowedIps,
  PERMISSIVE_POLICY_PATH,
  PRESETS_DIR,
  parseCurrentPolicyOrEmpty as parseCurrentPolicy,
  parsePresetPolicyKeys,
  presetContentMatchesGateway,
  removeBuiltinPresetAttribution,
  removePreset,
  removePresetFromPolicy,
  renderPresetScope,
  resolveAgentBaselinePolicy,
  resolvePermissivePolicyPath,
  resolveSandboxBaselinePolicy,
  restoreBaselineEntry,
  selectForRemoval,
  selectFromList,
  setupPolicyPresetSupported,
};
