// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import yaml from "yaml";
import { loadState } from "./blueprint/state.js";
import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";

const execFileAsync = promisify(execFile);

const OPEN_SHELL_TIMEOUT_MS = 5000;
const MAX_SUMMARY_RULES = 3;
const MAX_SUMMARY_PATHS = 4;
/** Maximum number of session cache entries retained before LRU eviction. */
const CACHE_MAX_SIZE = 100;
/** Time-to-live in milliseconds for a session cache entry (1 hour). */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Uniquely identifies a sandbox+policy state at a point in time. */
interface RuntimeFingerprint {
  sandboxName: string;
  sandboxPhase: string | null;
  policyVersion: string | null;
  policyHash: string | null;
  policyStatus: string | null;
}

/** Human-readable policy summary lines injected into the agent context. */
interface RuntimeSummary {
  sandboxName: string;
  sandboxPhase: string | null;
  networkLines: string[];
  filesystemLines: string[];
}

/** A single entry stored in the per-session runtime cache. */
interface SessionCacheEntry {
  fingerprintKey: string;
  summary: RuntimeSummary;
  /** Unix timestamp (ms) when this entry was created, used for TTL eviction. */
  createdAt: number;
}

/** Module-level cache mapping session keys to their last-injected runtime state. */
const sessionRuntimeCache = new Map<string, SessionCacheEntry>();

/**
 * Resolves the active sandbox name by preferring the persisted state value
 * over the plugin configuration default.
 */
function getSandboxName(pluginConfig: NemoClawConfig): string {
  return loadState().sandboxName ?? pluginConfig.sandboxName;
}

/**
 * Executes an `openshell` subcommand and returns stdout, or throws on failure.
 *
 * Returns `null` when the command exits successfully but produces no output.
 * Callers that need graceful degradation should catch errors explicitly.
 *
 * @throws When openshell is unavailable, times out, or exits with a non-zero
 *   status code.
 */
async function execOpenShell(args: string[]): Promise<string | null> {
  const { stdout } = await execFileAsync("openshell", args, {
    timeout: OPEN_SHELL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim() || null;
}

/**
 * Extracts the value following a `label:` prefix in multi-line openshell output.
 *
 * @returns The trimmed value string, or `null` when the label is absent or blank.
 */
function parseLabeledLine(output: string | null, label: string): string | null {
  if (!output) {
    return null;
  }
  const line = output
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${label}:`));
  if (!line) {
    return null;
  }
  const value = line.slice(label.length + 1).trim();
  return value.length > 0 ? value : null;
}

/**
 * Coerces an unknown value to a non-empty string array, dropping blanks.
 */
function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

/**
 * Strips any leading prose from openshell policy output and returns the YAML
 * portion, or `null` when no recognisable YAML start marker is found.
 */
function normalizePolicyYaml(output: string | null): string | null {
  if (!output) {
    return null;
  }
  const yamlStartMarkers = ["\n---\n", "---\n", "\nversion:", "version:\n", "\nfilesystem_policy:"];
  for (const marker of yamlStartMarkers) {
    const index = output.indexOf(marker);
    if (index === -1) {
      continue;
    }
    return marker.startsWith("\n") ? output.slice(index + 1).trim() : output.slice(index).trim();
  }
  return output.trim();
}

/**
 * Produces a short human-readable description of a single network endpoint's
 * access type, preferring explicit `access` field, then rule count, then protocol.
 */
function describeEndpointAccess(endpoint: Record<string, unknown>): string {
  if (typeof endpoint["access"] === "string" && endpoint["access"].trim().length > 0) {
    return endpoint["access"].trim();
  }
  const rules = Array.isArray(endpoint["rules"]) ? endpoint["rules"] : [];
  if (rules.length > 0) {
    const ruleCount = String(rules.length);
    return `${ruleCount} custom rule${rules.length === 1 ? "" : "s"}`;
  }
  if (typeof endpoint["protocol"] === "string" && endpoint["protocol"].trim().length > 0) {
    return endpoint["protocol"].trim();
  }
  return "explicit allow";
}

/**
 * Converts the `network_policies` map from a parsed policy document into a
 * list of summary lines suitable for agent consumption.  At most
 * `MAX_SUMMARY_RULES` named rules are emitted; any excess is noted.
 */
function summarizeNetworkPolicies(policy: Record<string, unknown> | null): string[] {
  const networkPolicies = (policy?.["network_policies"] ?? {}) as Record<string, unknown>;
  const entries = Object.entries(networkPolicies);
  if (entries.length === 0) {
    return [
      "outbound network is deny-by-default; assume no arbitrary internet access",
      "blocked requests can return proxy 403 and may need operator approval or policy changes",
    ];
  }
  const lines = entries.slice(0, MAX_SUMMARY_RULES).map(([ruleId, entry]) => {
    const e = entry as Record<string, unknown>;
    const name = (typeof e["name"] === "string" ? e["name"].trim() : null) || ruleId;
    const endpoints = Array.isArray(e["endpoints"]) ? e["endpoints"] : [];
    const endpoint = endpoints[0] as Record<string, unknown> | undefined;
    const host =
      (typeof endpoint?.["host"] === "string" ? endpoint["host"].trim() : null) || "unknown-host";
    const port = typeof endpoint?.["port"] === "number" ? endpoint["port"] : 0;
    const destination = port > 0 ? `${host}:${String(port)}` : host;
    const access = endpoint ? describeEndpointAccess(endpoint) : "explicit allow";
    const binaries = Array.isArray(e["binaries"]) ? e["binaries"] : [];
    const firstBinary = binaries[0] as Record<string, unknown> | undefined;
    const binary =
      typeof firstBinary?.["path"] === "string" ? firstBinary["path"].trim() : undefined;
    const binaryNote = binary ? ` via ${binary}` : "";
    return `${name}: ${destination} (${access})${binaryNote}`;
  });
  if (entries.length > MAX_SUMMARY_RULES) {
    lines.push(`${String(entries.length - MAX_SUMMARY_RULES)} additional network rule(s) omitted`);
  }
  lines.unshift("outbound network is deny-by-default except for the active policy rules below");
  lines.push("if a fetch fails with proxy 403, report it as an OpenShell policy block");
  return lines;
}

/**
 * Converts the `filesystem_policy` section of a parsed policy document into
 * a list of summary lines.  At most `MAX_SUMMARY_PATHS` writable and read-only
 * paths are listed; workdir inclusion is noted when set.
 */
function summarizeFilesystem(policy: Record<string, unknown> | null): string[] {
  const fsPolicy = policy?.["filesystem_policy"] as Record<string, unknown> | undefined;
  if (!fsPolicy) {
    return ["filesystem/process access is sandboxed; do not assume host-level access"];
  }
  const lines = ["filesystem/process access is sandboxed; do not assume host-level access"];
  if (fsPolicy["include_workdir"] === true) {
    lines.push("working directory is included in the sandbox policy");
  }
  const readWrite = coerceStringArray(fsPolicy["read_write"]).slice(0, MAX_SUMMARY_PATHS);
  if (readWrite.length > 0) {
    lines.push(`writable paths include: ${readWrite.join(", ")}`);
  }
  const readOnly = coerceStringArray(fsPolicy["read_only"]).slice(0, MAX_SUMMARY_PATHS);
  if (readOnly.length > 0) {
    lines.push(`read-only paths include: ${readOnly.join(", ")}`);
  }
  return lines;
}

/**
 * Fetches the full policy YAML for `sandboxName` and parses it.
 *
 * @throws When `execOpenShell` fails (openshell unavailable, timeout, etc.),
 *   when the output contains no recognisable YAML, or when the YAML document
 *   cannot be parsed as an object.  Callers must not cache the result of a
 *   degraded or missing policy load.
 */
async function loadPolicyDoc(sandboxName: string): Promise<Record<string, unknown>> {
  // Intentionally does not catch execOpenShell errors — propagate to caller so
  // that only successful policy loads are written to sessionRuntimeCache.
  const output = await execOpenShell(["policy", "get", sandboxName, "--full"]);
  const yamlText = normalizePolicyYaml(output);
  if (!yamlText) {
    throw new Error(`openshell policy get --full returned no YAML for sandbox "${sandboxName}"`);
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(yamlText);
  } catch (error) {
    throw new Error(`failed to parse openshell policy document: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("openshell policy get --full returned a non-object document");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Builds a `RuntimeSummary` for an already-resolved fingerprint by loading
 * the full policy document and generating human-readable policy lines.
 *
 * @throws When the underlying `loadPolicyDoc` call fails.
 */
async function getRuntimeSummaryFromFingerprint(
  fingerprint: RuntimeFingerprint,
): Promise<RuntimeSummary> {
  const policyDoc = await loadPolicyDoc(fingerprint.sandboxName);
  return {
    sandboxName: fingerprint.sandboxName,
    sandboxPhase: fingerprint.sandboxPhase,
    networkLines: summarizeNetworkPolicies(policyDoc),
    filesystemLines: summarizeFilesystem(policyDoc),
  };
}

/**
 * Queries openshell for sandbox state and policy metadata and assembles a
 * `RuntimeFingerprint`.  Individual command failures are tolerated — the
 * corresponding fingerprint fields are left `null` — so that a partial
 * openshell outage does not block fingerprint computation entirely.
 */
async function getRuntimeFingerprint(pluginConfig: NemoClawConfig): Promise<RuntimeFingerprint> {
  const sandboxName = getSandboxName(pluginConfig);
  // Use per-call error handling so one failing command doesn't abort the other.
  const [sandboxOutput, policyOutput] = await Promise.all([
    execOpenShell(["sandbox", "get", sandboxName]).catch(() => null),
    execOpenShell(["policy", "get", sandboxName]).catch(() => null),
  ]);
  return {
    sandboxName,
    sandboxPhase: parseLabeledLine(sandboxOutput, "Phase"),
    policyVersion: parseLabeledLine(policyOutput, "Version"),
    policyHash: parseLabeledLine(policyOutput, "Hash"),
    policyStatus: parseLabeledLine(policyOutput, "Status"),
  };
}

/**
 * Serialises a `RuntimeFingerprint` to a stable string key used for cache
 * comparisons.
 */
function serializeFingerprint(fingerprint: RuntimeFingerprint): string {
  return [
    fingerprint.sandboxName,
    fingerprint.sandboxPhase ?? "",
    fingerprint.policyVersion ?? "",
    fingerprint.policyHash ?? "",
    fingerprint.policyStatus ?? "",
  ].join("|");
}

/**
 * Resolves the cache key for the current agent session.  Returns the
 * `sessionKey` from `hookContext` when present and non-empty, or `undefined`
 * when no per-session identifier is available.
 *
 * A `undefined` return value signals to callers that caching should be
 * skipped entirely for this invocation so that different conversations without
 * session keys never share a cache entry.
 */
function getSessionCacheKey(
  _pluginConfig: NemoClawConfig,
  hookContext: unknown,
): string | undefined {
  if (hookContext && typeof hookContext === "object") {
    const ctx = hookContext as Record<string, unknown>;
    const sessionKey = ctx["sessionKey"];
    if (typeof sessionKey === "string" && sessionKey.trim().length > 0) {
      return sessionKey;
    }
  }
  return undefined;
}

/**
 * Evicts entries from `sessionRuntimeCache` that have exceeded `CACHE_TTL_MS`
 * or, when the cache has grown beyond `CACHE_MAX_SIZE`, removes the oldest
 * entries (by insertion/creation time) until it is within the limit.
 */
function evictCache(): void {
  const now = Date.now();
  // Remove TTL-expired entries first.
  for (const [key, entry] of sessionRuntimeCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      sessionRuntimeCache.delete(key);
    }
  }
  // If still over the size cap, remove oldest entries.
  if (sessionRuntimeCache.size > CACHE_MAX_SIZE) {
    const sortedEntries = [...sessionRuntimeCache.entries()].sort(
      ([, a], [, b]) => a.createdAt - b.createdAt,
    );
    const excess = sessionRuntimeCache.size - CACHE_MAX_SIZE;
    for (let i = 0; i < excess; i++) {
      sessionRuntimeCache.delete(sortedEntries[i][0]);
    }
  }
}

/**
 * Assembles the full `<nemoclaw-runtime>` context block for injection at the
 * start of an agent session.
 */
function buildRuntimeContextText(summary: RuntimeSummary): string {
  const lines = [
    "<nemoclaw-runtime>",
    `You are running inside OpenShell sandbox "${summary.sandboxName}" via NemoClaw.`,
    "Treat this as a sandboxed environment, not unrestricted host access.",
    summary.sandboxPhase ? `Current sandbox phase: ${summary.sandboxPhase}.` : null,
    "Network policy:",
    ...summary.networkLines.map((line) => `- ${line}`),
    "Filesystem policy:",
    ...summary.filesystemLines.map((line) => `- ${line}`),
    "Behavior:",
    "- Do not claim unrestricted host or internet access.",
    "- if access is blocked, say it is blocked and ask the operator to adjust policy or approve it in OpenShell",
    "</nemoclaw-runtime>",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

/**
 * Assembles a `<nemoclaw-runtime-update>` delta block when the sandbox state
 * has changed since the last injection.  Emits a phase-change note when the
 * phase differs, the current network policy lines, and the current filesystem
 * policy lines when they differ from the previous summary.
 */
function buildRuntimeDeltaText(
  previous: SessionCacheEntry,
  nextFingerprint: RuntimeFingerprint,
  nextSummary: RuntimeSummary,
): string {
  const lines = [
    "<nemoclaw-runtime-update>",
    "OpenShell sandbox state changed since your earlier NemoClaw context.",
  ];
  if (previous.summary.sandboxPhase !== nextFingerprint.sandboxPhase) {
    lines.push(
      `- Sandbox phase: ${previous.summary.sandboxPhase ?? "unknown"} -> ${nextFingerprint.sandboxPhase ?? "unknown"}`,
    );
  }
  lines.push("- Re-check the current restrictions before claiming what is allowed.");
  lines.push("- Active network policy now:");
  lines.push(...nextSummary.networkLines.map((line) => `  - ${line}`));
  const prevFsKey = previous.summary.filesystemLines.join("\n");
  const nextFsKey = nextSummary.filesystemLines.join("\n");
  if (prevFsKey !== nextFsKey) {
    lines.push("- Active filesystem policy now:");
    lines.push(...nextSummary.filesystemLines.map((line) => `  - ${line}`));
  }
  lines.push("</nemoclaw-runtime-update>");
  return lines.join("\n");
}

/**
 * Checks the session cache and returns the appropriate context string to
 * prepend, or `null` when the fingerprint is unchanged and no injection is
 * needed.
 *
 * When no session key is available (i.e. `getSessionCacheKey` returns
 * `undefined`) caching is skipped entirely and a full context block is always
 * returned so that unrelated conversations never share stale state.
 *
 * Writes to `sessionRuntimeCache` only when `loadPolicyDoc` succeeds, so
 * degraded openshell states are never persisted as authoritative cached
 * entries.
 *
 * @throws When `getRuntimeFingerprint` or `getRuntimeSummaryFromFingerprint`
 *   fails (i.e. openshell is unavailable for the policy get call).
 */
async function getCachedRuntimeInjection(
  pluginConfig: NemoClawConfig,
  hookContext: unknown,
): Promise<string | null> {
  const fingerprint = await getRuntimeFingerprint(pluginConfig);
  const fingerprintKey = serializeFingerprint(fingerprint);
  const cacheKey = getSessionCacheKey(pluginConfig, hookContext);

  // No session key — skip caching entirely to avoid cross-conversation sharing.
  if (cacheKey === undefined) {
    const summary = await getRuntimeSummaryFromFingerprint(fingerprint);
    return buildRuntimeContextText(summary);
  }

  // Evict stale/excess entries before reading so we never return a stale hit.
  evictCache();
  const cached = sessionRuntimeCache.get(cacheKey);
  if (cached?.fingerprintKey === fingerprintKey) {
    return null;
  }
  // May throw if openshell is unavailable for the full policy fetch; the caller
  // must catch and apply the static fallback — do not cache on failure.
  const summary = await getRuntimeSummaryFromFingerprint(fingerprint);
  sessionRuntimeCache.set(cacheKey, { fingerprintKey, summary, createdAt: Date.now() });
  // Enforce size cap after the new entry is written.
  evictCache();
  if (!cached) {
    return buildRuntimeContextText(summary);
  }
  return buildRuntimeDeltaText(cached, fingerprint, summary);
}

/**
 * Returns a `RuntimeSummary` reflecting the current sandbox and policy state.
 *
 * Degrades gracefully when openshell is unavailable: returns deny-by-default
 * network lines and generic filesystem lines rather than throwing.
 */
export async function getRuntimeSummary(pluginConfig: NemoClawConfig): Promise<RuntimeSummary> {
  try {
    const fingerprint = await getRuntimeFingerprint(pluginConfig);
    return await getRuntimeSummaryFromFingerprint(fingerprint);
  } catch {
    let sandboxName = pluginConfig.sandboxName;
    try {
      sandboxName = getSandboxName(pluginConfig);
    } catch {
      // Keep the configured default if persisted state cannot be read.
    }
    return {
      sandboxName,
      sandboxPhase: null,
      networkLines: summarizeNetworkPolicies(null),
      filesystemLines: summarizeFilesystem(null),
    };
  }
}

/**
 * Registers a `before_agent_start` hook that prepends a `<nemoclaw-runtime>`
 * context block (or a `<nemoclaw-runtime-update>` delta) to each agent turn.
 *
 * Falls back to a minimal static context block if openshell is unavailable or
 * any internal error occurs, and logs a warning via `api.logger`.
 */
export function registerRuntimeContext(api: OpenClawPluginApi, pluginConfig: NemoClawConfig): void {
  api.on("before_agent_start", async (_event: unknown, hookContext: unknown) => {
    // Initialise to the configured default; overwritten below with the live
    // state value so the fallback block reflects the active sandbox name even
    // when the sandbox was changed after the plugin was initialised.
    let activeSandbox = pluginConfig.sandboxName;
    try {
      activeSandbox = getSandboxName(pluginConfig);
      const prependContext = await getCachedRuntimeInjection(pluginConfig, hookContext);
      if (!prependContext) {
        return undefined;
      }
      return {
        prependContext,
      };
    } catch (err) {
      api.logger.warn(`nemoclaw runtime context injection failed: ${String(err)}`);
      return {
        prependContext: [
          "<nemoclaw-runtime>",
          `You are running inside OpenShell sandbox "${activeSandbox}" via NemoClaw.`,
          "Treat network access as deny-by-default and report proxy 403 responses as policy blocks.",
          "Do not claim unrestricted host or internet access.",
          "</nemoclaw-runtime>",
        ].join("\n"),
      };
    }
  });
}
