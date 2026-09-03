// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import {
  openshellNotFoundDiagnosticLines,
  namedOpenShellGateway,
  selectedOpenShellGateway,
  syncCliOpenShellSandboxPolicyReader,
  syncCliOpenShellSandboxPolicyWriter,
  tryResolveOpenshellBinary,
  type OpenShellSandboxPolicySetOutcome,
  type OpenShellSandboxPolicySetSubmission,
  type OpenShellSandboxResult,
} from "../adapters/openshell/sandbox-policy-cli";
import { PolicyObservationError } from "../adapters/openshell/policy-state";
export { isPolicyObservationError } from "../adapters/openshell/policy-state";
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
import { ROOT } from "../runner";
import { diagnosticPreview, isValidName, NAME_ALLOWED_FORMAT } from "../sandbox-name-contract";
import { redact } from "../security/redact";
import * as registry from "../state/registry";
import {
  digestBaselineEntry,
  getBaselineEntry,
  mergeBaselineEntryIntoPolicy,
  removeBaselineEntryFromPolicy,
} from "./baseline-exclusion";
import { inspectGatewayPresetNames, inspectPresetContentGatewayState } from "./gateway-state";
import { reconcileTeamsOutlookLoginCredentialBinding } from "./microsoft-login-credential-binding";
import {
  parseOpenShellPolicy,
  stripProviderComposedPolicies,
  type OpenShellPolicyInspection,
  withoutProviderComposedPolicies,
} from "../adapters/openshell/policy-boundary";
import {
  findUnexpectedExistingPolicyKey,
  PERSONAL_OPEN_INTERNET_PRESET_NAME,
} from "./preset-ownership";
import {
  isPolicyDocument,
  isPolicyObject,
  isPresetPolicyMap,
  materializeLocalInferencePresetPorts,
  type PolicyDocument,
  type PolicyObject,
  type PolicyValue,
  parseNetworkPolicies,
} from "./preset-parsing";
import { escapeTerminalText, logPresetScope, renderPresetScope } from "./preset-scope-render";
import { parseAndValidateSandboxPolicy } from "./sandbox-policy-validation";
import { splitSemanticFindings, validatePolicySemantics } from "./semantic-validation";
import {
  type ExternalPolicyPreset,
  findUntrustedPrivatePolicyEndpointHost,
  isTrustedPrivatePolicyPinCapability,
  prepareTrustedPrivatePolicyPresets,
  type TrustedPrivatePolicyPinCapability,
} from "./trusted-private-endpoints";

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

const PERSONAL_OPEN_INTERNET_POLICY_KEY = "personal_open_internet";
const PERSONAL_OPEN_INTERNET_PORTS = new Set([80, 443]);

const MAX_PRESET_FILE_BYTES = 10_000_000;

type PresetInfo = {
  file: string;
  name: string;
  description: string;
};

type SelectionOptions = {
  applied?: string[];
};

type MessagingPolicyConfig = Readonly<Record<string, string>>;

type PresetLoadOptions = {
  agent?: string | null;
  sandboxName?: string;
  credentialBoundMessagingChannels?: readonly string[];
  messagingConfig?: MessagingPolicyConfig | null;
};

type PresetListOptions = {
  agent?: string | null;
};

type MergePresetNamesOptions = {
  agent?: string | null;
  sandboxName?: string;
  credentialBoundMessagingChannels?: readonly string[];
  messagingConfig?: MessagingPolicyConfig | null;
};

type SandboxPresetLoadOptions = {
  includeMessagingCredentialBindings?: boolean;
  messagingConfig?: MessagingPolicyConfig | null;
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
  const content = fs.readFileSync(file, "utf-8");
  return name === "local-inference" ? materializeLocalInferencePresetPorts(content) : content;
}

function messagingChannelIdForPreset(presetName: string): string | null {
  return (
    listMessagingPolicyPresetMetadata().find((preset) => preset.presetName === presetName)
      ?.channelId ?? null
  );
}

function stripMessagingCredentialBindings(content: string): string | null {
  let parsed: PolicyValue;
  try {
    parsed = YAML.parse(content);
  } catch {
    return null;
  }
  if (!isPolicyDocument(parsed)) return null;
  const networkPolicies = parsed.network_policies;
  if (!networkPolicies || !isPolicyObject(networkPolicies)) return content;

  let changed = false;
  for (const policy of Object.values(networkPolicies)) {
    if (!isPolicyObject(policy) || !Array.isArray(policy.endpoints)) continue;
    for (const endpoint of policy.endpoints) {
      if (!isPolicyObject(endpoint) || !Object.hasOwn(endpoint, "credential_binding")) continue;
      delete endpoint.credential_binding;
      changed = true;
    }
  }
  return changed ? YAML.stringify(parsed) : content;
}

function loadPresetForAgent(name: string, options: PresetLoadOptions = {}): string | null {
  const channelPreset = loadMessagingChannelPolicyPreset(name, {
    agent: options.agent,
    sandboxName: options.sandboxName,
    messagingConfig: options.messagingConfig,
  });
  if (channelPreset) {
    const credentialBoundChannels = options.credentialBoundMessagingChannels;
    if (credentialBoundChannels === undefined) return channelPreset;
    const channelId = messagingChannelIdForPreset(name);
    return channelId && !credentialBoundChannels.includes(channelId)
      ? stripMessagingCredentialBindings(channelPreset)
      : channelPreset;
  }
  if (isMessagingChannelPolicyPreset(name)) return null;
  return loadCentralPreset(name);
}

function loadPreset(name: string): string | null {
  return loadPresetForAgent(name, { agent: "openclaw" });
}

function getCredentialBoundMessagingChannelsFromEntry(
  sandbox: ReturnType<typeof registry.getSandbox>,
): string[] {
  const disabledChannels = new Set(registry.getDisabledMessagingChannelsFromEntry(sandbox));
  return registry
    .getConfiguredMessagingChannelsFromEntry(sandbox)
    .filter((channel) => !disabledChannels.has(channel));
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

const CUSTOM_POLICY_KEY_PREFIX = "nemoclaw_custom__";

function customPolicyKey(presetName: string, key: string): string {
  return `${CUSTOM_POLICY_KEY_PREFIX}${presetName}__${key}`;
}

function parseCustomPolicyKey(key: string): { presetName: string; originalKey: string } | null {
  if (!key.startsWith(CUSTOM_POLICY_KEY_PREFIX)) return null;
  const separator = key.indexOf("__", CUSTOM_POLICY_KEY_PREFIX.length);
  if (separator < 0) return null;
  const presetName = key.slice(CUSTOM_POLICY_KEY_PREFIX.length, separator);
  const originalKey = key.slice(separator + 2);
  return presetName && originalKey ? { presetName, originalKey } : null;
}

function namespaceCustomPresetContent(presetName: string, content: string): string {
  const parsed = YAML.parse(content);
  if (!isPolicyDocument(parsed) || !isPolicyObject(parsed.network_policies)) {
    throw new Error(`Preset '${presetName}' has invalid or missing network_policies.`);
  }
  parsed.network_policies = Object.fromEntries(
    Object.entries(parsed.network_policies).map(([key, value]) => [
      customPolicyKey(presetName, key),
      value,
    ]),
  );
  return YAML.stringify(parsed);
}

function liveCustomPresetContentFromPolicy(current: string, presetName: string): string | null {
  const parsed = YAML.parse(current);
  if (!isPolicyDocument(parsed) || !isPolicyObject(parsed.network_policies)) return null;
  const entries = Object.fromEntries(
    Object.entries(parsed.network_policies).filter(([key]) => {
      return parseCustomPolicyKey(key)?.presetName === presetName;
    }),
  );
  return Object.keys(entries).length > 0
    ? YAML.stringify({ preset: { name: presetName }, network_policies: entries })
    : null;
}

function liveCustomPresetContent(sandboxName: string, presetName: string): string | null {
  const current = readCurrentSandboxPolicy(sandboxName);
  return current ? liveCustomPresetContentFromPolicy(current, presetName) : null;
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

/**
 * Resolve a preset across messaging, central or agent, and live custom sources.
 * Source misses stay silent so callers report only after the composite lookup fails.
 */
function loadPresetForSandbox(
  sandboxName: string,
  presetName: string,
  options: SandboxPresetLoadOptions = {},
): string | null {
  let sandboxAgent: string | null = null;
  let configuredMessagingChannels: string[] = [];
  let messagingConfig = options.messagingConfig;
  try {
    const sandbox = registry.getSandbox(sandboxName);
    sandboxAgent = sandbox?.agent ?? null;
    configuredMessagingChannels = getCredentialBoundMessagingChannelsFromEntry(sandbox);
    if (messagingConfig === undefined) {
      messagingConfig = registry.getMessagingChannelConfigFromEntry(sandbox);
    }
  } catch {
    sandboxAgent = null;
    configuredMessagingChannels = [];
  }

  const channelId = messagingChannelIdForPreset(presetName);
  if (options.includeMessagingCredentialBindings && channelId) {
    configuredMessagingChannels = [...new Set([...configuredMessagingChannels, channelId])];
  }
  let channelPresetContent: string | null;
  try {
    channelPresetContent = loadMessagingChannelPolicyPreset(presetName, {
      agent: sandboxAgent,
      sandboxName,
      messagingConfig,
    });
  } catch {
    return null;
  }
  if (channelPresetContent) {
    return channelId && !configuredMessagingChannels.includes(channelId)
      ? stripMessagingCredentialBindings(channelPresetContent)
      : channelPresetContent;
  }
  if (isMessagingChannelPolicyPreset(presetName)) return null;

  const builtinPresetContent = loadCentralPreset(presetName, { reportMissing: false });
  if (!builtinPresetContent) return liveCustomPresetContent(sandboxName, presetName);
  const resolvedPresetContent =
    loadAgentPresetContent(sandboxName, presetName, builtinPresetContent) || builtinPresetContent;
  return presetName === "outlook" &&
    sandboxAgent !== "hermes" &&
    configuredMessagingChannels.includes("teams")
    ? reconcileTeamsOutlookLoginCredentialBinding(resolvedPresetContent, sandboxName, true)
    : resolvedPresetContent;
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

function getPresetValidationWarning(
  presetName: string,
  options: { agent?: "openclaw" | "hermes" } = {},
): string | null {
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
    `To actually enable ${label} messaging, re-run '${CLI_NAME} onboard' and select ${label}`,
    "in the messaging channels step. Channel setup, pairing, and runtime",
    "configuration are wired up at onboard time and are not added by applying",
    "this preset alone.",
  ];
  const validationWarningLines = getMessagingPolicyPresetValidationWarnings({
    agent: options.agent,
  });
  lines.push(...(validationWarningLines[presetName] ?? []));

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
// test/runtime/policy/policy-mutation-read-failure.test.ts.
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
 * Pre-spawn check used at command entry points before an OpenShell mutation.
 * If the binary cannot be resolved, prints
 * every location checked and an install hint. Normal command entry points
 * exit nonzero; transactional lifecycle callers can request `nonFatal` and
 * retain control for rollback instead of surfacing the opaque
 * `spawnSync openshell ENOENT` (issue #4224).
 */
function assertOpenshellResolvable(options: { nonFatal?: boolean } = {}): boolean {
  if (tryResolveOpenshellBinary()) return true;
  for (const line of openshellNotFoundDiagnosticLines()) {
    console.error(line);
  }
  if (options.nonFatal) return false;
  process.exit(1);
}

/** Delete the private temp policy file and its directory, ignoring absence. */
function tempPolicyRetentionError(tmpDir: string, reason: string): Error {
  return new Error(
    `Could not remove the temporary policy directory '${tmpDir}' (${reason}). It still holds ` +
      "the composed sandbox policy; remove it before retrying.",
  );
}

function removeTempPolicyMaterial(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (error) {
    throw tempPolicyRetentionError(tmpDir, error instanceof Error ? error.message : String(error));
  }
  if (fs.existsSync(tmpDir)) throw tempPolicyRetentionError(tmpDir, "the path still exists");
}

function policyObservationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PolicyMutationContext {
  readonly gatewayName: string;
  readonly inspection: OpenShellPolicyInspection;
  readonly basePolicyDocument: string;
}

function requirePolicyObservation<T>(result: OpenShellSandboxResult<T>): T {
  if (result.ok) return result.value;
  const punctuation = /[.!?]$/u.test(result.error.message) ? "" : ".";
  throw new PolicyObservationError(
    `OpenShell sandbox policy inspection failed: ${result.error.message}${punctuation} Policy-dependent operations must stop.`,
    { policyReadError: result.error },
  );
}

function readLivePolicyDocument(
  sandboxName: string,
  gatewayName: string,
  scope: "base" | "effective",
  timeoutMs?: number,
): string {
  return requirePolicyObservation(
    syncCliOpenShellSandboxPolicyReader.readSandboxPolicy({
      target: namedOpenShellGateway(gatewayName),
      sandboxName,
      scope,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  ).document;
}

function readLivePolicyRevision(
  sandboxName: string,
  gatewayName: string,
  revision: number,
): string {
  return requirePolicyObservation(
    syncCliOpenShellSandboxPolicyReader.readSandboxPolicyRevision({
      target: namedOpenShellGateway(gatewayName),
      sandboxName,
      revision,
    }),
  ).document;
}

function inspectLivePolicyBoundary(
  sandboxName: string,
  operation: string,
  requestedGatewayName?: string,
): PolicyMutationContext {
  let sandbox: ReturnType<typeof registry.getSandbox>;
  try {
    sandbox = registry.getSandbox(sandboxName);
  } catch {
    throw new PolicyObservationError(
      `Refusing to ${operation}: sandbox '${sandboxName}' policy state is unavailable.`,
    );
  }
  if (!sandbox) {
    throw new PolicyObservationError(
      `Refusing to ${operation}: sandbox '${sandboxName}' policy state is unavailable.`,
    );
  }
  let recordedGatewayName: string | null;
  try {
    recordedGatewayName = resolveSandboxGatewayName(sandbox);
  } catch {
    throw new PolicyObservationError(
      `Refusing to ${operation}: the recorded sandbox gateway is unavailable or invalid.`,
    );
  }
  if (recordedGatewayName && requestedGatewayName && requestedGatewayName !== recordedGatewayName) {
    throw new PolicyObservationError(
      `Refusing to ${operation}: the requested gateway does not match the recorded sandbox gateway.`,
    );
  }
  let gatewayName: string;
  try {
    gatewayName =
      recordedGatewayName ?? requestedGatewayName ?? resolveSandboxGatewayName(undefined);
  } catch {
    throw new PolicyObservationError(
      `Refusing to ${operation}: the sandbox gateway is unavailable or invalid.`,
    );
  }
  const target = namedOpenShellGateway(gatewayName);
  const inspection = requirePolicyObservation(
    syncCliOpenShellSandboxPolicyReader.inspectSandboxPolicy({ target, sandboxName }),
  );
  const basePolicyDocument = readLivePolicyDocument(sandboxName, gatewayName, "base");
  return { gatewayName, inspection, basePolicyDocument };
}

/** Read the current live policy through the sandbox's recorded gateway binding. */
export function inspectPolicyMutationContext(
  sandboxName: string,
  operation: string,
  requestedGatewayName?: string,
): PolicyMutationContext {
  return inspectLivePolicyBoundary(sandboxName, operation, requestedGatewayName);
}

/**
 * Read the round-trippable base policy through the sandbox's recorded gateway.
 * Destructive lifecycle callers use this instead of the ambient CLI gateway.
 */
export function captureRecordedSandboxBasePolicy(sandboxName: string, operation: string): string {
  return inspectLivePolicyBoundary(sandboxName, operation).basePolicyDocument;
}

function preparePolicyMutationContext(
  sandboxName: string,
  operation: string,
  requestedGatewayName?: string,
): PolicyMutationContext {
  return inspectLivePolicyBoundary(sandboxName, operation, requestedGatewayName);
}

/** Re-read live state immediately before a policy mutation. */
export function recheckPolicyMutationContext(
  sandboxName: string,
  operation: string,
  previous: PolicyMutationContext,
): PolicyMutationContext {
  const current = inspectPolicyMutationContext(sandboxName, operation, previous.gatewayName);
  if (
    !isDeepStrictEqual(current.inspection.effectivePolicy, previous.inspection.effectivePolicy) ||
    !policyDocumentsMatch(current.basePolicyDocument, previous.basePolicyDocument)
  ) {
    throw new PolicyObservationError(
      `Refusing to ${operation}: the current OpenShell policy changed while NemoClaw prepared the requested update. Rerun the command against the current policy.`,
    );
  }
  return current;
}

/** Reject a final OpenShell policy refusal without exposing raw diagnostics. */
export function rejectFinalPolicySetSubmission(
  submission: OpenShellSandboxPolicySetSubmission,
  operation: string,
): void {
  const outcome = submission.outcome;
  if (outcome.kind === "rejected") {
    throw new PolicyObservationError(
      `Refusing to ${operation}: OpenShell rejected the policy change: ${redact(outcome.message)}`,
    );
  }
}

/** Confirm a policy submission through authoritative live readback. */
export function confirmAppliedPolicySetSubmission(
  submission: OpenShellSandboxPolicySetSubmission,
  sandboxName: string,
  desiredPolicyDocument: string,
  previous: PolicyMutationContext,
  operation: string,
): void {
  rejectFinalPolicySetSubmission(submission, operation);
  verifyAppliedPolicyDocument(sandboxName, desiredPolicyDocument, previous);
}

function reportPolicyObservationFailure(error: unknown): false {
  console.error(`  ${policyObservationError(error)}`);
  return false;
}

function inspectLivePolicyForMutation(
  sandboxName: string,
  operation: string,
  gatewayName?: string,
): PolicyMutationContext | null {
  try {
    return preparePolicyMutationContext(sandboxName, operation, gatewayName);
  } catch (error) {
    reportPolicyObservationFailure(error);
    return null;
  }
}

/**
 * Submit a composed policy document through a private temp file and classify
 * what OpenShell did with it.
 *
 * The typed policy writer captures nonzero results instead of ending the
 * process. Owning the temp material here guarantees that it is removed before
 * any caller decides how to handle the classified submission (#9206).
 */
function submitComposedPolicy(
  sandboxName: string,
  policyDocument: string,
  gatewayName?: string,
): OpenShellSandboxPolicySetSubmission {
  // `mkdtempSync` creates nothing when it throws, so only the write and the
  // submission need the cleanup boundary. Writing inside it keeps a failed or
  // partial write from leaving the composed policy readable in $TMPDIR.
  //
  // A cleanup failure deliberately supersedes whatever the body produced: a
  // policy document still readable on disk is the condition that must never be
  // reported as a clean result.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  try {
    const tmpFile = path.join(tmpDir, "policy.yaml");
    fs.writeFileSync(tmpFile, policyDocument, { encoding: "utf-8", mode: 0o600 });
    return syncCliOpenShellSandboxPolicyWriter.setSandboxPolicy({
      target: gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway(),
      sandboxName,
      policyPath: tmpFile,
    });
  } finally {
    removeTempPolicyMaterial(tmpDir);
  }
}

/**
 * Describe a failed `policy set` for the operator. An OpenShell diagnostic can
 * quote the policy that was submitted, so every message is redacted before it
 * reaches the console.
 *
 * A `rejected` verdict is final: OpenShell understood the document and refused
 * it, so resubmitting only replays a policy it already declined. Ambiguous
 * results are resolved through live readback before this formatter is used.
 */
function policySetFailure(
  sandboxName: string,
  outcome: Extract<OpenShellSandboxPolicySetOutcome, { kind: "rejected" }>,
): Error {
  return new Error(
    `OpenShell rejected the policy for sandbox '${sandboxName}' (exit ${outcome.status}): ` +
      `${redact(outcome.message)}. The policy was not applied and re-applying it will be ` +
      `rejected again; change the preset selection instead.`,
  );
}

export function verifyAppliedPolicyDocument(
  sandboxName: string,
  desiredPolicyDocument: string,
  previous: PolicyMutationContext,
): void {
  const readback = inspectPolicyDocumentReadback(sandboxName, desiredPolicyDocument, previous);
  if (readback === "unavailable") {
    throw new PolicyObservationError(
      `NemoClaw applied the sandbox policy for '${sandboxName}', but could not verify the resulting base policy. The policy update is incomplete.`,
    );
  }
  if (readback === "different") {
    throw new PolicyObservationError(
      `NemoClaw applied the sandbox policy for '${sandboxName}', but the resulting base policy did not match the requested policy. The policy update is incomplete.`,
    );
  }
}

function inspectPolicyDocumentReadback(
  sandboxName: string,
  desiredPolicyDocument: string,
  previous: PolicyMutationContext,
): "matched" | "different" | "unavailable" {
  try {
    return policyDocumentsMatch(
      readLivePolicyDocument(sandboxName, previous.gatewayName, "base"),
      desiredPolicyDocument,
    )
      ? "matched"
      : "different";
  } catch {
    return "unavailable";
  }
}

const POLICY_RECONCILE_ATTEMPTS = 5;
const MISSING_POLICY_VALUE = Symbol("missing-policy-value");
type MergePolicyValue = PolicyValue | typeof MISSING_POLICY_VALUE;

function clonePolicyMergeValue(value: MergePolicyValue): MergePolicyValue {
  return value === MISSING_POLICY_VALUE ? value : structuredClone(value);
}

function mergeConcurrentPolicyValue(
  original: MergePolicyValue,
  requested: MergePolicyValue,
  external: MergePolicyValue,
  pathSegments: readonly string[],
  conflicts: string[],
): MergePolicyValue {
  if (isDeepStrictEqual(requested, original)) return clonePolicyMergeValue(external);
  if (isDeepStrictEqual(external, original)) return clonePolicyMergeValue(requested);
  if (isDeepStrictEqual(requested, external)) return clonePolicyMergeValue(requested);

  if (
    original !== MISSING_POLICY_VALUE &&
    requested !== MISSING_POLICY_VALUE &&
    external !== MISSING_POLICY_VALUE &&
    isPolicyObject(original) &&
    isPolicyObject(requested) &&
    isPolicyObject(external)
  ) {
    const merged: PolicyObject = {};
    const keys = new Set([
      ...Object.keys(original),
      ...Object.keys(requested),
      ...Object.keys(external),
    ]);
    for (const key of keys) {
      const value = mergeConcurrentPolicyValue(
        Object.prototype.hasOwnProperty.call(original, key) ? original[key] : MISSING_POLICY_VALUE,
        Object.prototype.hasOwnProperty.call(requested, key)
          ? requested[key]
          : MISSING_POLICY_VALUE,
        Object.prototype.hasOwnProperty.call(external, key) ? external[key] : MISSING_POLICY_VALUE,
        [...pathSegments, key],
        conflicts,
      );
      if (value !== MISSING_POLICY_VALUE) merged[key] = value;
    }
    return merged;
  }

  conflicts.push(pathSegments.join(".") || "<policy>");
  return clonePolicyMergeValue(external);
}

function rebasePolicyDocumentOntoConcurrentEdit(
  originalDocument: string,
  requestedDocument: string,
  externalDocument: string,
): { readonly document: string; readonly conflicts: readonly string[] } {
  const original = YAML.parse(originalDocument) as PolicyValue;
  const requested = YAML.parse(requestedDocument) as PolicyValue;
  const external = YAML.parse(externalDocument) as PolicyValue;
  if (!isPolicyDocument(original) || !isPolicyDocument(requested) || !isPolicyDocument(external)) {
    throw new PolicyObservationError(
      "OpenShell returned an invalid policy revision while NemoClaw reconciled a concurrent policy edit.",
    );
  }
  const conflicts: string[] = [];
  const merged = mergeConcurrentPolicyValue(original, requested, external, [], conflicts);
  if (merged === MISSING_POLICY_VALUE || !isPolicyDocument(merged)) {
    throw new PolicyObservationError(
      "OpenShell returned an invalid policy revision while NemoClaw reconciled a concurrent policy edit.",
    );
  }
  return { document: YAML.stringify(merged), conflicts };
}

/**
 * Apply a composed policy document while optionally keeping control in the
 * caller on failure. Lifecycle code that owns compensating actions must use
 * nonFatal so a failed OpenShell mutation cannot bypass its rollback through
 * process.exit.
 *
 * The submission controls the temp policy file, so the composed policy is already
 * deleted by the time this ends the process for a fatal caller (#9206).
 */
export function setPolicyDocument(
  sandboxName: string,
  policyDocument: string,
  options: {
    nonFatal?: boolean;
    gatewayName?: string;
    operation?: string;
    context?: PolicyMutationContext;
  } = {},
): boolean {
  const operation = options.operation ?? "set the sandbox policy";
  let context: PolicyMutationContext;
  try {
    context = options.context
      ? recheckPolicyMutationContext(sandboxName, operation, options.context)
      : preparePolicyMutationContext(sandboxName, operation, options.gatewayName);
  } catch (error) {
    console.error(`  ${policyObservationError(error)}`);
    if (options.nonFatal) return false;
    process.exit(1);
  }

  let requestedDocument = policyDocument;
  let recoveryOnly = false;

  for (let attempt = 1; attempt <= POLICY_RECONCILE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      try {
        context = recheckPolicyMutationContext(sandboxName, operation, context);
      } catch (error) {
        console.error(`  ${policyObservationError(error)}`);
        if (options.nonFatal) return false;
        process.exit(1);
      }
    }

    const originalDocument = context.basePolicyDocument;
    const originalVersion = context.inspection.policyIdentity.activeVersion;
    const { outcome, status } = submitComposedPolicy(
      sandboxName,
      requestedDocument,
      context.gatewayName,
    );
    if (outcome.kind === "rejected") {
      console.error(`  ${policySetFailure(sandboxName, outcome).message}`);
      if (options.nonFatal) return false;
      process.exit(status || 1);
    }

    let observed: PolicyMutationContext;
    try {
      observed = preparePolicyMutationContext(sandboxName, operation, context.gatewayName);
    } catch (error) {
      if (outcome.kind === "ambiguous") {
        console.error(
          `  Could not confirm the policy update for sandbox '${sandboxName}': ${redact(outcome.detail)}. ` +
            "The current live policy could not be read; the update remains unconfirmed.",
        );
      } else {
        console.error(`  ${policyObservationError(error)}`);
      }
      if (options.nonFatal) return false;
      process.exit(1);
    }
    const observedDocument = observed.basePolicyDocument;
    const observedVersion = observed.inspection.policyIdentity.activeVersion;
    const requestedIsCurrent = policyDocumentsMatch(observedDocument, requestedDocument);
    const concurrentRevision = observedVersion > originalVersion + 1;

    if (!concurrentRevision) {
      if (requestedIsCurrent) return !recoveryOnly;
      if (outcome.kind === "ambiguous") {
        console.error(
          `  Could not confirm the policy update for sandbox '${sandboxName}': ${redact(outcome.detail)}. ` +
            "The current live policy differs from the requested document; the update remains unconfirmed.",
        );
      } else {
        console.error(
          `  NemoClaw applied the sandbox policy for '${sandboxName}', but the resulting base policy did not match the requested policy. The policy update is incomplete.`,
        );
      }
      if (options.nonFatal) return false;
      process.exit(status || 1);
    }

    let externalDocument: string;
    try {
      externalDocument = requestedIsCurrent
        ? readLivePolicyRevision(sandboxName, context.gatewayName, observedVersion - 1)
        : observedDocument;
      const rebased = rebasePolicyDocumentOntoConcurrentEdit(
        originalDocument,
        requestedDocument,
        externalDocument,
      );
      context = observed;
      if (rebased.conflicts.length > 0) {
        recoveryOnly = true;
        requestedDocument = externalDocument;
        console.error(
          `  The current OpenShell policy changed in the same fields while NemoClaw prepared ${operation}. ` +
            "The external policy is being restored; rerun the command against the current policy.",
        );
      } else {
        requestedDocument = rebased.document;
      }
    } catch (error) {
      console.error(`  ${policyObservationError(error)}`);
      if (options.nonFatal) return false;
      process.exit(1);
    }
  }

  console.error(
    `  Refusing to ${operation}: the current OpenShell policy kept changing while NemoClaw reconciled the requested update. Rerun the command against the current policy.`,
  );
  if (options.nonFatal) return false;
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

  return normalizePersonalOpenInternetPolicy(YAML.stringify(output));
}

/**
 * OpenShell 0.0.101 rejects a hostless `allowed_ips` endpoint when any other
 * endpoint selects the same port with different connection metadata. Personal
 * deliberately grants every sandbox binary direct L4 access on ports 80/443,
 * so exact web endpoints add no transport context while Personal is active.
 * Keep the reviewed Personal entry as the sole web context and retain every
 * non-web endpoint and non-network policy section unchanged. OpenShell handles
 * `inference.local` before ordinary network-policy evaluation, so removing its
 * overlapping base-policy endpoint does not remove routed inference.
 */
function normalizePersonalOpenInternetPolicy(policyContent: string): string {
  let document: PolicyDocument;
  try {
    const parsed = YAML.parse(policyContent);
    if (!isPolicyDocument(parsed)) return policyContent;
    document = parsed;
  } catch {
    return policyContent;
  }

  const networkPolicies = document.network_policies;
  if (!isPolicyObject(networkPolicies)) return policyContent;
  if (!Object.prototype.hasOwnProperty.call(networkPolicies, PERSONAL_OPEN_INTERNET_POLICY_KEY)) {
    return policyContent;
  }
  const personalEntry = networkPolicies[PERSONAL_OPEN_INTERNET_POLICY_KEY];

  const reviewedContent = loadCentralPreset(PERSONAL_OPEN_INTERNET_PRESET_NAME, {
    reportMissing: false,
  });
  const reviewedEntry = parseNetworkPolicies(reviewedContent)?.[PERSONAL_OPEN_INTERNET_POLICY_KEY];
  if (
    !isPolicyObject(personalEntry) ||
    !isPolicyObject(reviewedEntry) ||
    !isDeepStrictEqual(personalEntry, reviewedEntry)
  ) {
    throw new Error(
      `Cannot compose Personal policy: reserved network policy key '${PERSONAL_OPEN_INTERNET_POLICY_KEY}' does not match the reviewed built-in preset.`,
    );
  }

  const normalizedPolicies: PolicyObject = {};
  for (const [policyKey, policyValue] of Object.entries(networkPolicies)) {
    if (policyKey === PERSONAL_OPEN_INTERNET_POLICY_KEY || !isPolicyObject(policyValue)) {
      normalizedPolicies[policyKey] = policyValue;
      continue;
    }

    if (!Array.isArray(policyValue.endpoints)) {
      normalizedPolicies[policyKey] = policyValue;
      continue;
    }

    const endpoints: PolicyValue[] = [];
    for (const endpointValue of policyValue.endpoints) {
      if (!isPolicyObject(endpointValue)) {
        endpoints.push(endpointValue);
        continue;
      }

      const port = endpointValue.port;
      if (typeof port === "number" && PERSONAL_OPEN_INTERNET_PORTS.has(port)) continue;

      const ports = endpointValue.ports;
      if (!Array.isArray(ports)) {
        endpoints.push(endpointValue);
        continue;
      }
      const retainedPorts = ports.filter(
        (candidate) =>
          typeof candidate !== "number" || !PERSONAL_OPEN_INTERNET_PORTS.has(candidate),
      );
      if (retainedPorts.length === 0) continue;
      endpoints.push(
        retainedPorts.length === ports.length
          ? endpointValue
          : { ...endpointValue, ports: retainedPorts },
      );
    }

    if (endpoints.length > 0) {
      normalizedPolicies[policyKey] = { ...policyValue, endpoints };
    }
  }

  return YAML.stringify({ ...document, network_policies: normalizedPolicies });
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
    return isDeepStrictEqual(parseOpenShellPolicy(left).policy, parseOpenShellPolicy(right).policy);
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

const OPENCLAW_NPM_BASELINE_KEY = "npm_registry";
const OPENCLAW_NPM_PRESET_KEY = "npm_yarn";
const CUSTOM_PRESET_RESERVED_NETWORK_POLICY_KEYS = [
  OPENCLAW_NPM_PRESET_KEY,
  PERSONAL_OPEN_INTERNET_POLICY_KEY,
] as const;

function findReservedCustomNetworkPolicyKey(networkPolicies: PolicyObject): string | undefined {
  return CUSTOM_PRESET_RESERVED_NETWORK_POLICY_KEYS.find((key) =>
    Object.prototype.hasOwnProperty.call(networkPolicies, key),
  );
}

function npmCompatibilityEntry(
  baselineEntry: PolicyObject,
  npmPresetEntry: PolicyObject,
): PolicyObject {
  const presetEndpoints = Array.isArray(npmPresetEntry.endpoints)
    ? npmPresetEntry.endpoints.filter(isPolicyObject)
    : [];
  const baselineEndpoints = Array.isArray(baselineEntry.endpoints)
    ? baselineEntry.endpoints.filter(isPolicyObject)
    : [];
  if (baselineEndpoints.length === 0) {
    throw new Error(
      `Cannot compose '${OPENCLAW_NPM_PRESET_KEY}' with '${OPENCLAW_NPM_BASELINE_KEY}': the reviewed baseline has no endpoints.`,
    );
  }
  const baselineSelectors = new Set<string>();
  const compatibleEndpoints = baselineEndpoints.map((baselineEndpoint) => {
    const host = baselineEndpoint.host;
    const port = baselineEndpoint.port;
    if (
      typeof host !== "string" ||
      host.length === 0 ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port <= 0
    ) {
      throw new Error(
        `Cannot compose '${OPENCLAW_NPM_PRESET_KEY}' with '${OPENCLAW_NPM_BASELINE_KEY}': the reviewed baseline selector is invalid.`,
      );
    }
    const selector = `${host}:${port}`;
    if (baselineSelectors.has(selector)) {
      throw new Error(
        `Cannot compose '${OPENCLAW_NPM_PRESET_KEY}' with '${OPENCLAW_NPM_BASELINE_KEY}': the reviewed baseline repeats selector '${selector}'.`,
      );
    }
    baselineSelectors.add(selector);
    const matches = presetEndpoints.filter(
      (candidate) => candidate.host === host && candidate.port === port,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Cannot compose '${OPENCLAW_NPM_PRESET_KEY}' with '${OPENCLAW_NPM_BASELINE_KEY}': selector '${selector}' must have exactly one preset match.`,
      );
    }
    return structuredClone(matches[0]);
  });
  return { ...structuredClone(baselineEntry), endpoints: compatibleEndpoints };
}

type OpenClawNpmActivation = { policy: string; widenedBaseline: boolean };

function openClawNpmReviewedEntries(baselinePolicyContent: string): {
  baseline: PolicyObject;
  preset: PolicyObject;
} {
  const baseline = getBaselineEntry(baselinePolicyContent, OPENCLAW_NPM_BASELINE_KEY);
  const npmPresetContent = loadPresetForAgent("npm", { agent: "openclaw" });
  const preset = parseNetworkPolicies(npmPresetContent)?.[OPENCLAW_NPM_PRESET_KEY];
  if (!baseline || !isPolicyObject(preset)) {
    throw new Error("Cannot reconcile OpenClaw npm policy compatibility: reviewed inputs missing.");
  }
  return { baseline, preset };
}

/**
 * OpenShell 0.0.106 rejects overlapping endpoint selectors whose TLS or L7
 * metadata differs, even when their binary lists are disjoint. Keep the
 * restricted OpenClaw baseline GET-only. While the broader npm preset is
 * active, its reviewed full-access L4 endpoint temporarily replaces the
 * overlapping baseline endpoint metadata while retaining the baseline's
 * OpenClaw-only binary scope.
 */
function activateOpenClawNpmCompatibility(
  policyContent: string,
  baselinePolicyContent: string,
  npmWasActive: boolean,
): OpenClawNpmActivation {
  const parsed = YAML.parse(policyContent);
  if (!isPolicyDocument(parsed) || !isPresetPolicyMap(parsed.network_policies)) {
    throw new Error("Cannot reconcile OpenClaw npm policy compatibility: invalid policy mapping.");
  }
  const networkPolicies = parsed.network_policies;
  const currentBaselineEntry = networkPolicies[OPENCLAW_NPM_BASELINE_KEY];
  if (currentBaselineEntry === undefined) {
    return { policy: policyContent, widenedBaseline: false };
  }
  if (!isPolicyObject(currentBaselineEntry)) {
    throw new Error(`Cannot compose '${OPENCLAW_NPM_PRESET_KEY}': baseline entry is malformed.`);
  }

  const reviewed = openClawNpmReviewedEntries(baselinePolicyContent);
  const compatibilityEntry = npmCompatibilityEntry(reviewed.baseline, reviewed.preset);
  const currentNpmEntry = networkPolicies[OPENCLAW_NPM_PRESET_KEY];
  if (!isPolicyObject(currentNpmEntry) || !isDeepStrictEqual(currentNpmEntry, reviewed.preset)) {
    throw new Error(
      `Cannot compose '${OPENCLAW_NPM_PRESET_KEY}': the resulting entry differs from the reviewed npm preset.`,
    );
  }
  if (isDeepStrictEqual(currentBaselineEntry, compatibilityEntry)) {
    if (!npmWasActive) {
      throw new Error(
        `Cannot compose '${OPENCLAW_NPM_PRESET_KEY}': found a compatibility overlay without an active npm preset.`,
      );
    }
    return { policy: policyContent, widenedBaseline: false };
  }
  if (!isDeepStrictEqual(currentBaselineEntry, reviewed.baseline)) {
    throw new Error(
      `Cannot compose '${OPENCLAW_NPM_PRESET_KEY}': '${OPENCLAW_NPM_BASELINE_KEY}' differs from the reviewed baseline.`,
    );
  }
  networkPolicies[OPENCLAW_NPM_BASELINE_KEY] = compatibilityEntry;
  parsed.network_policies = networkPolicies;
  return { policy: YAML.stringify(parsed), widenedBaseline: true };
}

function restoreOpenClawNpmCompatibility(
  currentPolicy: string,
  updatedPolicy: string,
  baselinePolicyContent: string,
): string {
  const current = YAML.parse(currentPolicy);
  const updated = YAML.parse(updatedPolicy);
  if (
    !isPolicyDocument(current) ||
    !isPresetPolicyMap(current.network_policies) ||
    !isPolicyDocument(updated) ||
    !isPresetPolicyMap(updated.network_policies)
  ) {
    throw new Error("Cannot restore OpenClaw npm policy compatibility: invalid policy mapping.");
  }
  const currentBaselineEntry = current.network_policies[OPENCLAW_NPM_BASELINE_KEY];
  if (currentBaselineEntry === undefined) return updatedPolicy;
  if (!isPolicyObject(currentBaselineEntry)) {
    throw new Error(`Cannot remove '${OPENCLAW_NPM_PRESET_KEY}': baseline entry is malformed.`);
  }

  const reviewed = openClawNpmReviewedEntries(baselinePolicyContent);
  if (isDeepStrictEqual(currentBaselineEntry, reviewed.baseline)) return updatedPolicy;

  const currentNpmEntry = current.network_policies[OPENCLAW_NPM_PRESET_KEY];
  if (!isPolicyObject(currentNpmEntry)) {
    throw new Error(
      `Cannot remove '${OPENCLAW_NPM_PRESET_KEY}': found a compatibility overlay without an active npm preset.`,
    );
  }
  const compatibilityEntry = npmCompatibilityEntry(reviewed.baseline, currentNpmEntry);
  if (!isDeepStrictEqual(currentBaselineEntry, compatibilityEntry)) {
    throw new Error(
      `Cannot remove '${OPENCLAW_NPM_PRESET_KEY}': '${OPENCLAW_NPM_BASELINE_KEY}' differs from both the reviewed baseline and active compatibility overlay.`,
    );
  }
  updated.network_policies[OPENCLAW_NPM_BASELINE_KEY] = structuredClone(reviewed.baseline);
  return YAML.stringify(updated);
}

function resolveSandboxOpenClawNpmBaseline(sandboxName: string): string | null {
  const sandbox = registry.getSandbox(sandboxName);
  // Legacy and unregistered rows historically use OpenClaw preset content.
  // Activation still requires an exact reviewed npm_registry entry in the
  // live policy, so this fallback cannot inject or broaden a missing key.
  const agent = sandbox?.agent || "openclaw";
  if (agent !== "openclaw") return null;
  const baseline = resolveAgentBaselinePolicy(agent);
  if (!baseline) {
    throw new Error(
      `Cannot reconcile OpenClaw npm policy compatibility for '${sandboxName}': the reviewed baseline is unavailable.`,
    );
  }
  return baseline.content;
}

function openClawNpmExclusionStateError(
  _sandboxName: string,
  _currentPolicy: string,
): string | null {
  return null;
}

export type OpenClawNpmCompatibilityState = "match" | "repair" | "excluded" | "drift";

function getOpenClawNpmCompatibilityState(
  sandboxName: string,
): OpenClawNpmCompatibilityState | null {
  try {
    const baselinePolicyContent = resolveSandboxOpenClawNpmBaseline(sandboxName);
    if (!baselinePolicyContent) return "match";
    const currentPolicy = readCurrentSandboxPolicy(sandboxName);
    if (!currentPolicy) return null;
    const live = inspectLiveBaselineEntry(currentPolicy, OPENCLAW_NPM_BASELINE_KEY);
    if (live.state === "absent") return "excluded";
    if (live.state !== "present") return "drift";

    const parsed = YAML.parse(currentPolicy);
    if (!isPolicyDocument(parsed) || !isPresetPolicyMap(parsed.network_policies)) return null;
    const reviewed = openClawNpmReviewedEntries(baselinePolicyContent);
    const currentNpmEntry = parsed.network_policies[OPENCLAW_NPM_PRESET_KEY];
    if (!isPolicyObject(currentNpmEntry) || !isDeepStrictEqual(currentNpmEntry, reviewed.preset)) {
      return "drift";
    }
    if (isDeepStrictEqual(parsed.network_policies[OPENCLAW_NPM_BASELINE_KEY], reviewed.baseline)) {
      return "repair";
    }
    const compatibilityEntry = npmCompatibilityEntry(reviewed.baseline, currentNpmEntry);
    return isDeepStrictEqual(parsed.network_policies[OPENCLAW_NPM_BASELINE_KEY], compatibilityEntry)
      ? "match"
      : "drift";
  } catch {
    return null;
  }
}

function policyHasNetworkPolicy(policyContent: string, policyKey: string): boolean {
  return isPolicyObject(parseNetworkPolicies(policyContent)?.[policyKey]);
}

function logOpenClawNpmCompatibilityDisclosure(logger: (line: string) => void = console.log): void {
  logger("  OpenClaw npm compatibility scope while this preset is active:");
  logger(
    "    registry.npmjs.org:443 for /usr/local/bin/openclaw changes from inspected GET-only REST to full L4 pass-through (HTTP methods and paths are not inspected).",
  );
  logger("    Removing the npm preset restores the exact reviewed GET-only baseline route.");
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
    const presetContent = loadPresetForAgent(presetName, {
      agent: options.agent,
      sandboxName: options.sandboxName,
      credentialBoundMessagingChannels: options.credentialBoundMessagingChannels,
      messagingConfig: options.messagingConfig,
    });
    const presetEntries = extractPresetEntries(presetContent);
    if (!presetEntries) {
      const materializesWithSandboxName =
        isMessagingChannelPolicyPreset(presetName) &&
        loadMessagingChannelPolicyPreset(presetName, {
          agent: options.agent,
          sandboxName: "policy-probe",
        }) !== null;
      if (materializesWithSandboxName) {
        throw new Error(
          `Cannot compose messaging policy preset '${presetName}': a valid sandbox name is required to materialize credential bindings.`,
        );
      }
      missingPresets.push(presetName);
      continue;
    }

    merged = mergePresetIntoPolicy(merged, presetEntries);
    appliedPresets.push(presetName);
  }

  let policy = merged;
  if (
    (options.agent === undefined || options.agent === null || options.agent === "openclaw") &&
    appliedPresets.includes("npm") &&
    !policyHasNetworkPolicy(merged, PERSONAL_OPEN_INTERNET_POLICY_KEY)
  ) {
    const reviewedBaseline = resolveAgentBaselinePolicy("openclaw");
    if (!reviewedBaseline) {
      throw new Error(
        "Cannot reconcile OpenClaw npm policy compatibility: reviewed baseline missing.",
      );
    }
    policy = activateOpenClawNpmCompatibility(
      merged,
      reviewedBaseline.content,
      policyHasNetworkPolicy(currentPolicy, OPENCLAW_NPM_PRESET_KEY),
    ).policy;
  }
  if (appliedPresets.some((name) => name === "teams" || name === "outlook")) {
    policy = reconcileTeamsOutlookLoginCredentialBinding(
      policy,
      options.sandboxName,
      options.credentialBoundMessagingChannels?.includes("teams"),
    );
  }
  return {
    policy: normalizePersonalOpenInternetPolicy(policy),
    appliedPresets,
    missingPresets,
  };
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
 * Remove one built-in or namespaced custom preset from the live OpenShell
 * policy. No local preset attribution is read or written.
 */
function removePreset(
  sandboxName: string,
  presetName: string,
  options: { nonFatal?: boolean; presetContent?: string } = {},
): boolean {
  // Guard against truncated sandbox names — WSL can truncate hyphenated
  // names during argument parsing, e.g. "my-assistant" → "m"
  if (!isValidName(sandboxName)) {
    throw new Error(
      `Invalid or truncated sandbox name: ${diagnosticPreview(sandboxName)}. ` +
        `Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }

  if (presetName === PERSONAL_OPEN_INTERNET_PRESET_NAME) {
    console.error(
      "  Personal open internet cannot be removed in place because it replaces overlapping web routes. Create a new sandbox with another policy tier instead.",
    );
    return false;
  }

  const operation = `remove policy preset '${presetName}'`;
  const context = inspectLivePolicyForMutation(sandboxName, operation);
  if (!context) return false;

  const currentPolicy = currentPolicyFromMutationContext(context);
  if (!currentPolicy) {
    console.error(`  Could not read current policy for sandbox '${sandboxName}'.`);
    return false;
  }
  const customPresetContent = liveCustomPresetContentFromPolicy(currentPolicy, presetName);
  const isCustom = customPresetContent !== null;
  const presetContent =
    options.presetContent ?? customPresetContent ?? loadPresetForSandbox(sandboxName, presetName);
  if (!presetContent) {
    console.error(`  Cannot load preset: ${presetName}`);
    return false;
  }

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }

  let openClawNpmBaseline: string | null = null;
  if (!isCustom && presetName === "npm") {
    try {
      openClawNpmBaseline = resolveSandboxOpenClawNpmBaseline(sandboxName);
      if (openClawNpmBaseline) {
        const exclusionError = openClawNpmExclusionStateError(sandboxName, currentPolicy);
        if (exclusionError) throw new Error(exclusionError);
      }
    } catch {
      console.error("  Refusing to remove npm policy compatibility: validation failed.");
      return false;
    }
  }

  const supersededByPersonal =
    policyHasNetworkPolicy(currentPolicy, PERSONAL_OPEN_INTERNET_POLICY_KEY) &&
    classifyPresetEntries(currentPolicy, presetEntries) === "absent" &&
    policyDocumentsMatch(currentPolicy, mergePresetIntoPolicy(currentPolicy, presetEntries));
  if (supersededByPersonal) {
    console.log(`  Preset '${presetName}' is already absent from the live OpenShell policy.`);
    return true;
  }

  let updated = removePresetFromPolicy(currentPolicy, presetEntries);
  if (!isCustom && (presetName === "teams" || presetName === "outlook")) {
    try {
      const teamsActive =
        presetName === "teams"
          ? false
          : getCredentialBoundMessagingChannelsFromEntry(registry.getSandbox(sandboxName)).includes(
              "teams",
            );
      updated = reconcileTeamsOutlookLoginCredentialBinding(updated, sandboxName, teamsActive);
    } catch {
      console.error(`  Refusing to remove preset '${presetName}': validation failed.`);
      return false;
    }
  }
  if (openClawNpmBaseline) {
    try {
      updated = restoreOpenClawNpmCompatibility(currentPolicy, updated, openClawNpmBaseline);
    } catch {
      console.error("  Refusing to remove npm policy compatibility: validation failed.");
      return false;
    }
  }
  updated = normalizePersonalOpenInternetPolicy(updated);

  if (updated === currentPolicy) {
    console.log(`  Preset '${presetName}' is already absent from the live OpenShell policy.`);
    return true;
  }

  const endpoints = getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Narrowing sandbox egress — removing: ${endpoints.join(", ")}`);
  }

  // Run before submitting so a missing-binary exit doesn't orphan files in
  // $TMPDIR (the cleanup doesn't run on process.exit).
  if (!assertOpenshellResolvable(options)) return false;
  if (
    !setPolicyDocument(sandboxName, updated, {
      nonFatal: options.nonFatal,
      context,
    })
  ) {
    return false;
  }
  console.log(`  Removed preset: ${presetName}`);
  return true;
}

/** Parse the round-trippable base policy already captured with a mutation context. */
function currentPolicyFromMutationContext(context: PolicyMutationContext): string | null {
  return parseCurrentPolicyOrEmpty(context.basePolicyDocument) || null;
}

/** Round-trippable live policy body from `--base`, or null when unreadable. */
function readCurrentSandboxPolicy(sandboxName: string, gatewayName?: string): string | null {
  try {
    const selectedGateway =
      gatewayName ?? resolveSandboxGatewayName(registry.getSandbox(sandboxName));
    return (
      parseCurrentPolicyOrEmpty(readLivePolicyDocument(sandboxName, selectedGateway, "base")) ||
      null
    );
  } catch {
    return null;
  }
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

/** Run one mutation against the sandbox's recorded OpenShell gateway. */
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
  return operation(resolveSandboxGatewayName(sandbox));
}

type RestoreBaselineEntryOptions = {
  nonFatal?: boolean;
  expectedTargetDigest?: string | null;
};

function excludeBaselineEntry(
  sandboxName: string,
  key: string,
  digest: string,
  options: { nonFatal?: boolean } = {},
): boolean {
  return withRecordedSandboxGateway(sandboxName, (gatewayName) => {
    const operation = `exclude baseline policy entry '${key}'`;
    const context = inspectLivePolicyForMutation(sandboxName, operation, gatewayName);
    if (!context) return false;
    const currentPolicy = currentPolicyFromMutationContext(context);
    if (!currentPolicy) {
      console.error(`  Could not read current policy for sandbox '${sandboxName}'.`);
      return false;
    }
    const live = inspectLiveBaselineEntry(currentPolicy, key);
    if (live.state === "absent") return true;
    if (live.state !== "present" || live.digest !== digest) {
      console.error(
        `  Baseline entry '${key}' changed after preview. Rerun the command to review its current scope; no policy changes were made.`,
      );
      return false;
    }
    const { policy, removed } = removeBaselineEntryFromPolicy(currentPolicy, key);
    return (
      removed &&
      assertOpenshellResolvable(options) &&
      setPolicyDocument(sandboxName, policy, {
        ...options,
        context,
        operation,
      })
    );
  });
}

function restoreBaselineEntry(
  sandboxName: string,
  key: string,
  options: RestoreBaselineEntryOptions = {},
): boolean {
  return withRecordedSandboxGateway(sandboxName, (gatewayName) => {
    let entry: PolicyObject | null;
    try {
      entry = getSandboxBaselineEntry(sandboxName, key);
    } catch {
      console.error(
        `  The current release baseline for '${key}' is unreadable. No policy changes were made.`,
      );
      return false;
    }
    const targetDigest = entry ? digestBaselineEntry(entry) : null;
    if (
      Object.prototype.hasOwnProperty.call(options, "expectedTargetDigest") &&
      targetDigest !== options.expectedTargetDigest
    ) {
      console.error(
        `  Baseline entry '${key}' changed after preview. Rerun the command to review its current scope; no policy changes were made.`,
      );
      return false;
    }
    if (!entry) return true;
    const operation = `restore baseline policy entry '${key}'`;
    const context = inspectLivePolicyForMutation(sandboxName, operation, gatewayName);
    if (!context) return false;
    const currentPolicy = currentPolicyFromMutationContext(context);
    if (!currentPolicy) {
      console.error(`  Could not read current policy for sandbox '${sandboxName}'.`);
      return false;
    }
    const live = inspectLiveBaselineEntry(currentPolicy, key);
    if (live.state === "present" && live.digest === targetDigest) return true;
    if (live.state !== "absent") {
      console.error(
        `  Live baseline entry '${key}' differs from the current release baseline. Refusing to overwrite it.`,
      );
      return false;
    }
    const updated = mergeBaselineEntryIntoPolicy(currentPolicy, key, entry);
    return (
      assertOpenshellResolvable(options) &&
      setPolicyDocument(sandboxName, updated, {
        ...options,
        context,
        operation,
      })
    );
  });
}

function inspectLiveBaselineEntry(policy: string, key: string): LiveBaselineEntryState {
  try {
    const document = YAML.parse(policy);
    if (!isPolicyDocument(document)) return { state: "invalid", digest: null };
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

type LiveBaselineEntryState =
  | { state: "absent"; digest: null }
  | { state: "present"; digest: string }
  | { state: "invalid"; digest: null };

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
 * them into the sandbox's current OpenShell policy, and runs
 * `openshell policy set --wait`. Custom preset identity is encoded in the
 * OpenShell rule keys instead of a local registry copy.
 */
function applyPresetContent(
  sandboxName: string,
  presetName: string,
  presetContent: string,
  options: {
    custom?: {
      sourcePath?: string;
      trustedPrivatePinCapability?: TrustedPrivatePolicyPinCapability;
    };
    expectedExistingNetworkPolicyContent?: string | null;
    nonFatal?: boolean;
    suppressDisclosure?: boolean;
    disclosedPresetState?: PresetPolicyState | null;
    includeMessagingCredentialBindings?: boolean;
  } = {},
): boolean {
  // Guard against truncated sandbox names — WSL can truncate hyphenated
  // names during argument parsing, e.g. "my-assistant" → "m"
  if (!isValidName(sandboxName)) {
    throw new Error(
      `Invalid or truncated sandbox name: ${diagnosticPreview(sandboxName)}. ` +
        `Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }

  if (options.custom) {
    const np = parseNetworkPolicies(presetContent);
    if (!np) {
      console.error(`  Preset '${presetName}' has invalid or missing network_policies.`);
      return false;
    }
    const reservedKey = findReservedCustomNetworkPolicyKey(np);
    if (reservedKey) {
      console.error(`  Custom presets cannot own reserved network policy key '${reservedKey}'.`);
      return false;
    }
    const hasGeneratedPins = networkPoliciesHasAllowedIps(np);
    const trustedPrivateCapabilityValid = isTrustedPrivatePolicyPinCapability(
      presetContent,
      options.custom.trustedPrivatePinCapability,
    );
    if (options.custom.trustedPrivatePinCapability && !trustedPrivateCapabilityValid) {
      console.error(
        `  Preset '${presetName}' has an invalid trusted-private pin capability for its content.`,
      );
      return false;
    }
    const untrustedPrivateHost = findUntrustedPrivatePolicyEndpointHost({
      network_policies: np,
    });
    if (untrustedPrivateHost && !trustedPrivateCapabilityValid) {
      console.error(
        `  Preset '${presetName}' endpoint host '${untrustedPrivateHost}' is rejected. Add explicit trust only for RFC1918, CGNAT, or IPv6 unique local destinations.`,
      );
      return false;
    }
    if (hasGeneratedPins && !trustedPrivateCapabilityValid) {
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

  const effectivePresetContent = options.custom
    ? namespaceCustomPresetContent(presetName, presetContent)
    : presetContent;
  const presetEntries = extractPresetEntries(effectivePresetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }
  const requiredNetworkPolicies = parseNetworkPolicies(effectivePresetContent);
  if (!requiredNetworkPolicies) {
    console.error(`  Preset ${presetName} has invalid network_policies.`);
    return false;
  }
  const operation = `apply policy preset '${presetName}'`;
  let context: PolicyMutationContext;
  try {
    context = preparePolicyMutationContext(sandboxName, operation);
  } catch (error) {
    return reportPolicyObservationFailure(error);
  }

  const currentPolicy = currentPolicyFromMutationContext(context);
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
  let merged: string;
  try {
    merged = mergePresetIntoPolicy(currentPolicy, presetEntries);
    if (!options.custom && (presetName === "teams" || presetName === "outlook")) {
      const teamsConfigured =
        options.includeMessagingCredentialBindings === true ||
        getCredentialBoundMessagingChannelsFromEntry(registry.getSandbox(sandboxName)).includes(
          "teams",
        );
      merged = reconcileTeamsOutlookLoginCredentialBinding(merged, sandboxName, teamsConfigured);
    }
  } catch (error) {
    if (!options.nonFatal) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Refusing to apply preset '${presetName}': ${message}`);
    return false;
  }
  let npmBaselineWidened = false;
  if (
    !options.custom &&
    presetName === "npm" &&
    !policyHasNetworkPolicy(merged, PERSONAL_OPEN_INTERNET_POLICY_KEY)
  ) {
    try {
      const baseline = resolveSandboxOpenClawNpmBaseline(sandboxName);
      if (baseline) {
        const exclusionError = openClawNpmExclusionStateError(sandboxName, currentPolicy);
        if (exclusionError) throw new Error(exclusionError);
        const activation = activateOpenClawNpmCompatibility(
          merged,
          baseline,
          policyHasNetworkPolicy(currentPolicy, OPENCLAW_NPM_PRESET_KEY),
        );
        merged = activation.policy;
        npmBaselineWidened = activation.widenedBaseline;
      }
    } catch {
      console.error("  Refusing to apply npm policy compatibility: validation failed.");
      return false;
    }
  }
  try {
    merged = normalizePersonalOpenInternetPolicy(merged);
  } catch (error) {
    if (!options.nonFatal) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Refusing to apply preset '${presetName}': ${message}`);
    return false;
  }

  const presetState = classifyPresetEntries(currentPolicy, presetEntries);
  const disclosedPresetState =
    npmBaselineWidened && presetState === "match" ? "drift" : presetState;
  const disclosedStateStillCurrent =
    Object.prototype.hasOwnProperty.call(options, "disclosedPresetState") &&
    options.disclosedPresetState === disclosedPresetState;
  if (!options.suppressDisclosure && !disclosedStateStillCurrent) {
    logPresetScopeForState(presetName, presetContent, disclosedPresetState);
  }
  if (npmBaselineWidened && !options.suppressDisclosure) {
    logOpenClawNpmCompatibilityDisclosure();
  }

  const policyChanged = !policyDocumentsMatch(currentPolicy, merged);

  // Run before submitting so a missing-binary exit doesn't orphan files in
  // $TMPDIR (the cleanup doesn't run on process.exit).
  if (policyChanged && !assertOpenshellResolvable(options)) return false;

  if (policyChanged) {
    if (
      !setPolicyDocument(sandboxName, merged, {
        nonFatal: options.nonFatal,
        context,
      })
    ) {
      return false;
    }
  }

  if (policyChanged) console.log(`  Applied preset: ${presetName}`);
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
  const presetContent = loadPresetForSandbox(sandboxName, presetName, {
    includeMessagingCredentialBindings: options.includeMessagingCredentialBindings === true,
    messagingConfig: options.messagingConfig as MessagingPolicyConfig | null | undefined,
  });
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
  if (!isValidName(sandboxName)) {
    throw new Error(
      `Invalid or truncated sandbox name: ${diagnosticPreview(sandboxName)}. ` +
        `Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    );
  }

  const uniquePresetNames = [...new Set(presetNames)].filter(Boolean);
  if (uniquePresetNames.length === 0) return true;

  const preparedPresets: Array<{
    content: string;
    entries: string;
    name: string;
  }> = [];

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
    const networkPolicies = parseNetworkPolicies(presetContent);
    if (!networkPolicies) {
      console.error(`  Preset ${presetName} has invalid network_policies.`);
      return false;
    }
    preparedPresets.push({
      content: presetContent,
      entries: presetEntries,
      name: presetName,
    });
  }

  const operation = "apply policy presets";
  let context: PolicyMutationContext;
  try {
    context = preparePolicyMutationContext(sandboxName, operation);
  } catch (error) {
    return reportPolicyObservationFailure(error);
  }

  let merged = currentPolicyFromMutationContext(context);
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

  for (const preset of preparedPresets) {
    const state = classifyPresetEntries(merged, preset.entries);
    presetContents.push({ content: preset.content, name: preset.name, state });
    merged = mergePresetIntoPolicy(merged, preset.entries);
  }
  if (uniquePresetNames.some((name) => name === "teams" || name === "outlook")) {
    try {
      const teamsConfigured = getCredentialBoundMessagingChannelsFromEntry(
        registry.getSandbox(sandboxName),
      ).includes("teams");
      merged = reconcileTeamsOutlookLoginCredentialBinding(merged, sandboxName, teamsConfigured);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Refusing to apply policy presets: ${message}`);
      return false;
    }
  }

  let npmBaselineWidened = false;
  if (
    uniquePresetNames.includes("npm") &&
    !policyHasNetworkPolicy(merged, PERSONAL_OPEN_INTERNET_POLICY_KEY)
  ) {
    try {
      const baseline = resolveSandboxOpenClawNpmBaseline(sandboxName);
      if (baseline) {
        const exclusionError = openClawNpmExclusionStateError(sandboxName, originalPolicy);
        if (exclusionError) throw new Error(exclusionError);
        const activation = activateOpenClawNpmCompatibility(
          merged,
          baseline,
          policyHasNetworkPolicy(originalPolicy, OPENCLAW_NPM_PRESET_KEY),
        );
        merged = activation.policy;
        npmBaselineWidened = activation.widenedBaseline;
      }
    } catch {
      console.error("  Refusing to apply npm policy compatibility: validation failed.");
      return false;
    }
  }
  merged = normalizePersonalOpenInternetPolicy(merged);

  for (const preset of presetContents) {
    const disclosedPresetState =
      preset.name === "npm" && npmBaselineWidened && preset.state === "match"
        ? "drift"
        : preset.state;
    logPresetScopeForState(preset.name, preset.content, disclosedPresetState);
    if (preset.name === "npm" && npmBaselineWidened) {
      logOpenClawNpmCompatibilityDisclosure();
    }
  }

  const policyChanged = !policyDocumentsMatch(originalPolicy, merged);

  // Run before creating temp resources so a missing-binary exit doesn't
  // orphan files in $TMPDIR (the finally cleanup doesn't run on process.exit).
  if (policyChanged) assertOpenshellResolvable();

  if (policyChanged) {
    // The shared fatal path preserves OpenShell's status after it removes the
    // temporary policy. Onboarding defers that exit until its recovery state
    // and outer cleanup have finished.
    setPolicyDocument(sandboxName, merged, {
      context,
    });
  }

  if (policyChanged) {
    for (const preset of presetContents.filter((entry) => entry.state !== "match")) {
      console.log(`  Applied preset: ${preset.name}`);
    }
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
  const reservedKey = findReservedCustomNetworkPolicyKey(np);
  if (reservedKey) {
    console.error(`  Custom presets cannot own reserved network policy key '${reservedKey}'.`);
    return null;
  }
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

function getAppliedPresets(sandboxName: string, timeoutMs?: number): string[] {
  return getGatewayPresets(sandboxName, timeoutMs) ?? [];
}

function listCustomPresets(sandboxName: string): PresetInfo[] {
  const current = readCurrentSandboxPolicy(sandboxName);
  if (!current) return [];
  const parsed = YAML.parse(current);
  if (!isPolicyDocument(parsed) || !isPolicyObject(parsed.network_policies)) return [];
  const names = new Set<string>();
  for (const key of Object.keys(parsed.network_policies)) {
    const decoded = parseCustomPolicyKey(key);
    if (decoded) names.add(decoded.presetName);
  }
  return [...names].sort().map((name) => ({
    file: `${name}.yaml`,
    name,
    description: "custom OpenShell policy",
  }));
}

/** Return whether the live OpenShell key belongs to a namespaced custom preset. */
function customPresetOwnsNetworkPolicyKey(sandboxName: string, policyKey: string): boolean {
  const content = readCurrentSandboxPolicy(sandboxName);
  if (!content) return false;
  const parsed = YAML.parse(content);
  if (!isPolicyDocument(parsed) || !isPolicyObject(parsed.network_policies)) return false;
  return Object.keys(parsed.network_policies).some((key) => {
    const decoded = parseCustomPolicyKey(key);
    return decoded?.originalKey === policyKey;
  });
}

/**
 * Query the gateway for the currently loaded policy and determine which
 * presets are actually enforced by matching network_policies entries
 * against known preset definitions and live namespaced custom entries. (#3590)
 *
 * Returns an array of preset names whose network_policies keys are all
 * found in the gateway's loaded policy, or `null` when the gateway
 * cannot be reached / returns an unparseable response.  Callers use
 * `null` to distinguish "gateway unreachable" from "gateway has no
 * matching presets" (`[]`).
 */
function getGatewayPresets(sandboxName: string, timeoutMs?: number): string[] | null {
  let sandbox: ReturnType<typeof registry.getSandbox>;
  let gatewayName: string;
  try {
    sandbox = registry.getSandbox(sandboxName);
    if (!sandbox) return null;
    gatewayName = resolveSandboxGatewayName(sandbox);
  } catch {
    return null;
  }
  const sandboxAgent = sandbox.agent ?? null;
  const builtins = inspectGatewayPresetNames({
    readPolicy: () => {
      try {
        return readLivePolicyDocument(sandboxName, gatewayName, "effective", timeoutMs);
      } catch {
        return "";
      }
    },
    parseCurrentPolicy: parseCurrentPolicyOrEmpty,
    extractPresetEntries,
    sources: () => [
      ...listPresets({ agent: sandboxAgent }).map((preset) => ({
        name: preset.name,
        content: loadPresetForSandbox(sandboxName, preset.name),
      })),
    ],
  });
  if (builtins === null) return null;
  return [...new Set([...builtins, ...listCustomPresets(sandboxName).map((entry) => entry.name)])];
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
    readPolicy: () => readCurrentSandboxPolicy(sandboxName) ?? "",
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
 * resolves to the chosen preset name or `null` on cancel. Invalid input
 * returns `null` with process exit status 1. Rejects with `code: "EOF"` when
 * stdin closes before an answer (see `askPreset`).
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
  const item = /^\d+$/.test(effectiveInput) ? items[Number(effectiveInput) - 1] : undefined;
  if (!item) {
    process.stderr.write("\n  Invalid preset number.\n");
    process.exitCode = 1;
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

export type { ExternalPolicyPreset };
export {
  applyPreset,
  applyPresetContent,
  applyPresets,
  assertOpenshellResolvable,
  clampSetupPolicyPresetNames,
  customPresetOwnsNetworkPolicyKey,
  excludeBaselineEntry,
  extractPresetEntries,
  filterSetupPolicyPresets,
  getAppliedPresets,
  getGatewayPresets,
  getOpenClawNpmCompatibilityState,
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
  logOpenClawNpmCompatibilityDisclosure,
  logPresetNoNewEgress,
  logPresetScope,
  logPresetScopeForState,
  mergePresetIntoPolicy,
  mergePresetNamesIntoPolicy,
  networkPoliciesHasAllowedIps,
  PRESETS_DIR,
  parseCurrentPolicyOrEmpty as parseCurrentPolicy,
  parsePresetPolicyKeys,
  prepareTrustedPrivatePolicyPresets,
  presetContentMatchesGateway,
  removePreset,
  removePresetFromPolicy,
  reconcileTeamsOutlookLoginCredentialBinding,
  renderPresetScope,
  resolveAgentBaselinePolicy,
  resolveSandboxBaselinePolicy,
  restoreBaselineEntry,
  selectForRemoval,
  selectFromList,
  setupPolicyPresetSupported,
};
