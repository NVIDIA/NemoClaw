#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Generate openclaw.json from environment variables.
//
// Called at Docker image build time after ARG->ENV promotion. Reads all
// configuration from process.env, never from Dockerfile source interpolation.
//
// Main inputs:
//   CHAT_UI_URL, NEMOCLAW_DASHBOARD_PORT, NEMOCLAW_MODEL,
//   NEMOCLAW_PROVIDER_KEY, NEMOCLAW_PRIMARY_MODEL_REF,
//   NEMOCLAW_INFERENCE_BASE_URL, NEMOCLAW_INFERENCE_API,
//   NEMOCLAW_INFERENCE_INPUTS, NEMOCLAW_CONTEXT_WINDOW,
//   NEMOCLAW_MAX_TOKENS, NEMOCLAW_REASONING,
//   NEMOCLAW_AGENT_TIMEOUT, NEMOCLAW_AGENT_HEARTBEAT_EVERY,
//   NEMOCLAW_INFERENCE_COMPAT_B64,
//   NEMOCLAW_DISABLE_DEVICE_AUTH,
//   NEMOCLAW_EXTRA_AGENTS_JSON_B64,
//   NEMOCLAW_PROXY_HOST, NEMOCLAW_PROXY_PORT,
//   NEMOCLAW_OPENCLAW_MANAGED_PROXY, NEMOCLAW_WEB_SEARCH_ENABLED,
//   NEMOCLAW_OPENCLAW_OTEL, NEMOCLAW_OPENCLAW_OTEL_ENDPOINT,
//   NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME, NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, any>;

const KNOWN_MODEL_SETUP_AGENTS = new Set(["openclaw", "hermes"]);
const MODEL_SETUP_EFFECT_KEYS: Record<string, Set<string>> = {
  openclaw: new Set(["openclawCompat", "openclawPlugins", "openclawTools"]),
  hermes: new Set(["hermesCompat"]),
};
const DEFAULT_DASHBOARD_PORT = 18789;
const MIN_DASHBOARD_PORT = 1024;
const MAX_DASHBOARD_PORT = 65535;
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const DEFAULT_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";
const DEFAULT_OPENCLAW_OTEL_SERVICE_NAME = "openclaw-gateway";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function expandUser(pathValue: string): string {
  if (pathValue === "~") {
    return process.env.HOME || pathValue;
  }
  if (pathValue.startsWith(`~${sep}`) || pathValue.startsWith("~/")) {
    return join(process.env.HOME || "~", pathValue.slice(2));
  }
  return pathValue;
}

function coercePositiveInt(env: Env, name: string, defaultValue: number): number {
  const raw = env[name] || String(defaultValue);
  let value = 0;
  if (/^\d+$/.test(raw) && raw.length < 1000) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) {
      value = parsed;
    }
  }
  if (value > 0) {
    return value;
  }
  console.error(
    `[SECURITY] ${name} must be a positive integer, got "${raw}" ` +
      `-- skipping override, falling back to default (${defaultValue})`,
  );
  return defaultValue;
}

function isLoopback(hostname: string): boolean {
  const normalized = (hostname || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeUrlForParse(rawUrl: string): string {
  if (rawUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) {
    return `http://${rawUrl}`;
  }
  return rawUrl;
}

function truthyEnvDefault(env: Env, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  return !FALSE_VALUES.has(raw.trim().toLowerCase());
}

function parseOpenClawOtelSampleRate(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.0 || value > 1.0) {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE must be between 0.0 and 1.0");
  }
  return value;
}

function buildOpenClawOtelConfig(env: Env): JsonObject | undefined {
  if (!truthyEnvDefault(env, "NEMOCLAW_OPENCLAW_OTEL", false)) {
    return undefined;
  }

  const endpoint = (env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT || DEFAULT_OPENCLAW_OTEL_ENDPOINT).trim();
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT must be an http(s) OTLP/HTTP endpoint");
  }
  if (!["http:", "https:"].includes(parsedEndpoint.protocol) || !parsedEndpoint.host) {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT must be an http(s) OTLP/HTTP endpoint");
  }
  if (parsedEndpoint.username || parsedEndpoint.password) {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT must not include credentials");
  }

  const serviceName = (
    env.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME || DEFAULT_OPENCLAW_OTEL_SERVICE_NAME
  ).trim();
  if (!serviceName) {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME must not be empty");
  }

  return {
    enabled: true,
    endpoint,
    protocol: "http/protobuf",
    serviceName,
    traces: true,
    metrics: false,
    logs: false,
    sampleRate: parseOpenClawOtelSampleRate(
      (env.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE || "1.0").trim(),
    ),
  };
}

function validateDashboardPort(raw: string, envName: string): number {
  const stripped = raw.trim();
  if (!/^\d+$/.test(stripped)) {
    throw new Error(`${envName} must be an integer between 1024 and 65535`);
  }
  const value = Number(stripped);
  if (value < MIN_DASHBOARD_PORT || value > MAX_DASHBOARD_PORT) {
    throw new Error(`${envName} must be an integer between 1024 and 65535`);
  }
  return value;
}

type ParsedUrl = {
  scheme: string;
  hostname: string;
  port: number | null;
  origin: string | null;
};

function parseUrl(rawUrl: string): ParsedUrl {
  // Match browser URL semantics for CHAT_UI_URL security decisions. In
  // particular, userinfo such as "localhost@remote" must not be treated as
  // the effective host.
  try {
    const url = new URL(rawUrl);
    const port = url.port ? Number(url.port) : null;
    return {
      scheme: url.protocol.replace(/:$/, ""),
      hostname: url.hostname.toLowerCase(),
      port: port !== null && Number.isSafeInteger(port) ? port : null,
      origin: url.origin === "null" ? null : url.origin,
    };
  } catch {
    return { scheme: "", hostname: "", port: null, origin: null };
  }
}

function chatUiUrlPort(chatUiUrl: string): number | null {
  const parsed = parseUrl(normalizeUrlForParse(chatUiUrl));
  if (parsed.port === null) {
    return null;
  }
  if (parsed.port < MIN_DASHBOARD_PORT || parsed.port > MAX_DASHBOARD_PORT) {
    return null;
  }
  return parsed.port;
}

function resolveGatewayPort(env: Env, chatUiUrl: string): number {
  const rawDashboardPort = env.NEMOCLAW_DASHBOARD_PORT || "";
  if (rawDashboardPort.trim()) {
    return validateDashboardPort(rawDashboardPort, "NEMOCLAW_DASHBOARD_PORT");
  }
  return chatUiUrlPort(chatUiUrl) || DEFAULT_DASHBOARD_PORT;
}

function hostForOrigin(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname;
  }
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function registryRoots(env: Env): string[] {
  const roots: string[] = [];
  const explicit = env.NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR;
  if (explicit) {
    roots.push(explicit);
  }
  roots.push(
    "/opt/nemoclaw-blueprint/model-specific-setup",
    "/sandbox/.nemoclaw/blueprints/0.1.0/model-specific-setup",
    join(dirname(SCRIPT_DIR), "nemoclaw-blueprint", "model-specific-setup"),
    join(process.cwd(), "nemoclaw-blueprint", "model-specific-setup"),
  );
  return unique(roots);
}

function isDirectory(pathValue: string): boolean {
  try {
    return statSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}

function findRegistryRoot(env: Env): string | null {
  const explicit = env.NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR;
  if (explicit) {
    if (!isDirectory(explicit)) {
      throw new Error(
        "NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory: " + explicit,
      );
    }
    return explicit;
  }

  for (const root of registryRoots(env)) {
    if (isDirectory(root)) {
      return root;
    }
  }
  return null;
}

function validateManifestPayload(payload: unknown, manifestPath: string): JsonObject {
  if (!isObject(payload)) {
    throw new Error(`${manifestPath}: manifest must be a JSON object`);
  }

  const setupId = payload.id;
  if (typeof setupId !== "string" || !setupId.trim()) {
    throw new Error(`${manifestPath}: field 'id' must be a non-empty string`);
  }

  const agent = payload.agent;
  if (typeof agent !== "string" || !agent.trim()) {
    throw new Error(`${manifestPath}: field 'agent' is required`);
  }
  if (!KNOWN_MODEL_SETUP_AGENTS.has(agent)) {
    throw new Error(`${manifestPath}: unknown agent '${agent}'`);
  }

  const description = payload.description;
  if (typeof description !== "string" || !description.trim()) {
    throw new Error(`${manifestPath}: field 'description' must be a non-empty string`);
  }

  const match = payload.match;
  if (!isObject(match)) {
    throw new Error(`${manifestPath}: field 'match' must be an object`);
  }
  if (Object.keys(match).length === 0) {
    throw new Error(`${manifestPath}: field 'match' must be a non-empty object`);
  }
  const allowedMatchKeys = new Set(["modelIds", "providerKey", "inferenceApi", "baseUrl"]);
  const unknownMatchKeys = Object.keys(match)
    .filter((key) => !allowedMatchKeys.has(key))
    .sort();
  if (unknownMatchKeys.length > 0) {
    throw new Error(`${manifestPath}: unknown match keys: ${unknownMatchKeys.join(", ")}`);
  }

  const modelIds = match.modelIds;
  if (
    modelIds !== undefined &&
    (!Array.isArray(modelIds) ||
      modelIds.length === 0 ||
      !modelIds.every((modelId) => typeof modelId === "string" && modelId.trim()))
  ) {
    throw new Error(`${manifestPath}: match.modelIds must be a non-empty string array`);
  }
  for (const key of ["providerKey", "inferenceApi", "baseUrl"]) {
    const value = match[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`${manifestPath}: match.${key} must be a non-empty string`);
    }
  }

  const effects = payload.effects;
  if (!isObject(effects) || Object.keys(effects).length === 0) {
    throw new Error(`${manifestPath}: field 'effects' must be a non-empty object`);
  }

  return payload;
}

function validateSelectedAgentEffects(
  payload: JsonObject,
  manifestPath: string,
  registryRoot: string,
): void {
  const agent = payload.agent;
  const effects = payload.effects;
  const allowedEffectKeys = MODEL_SETUP_EFFECT_KEYS[agent];
  const unknownEffectKeys = Object.keys(effects)
    .filter((key) => !allowedEffectKeys.has(key))
    .sort();
  if (unknownEffectKeys.length > 0) {
    throw new Error(
      `${manifestPath}: unknown effects for agent '${agent}': ${unknownEffectKeys.join(", ")}`,
    );
  }

  if (agent === "openclaw") {
    const compat = effects.openclawCompat;
    if (compat !== undefined && !isObject(compat)) {
      throw new Error(`${manifestPath}: effects.openclawCompat must be an object`);
    }

    const tools = effects.openclawTools;
    if (tools !== undefined) {
      if (!isObject(tools)) {
        throw new Error(`${manifestPath}: effects.openclawTools must be an object`);
      }
      const unknownToolKeys = Object.keys(tools)
        .filter((key) => key !== "toolSearch")
        .sort();
      if (unknownToolKeys.length > 0) {
        throw new Error(
          `${manifestPath}: unknown effects.openclawTools keys: ${unknownToolKeys.join(", ")}`,
        );
      }
      if ("toolSearch" in tools && typeof tools.toolSearch !== "boolean") {
        throw new Error(`${manifestPath}: effects.openclawTools.toolSearch must be a boolean`);
      }
    }

    const plugins = effects.openclawPlugins || [];
    if (!Array.isArray(plugins)) {
      throw new Error(`${manifestPath}: effects.openclawPlugins must be an array`);
    }
    plugins.forEach((plugin, index) => {
      if (!isObject(plugin)) {
        throw new Error(`${manifestPath}: effects.openclawPlugins[${index}] must be an object`);
      }
      for (const key of ["id", "path", "loadPath"]) {
        const value = plugin[key];
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(
            `${manifestPath}: effects.openclawPlugins[${index}].${key} ` +
              "must be a non-empty string",
          );
        }
      }
      const sourcePath = plugin.path as string;
      const sourceParts = sourcePath.split(/[\\/]+/);
      if (isAbsolute(sourcePath) || sourceParts.includes("..")) {
        throw new Error(
          `${manifestPath}: effects.openclawPlugins[${index}].path ` +
            "must be relative to nemoclaw-blueprint",
        );
      }
      if (!existsSync(join(dirname(registryRoot), sourcePath))) {
        throw new Error(
          `${manifestPath}: effects.openclawPlugins[${index}].path does not exist: ` + sourcePath,
        );
      }
      const strippedPath = sourcePath.replace(/^\/+/, "").replace(/\/+$/, "");
      const expectedLoadPath = `/usr/local/share/nemoclaw/${strippedPath}`;
      if ((plugin.loadPath as string).replace(/\/+$/, "") !== expectedLoadPath) {
        throw new Error(
          `${manifestPath}: effects.openclawPlugins[${index}].loadPath ` +
            `must be '${expectedLoadPath}'`,
        );
      }
    });
  }

  if (agent === "hermes") {
    const compat = effects.hermesCompat;
    if (compat !== undefined && !isObject(compat)) {
      throw new Error(`${manifestPath}: effects.hermesCompat must be an object`);
    }
  }
}

function modelSetupMatches(payload: JsonObject, context: JsonObject): boolean {
  const match = payload.match;
  const modelIds = match.modelIds;
  if (
    Array.isArray(modelIds) &&
    modelIds.length > 0 &&
    !new Set(modelIds.map((modelId) => String(modelId).trim().toLowerCase())).has(
      String(context.model).trim().toLowerCase(),
    )
  ) {
    return false;
  }

  const providerKey = match.providerKey;
  if (providerKey && context.providerKey !== providerKey) {
    return false;
  }

  const inferenceApi = match.inferenceApi;
  if (inferenceApi && context.inferenceApi !== inferenceApi) {
    return false;
  }

  const baseUrl = match.baseUrl;
  if (
    baseUrl &&
    String(context.baseUrl).replace(/\/+$/, "") !== String(baseUrl).replace(/\/+$/, "")
  ) {
    return false;
  }

  return true;
}

function listJsonFiles(root: string): string[] {
  const files: string[] = [];
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const pathValue = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(pathValue);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(pathValue);
      }
    }
  }
  visit(root);
  return files.sort();
}

function matchingModelSpecificSetups(agent: string, context: JsonObject, env: Env): JsonObject[] {
  const registryRoot = findRegistryRoot(env);
  if (registryRoot === null) {
    return [];
  }

  const manifests: JsonObject[] = [];
  for (const manifestPath of listJsonFiles(registryRoot)) {
    if (manifestPath.split(sep).at(-1) === "schema.json") {
      continue;
    }
    const payload = validateManifestPayload(
      JSON.parse(readFileSync(manifestPath, "utf-8")),
      manifestPath,
    );
    if (payload.agent !== agent) {
      continue;
    }
    validateSelectedAgentEffects(payload, manifestPath, registryRoot);
    if (modelSetupMatches(payload, context)) {
      manifests.push(payload);
    }
  }
  return manifests;
}

function coerceCompatDict(value: unknown): JsonObject {
  if (value === null || value === undefined) {
    return {};
  }
  if (isObject(value)) {
    return value;
  }
  throw new Error("NEMOCLAW_INFERENCE_COMPAT_B64 must decode to a JSON object or null");
}

// Canonical primary-agent entry. Always written first into agents.list, always
// flagged default: true. Pinning the slot here prevents the extra-agents env
// from displacing the primary agent: OpenClaw's resolveDefaultAgentId falls
// back to agents[0] when no entry carries default: true, so a wholesale list
// replacement would silently re-elect the first extra agent.
//
// The entry intentionally omits workspace/agentDir so OpenClaw applies its
// built-in defaults (and so the host-side migration-state collector does not
// register a phantom host root for the in-sandbox path).
const MAIN_AGENT_ID = "main";
const MAIN_AGENT_ENTRY: Readonly<JsonObject> = Object.freeze({
  id: MAIN_AGENT_ID,
  default: true,
});
const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// Secondary agent paths must live under the canonical state dir
// (/sandbox/.openclaw/). The runtime startup script (scripts/nemoclaw-start.sh
// :: provision_agent_workspaces) discovers /sandbox/.openclaw/workspace-* and
// chowns them sandbox:sandbox on first boot. The legacy /sandbox/.openclaw-data
// path is migrated away on start, so it cannot host live agent state.
const AGENT_DATA_ROOT = "/sandbox/.openclaw";

// Per-agent paths must land in the canonical sandbox layout the runtime
// startup script provisions and the sandbox isolation policy expects:
//   workspace -> /sandbox/.openclaw/workspace-<agent-id>
//   agentDir  -> /sandbox/.openclaw/agents/<agent-id>
// Allowing arbitrary descendants of /sandbox/.openclaw/ would let an
// operator point an agent at the gateway state, the openclaw.json config,
// or a credentials directory, bypassing per-agent isolation and the
// `provision_agent_workspaces` helper that chowns `workspace-*` dirs to
// the sandbox user on first boot.
function expectedAgentPath(kind: "workspace" | "agentDir", id: string): string {
  const segment = kind === "workspace" ? `workspace-${id}` : `agents/${id}`;
  return resolve(AGENT_DATA_ROOT, segment);
}

// Allowlisted operator-supplied keys for a secondary-agent entry. The
// validator copies only these keys into the baked openclaw.json so an
// unknown or credential-like field added by mistake cannot be carried into
// the image (e.g. a stray `apiKey`, `token`, or `env`). Each nested object
// has its own allowlist below — the top-level filter alone is not enough,
// because operators could still smuggle `tools.apiKey` or
// `subagents.token` into the baked config.
const ALLOWED_EXTRA_AGENT_KEYS = new Set<string>([
  "id",
  "workspace",
  "agentDir",
  "tools",
  "subagents",
  "description",
  "model",
]);
const ALLOWED_TOOLS_KEYS = new Set<string>(["profile", "allow", "deny"]);
// Mirrors the OpenClaw per-agent `agents.list[].subagents` zod schema (see
// openclaw/src/config/zod-schema.agent-runtime.ts). OpenClaw uses
// .strict() on that object, so any field we do not list here would be
// rejected by the runtime parser at boot. `maxSpawnDepth` is intentionally
// absent: OpenClaw only accepts it on `agents.defaults.subagents`, never
// per-agent.
const ALLOWED_SUBAGENTS_KEYS = new Set<string>([
  "delegationMode",
  "allowAgents",
  "model",
  "thinking",
  "requireAgentId",
]);
const ALLOWED_AGENTS_DEFAULTS_KEYS = new Set<string>(["subagents"]);
const ALLOWED_DEFAULTS_SUBAGENTS_KEYS = new Set<string>(["maxSpawnDepth"]);
const ALLOWED_MAIN_KEYS = new Set<string>(["tools", "subagents"]);
const SUBAGENT_DELEGATION_MODES = new Set<string>(["suggest", "prefer"]);

function rejectUnknownKeys(obj: JsonObject, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} contains unsupported field(s): ${unknown.sort().join(", ")}. Allowed: ${[...allowed].sort().join(", ")}.`,
    );
  }
}

function pickAllowed(obj: JsonObject, allowed: Set<string>): JsonObject {
  const out: JsonObject = {};
  for (const key of allowed) {
    if (key in obj) {
      out[key] = obj[key];
    }
  }
  return out;
}

function validateExtraAgentTools(entry: JsonObject, label: string): JsonObject {
  const tools = entry.tools;
  if (!isObject(tools)) {
    throw new Error(
      `${label}.tools must be an object describing the per-agent tool policy (profile/allow/deny). Nothing is granted implicitly.`,
    );
  }
  rejectUnknownKeys(tools, ALLOWED_TOOLS_KEYS, `${label}.tools`);
  const allow = tools.allow;
  const deny = tools.deny;
  const hasAllow = Array.isArray(allow) && allow.length > 0;
  const hasDeny = Array.isArray(deny) && deny.length > 0;
  if (!hasAllow && !hasDeny) {
    throw new Error(
      `${label}.tools must declare a non-empty allow[] or deny[] (or both); secondary agents inherit no tools by default.`,
    );
  }
  for (const key of ["allow", "deny"] as const) {
    const value = tools[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((token) => typeof token !== "string" || !token)) {
      throw new Error(`${label}.tools.${key} must be an array of non-empty strings when present.`);
    }
  }
  if (tools.profile !== undefined && typeof tools.profile !== "string") {
    throw new Error(`${label}.tools.profile must be a string when present.`);
  }
  return pickAllowed(tools, ALLOWED_TOOLS_KEYS);
}

function validateModelRef(label: string, raw: unknown, primaryProvider: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${label} must be a non-empty "provider/model" string when present`);
  }
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(`${label} must be of the form "provider/model", got "${raw}"`);
  }
  const provider = raw.slice(0, slash);
  const modelTail = raw.slice(slash + 1);
  if (provider.trim() !== provider || provider.length === 0) {
    throw new Error(
      `${label} provider portion must be non-empty and contain no surrounding whitespace, got "${raw}"`,
    );
  }
  if (modelTail.trim() !== modelTail || modelTail.length === 0) {
    throw new Error(
      `${label} model portion must be non-empty and contain no surrounding whitespace, got "${raw}"`,
    );
  }
  if (provider !== primaryProvider) {
    throw new Error(
      `${label} provider "${provider}" must match the onboard provider "${primaryProvider}"; cross-provider manifests are not supported`,
    );
  }
  return raw;
}

function validateSubagentsBlock(raw: unknown, label: string, primaryProvider: string): JsonObject {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isObject(raw)) {
    throw new Error(
      `${label} must be an object with any of: ${[...ALLOWED_SUBAGENTS_KEYS].sort().join(", ")}`,
    );
  }
  if ("maxSpawnDepth" in raw) {
    throw new Error(
      `${label}.maxSpawnDepth is not accepted per-agent; OpenClaw honours it only on agents.defaults.subagents. Set it under the manifest 'defaults.subagents.maxSpawnDepth' instead.`,
    );
  }
  rejectUnknownKeys(raw, ALLOWED_SUBAGENTS_KEYS, label);
  const out: JsonObject = {};
  if (raw.delegationMode !== undefined) {
    if (
      typeof raw.delegationMode !== "string" ||
      !SUBAGENT_DELEGATION_MODES.has(raw.delegationMode)
    ) {
      throw new Error(
        `${label}.delegationMode must be one of: ${[...SUBAGENT_DELEGATION_MODES].sort().join(", ")}`,
      );
    }
    out.delegationMode = raw.delegationMode;
  }
  if (raw.allowAgents !== undefined) {
    if (
      !Array.isArray(raw.allowAgents) ||
      raw.allowAgents.some((token) => typeof token !== "string" || !token)
    ) {
      throw new Error(`${label}.allowAgents must be an array of non-empty strings when present`);
    }
    out.allowAgents = [...raw.allowAgents];
  }
  if (raw.model !== undefined) {
    out.model = validateModelRef(`${label}.model`, raw.model, primaryProvider);
  }
  if (raw.thinking !== undefined) {
    if (typeof raw.thinking !== "string" || !raw.thinking) {
      throw new Error(`${label}.thinking must be a non-empty string when present`);
    }
    out.thinking = raw.thinking;
  }
  if (raw.requireAgentId !== undefined) {
    if (typeof raw.requireAgentId !== "boolean") {
      throw new Error(`${label}.requireAgentId must be a boolean when present`);
    }
    out.requireAgentId = raw.requireAgentId;
  }
  return out;
}

function validateAgentsDefaults(raw: unknown): {
  subagents: JsonObject;
} {
  if (raw === undefined || raw === null) {
    return { subagents: {} };
  }
  if (!isObject(raw)) {
    throw new Error(
      `NEMOCLAW_EXTRA_AGENTS_JSON.defaults must be an object (allowed: ${[...ALLOWED_AGENTS_DEFAULTS_KEYS].sort().join(", ")})`,
    );
  }
  rejectUnknownKeys(raw, ALLOWED_AGENTS_DEFAULTS_KEYS, "NEMOCLAW_EXTRA_AGENTS_JSON.defaults");
  const subagentsRaw = raw.subagents;
  if (subagentsRaw === undefined || subagentsRaw === null) {
    return { subagents: {} };
  }
  if (!isObject(subagentsRaw)) {
    throw new Error(
      `NEMOCLAW_EXTRA_AGENTS_JSON.defaults.subagents must be an object (allowed: ${[...ALLOWED_DEFAULTS_SUBAGENTS_KEYS].sort().join(", ")})`,
    );
  }
  rejectUnknownKeys(
    subagentsRaw,
    ALLOWED_DEFAULTS_SUBAGENTS_KEYS,
    "NEMOCLAW_EXTRA_AGENTS_JSON.defaults.subagents",
  );
  const out: JsonObject = {};
  if (subagentsRaw.maxSpawnDepth !== undefined) {
    const depth = subagentsRaw.maxSpawnDepth;
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 5) {
      throw new Error(
        "NEMOCLAW_EXTRA_AGENTS_JSON.defaults.subagents.maxSpawnDepth must be an integer between 1 and 5 (OpenClaw schema)",
      );
    }
    out.maxSpawnDepth = depth;
  }
  return { subagents: out };
}

function validateMainOverrides(
  raw: unknown,
  primaryProvider: string,
): { tools?: JsonObject; subagents?: JsonObject } {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isObject(raw)) {
    throw new Error(
      `NEMOCLAW_EXTRA_AGENTS_JSON.main must be an object (allowed: ${[...ALLOWED_MAIN_KEYS].sort().join(", ")})`,
    );
  }
  rejectUnknownKeys(raw, ALLOWED_MAIN_KEYS, "NEMOCLAW_EXTRA_AGENTS_JSON.main");
  const out: { tools?: JsonObject; subagents?: JsonObject } = {};
  if (raw.tools !== undefined) {
    out.tools = validateExtraAgentTools({ tools: raw.tools }, "NEMOCLAW_EXTRA_AGENTS_JSON.main");
  }
  if (raw.subagents !== undefined) {
    const subagents = validateSubagentsBlock(
      raw.subagents,
      "NEMOCLAW_EXTRA_AGENTS_JSON.main.subagents",
      primaryProvider,
    );
    if (Object.keys(subagents).length > 0) {
      out.subagents = subagents;
    }
  }
  return out;
}

export type ExtraAgentsPayload = {
  agents: JsonObject[];
  defaults: { subagents: JsonObject };
  main: { tools?: JsonObject; subagents?: JsonObject };
};

function validateExtraAgents(value: unknown, primaryProvider: string): ExtraAgentsPayload {
  if (value === null || value === undefined) {
    return { agents: [], defaults: { subagents: {} }, main: {} };
  }
  let agentsRaw: unknown;
  let defaultsRaw: unknown;
  let mainRaw: unknown;
  if (Array.isArray(value)) {
    // Legacy payload shape: bare array of secondary agents.
    agentsRaw = value;
  } else if (isObject(value)) {
    rejectUnknownKeys(
      value,
      new Set<string>(["agents", "defaults", "main"]),
      "NEMOCLAW_EXTRA_AGENTS_JSON",
    );
    agentsRaw = value.agents ?? [];
    defaultsRaw = value.defaults;
    mainRaw = value.main;
  } else {
    throw new Error(
      "NEMOCLAW_EXTRA_AGENTS_JSON must decode to a JSON array of agent objects or an object with {agents,defaults?,main?}",
    );
  }
  if (!Array.isArray(agentsRaw)) {
    throw new Error("NEMOCLAW_EXTRA_AGENTS_JSON.agents must be a JSON array of agent objects");
  }
  const seenIds = new Set<string>([MAIN_AGENT_ID]);
  const agents = agentsRaw.map((entry, index) => {
    const label = `NEMOCLAW_EXTRA_AGENTS_JSON.agents[${index}]`;
    if (!isObject(entry)) {
      throw new Error(`${label} must be a JSON object`);
    }
    const id = entry.id;
    if (typeof id !== "string" || !AGENT_ID_RE.test(id)) {
      throw new Error(
        `${label}.id must match ${AGENT_ID_RE} (1-32 chars, lowercase alphanumeric, dash, underscore; must start with a letter)`,
      );
    }
    if (id === MAIN_AGENT_ID) {
      throw new Error(
        `${label}.id "${MAIN_AGENT_ID}" is reserved for the primary agent; use a different id`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`${label}.id "${id}" is duplicated; agent ids must be unique`);
    }
    seenIds.add(id);
    const canonicalPaths: Record<string, string> = {};
    for (const pathKey of ["workspace", "agentDir"] as const) {
      const pathValue = entry[pathKey];
      if (typeof pathValue !== "string" || pathValue.length === 0) {
        throw new Error(`${label}.${pathKey} must be a non-empty string`);
      }
      if (!isAbsolute(pathValue)) {
        throw new Error(`${label}.${pathKey} must be an absolute path, got "${pathValue}"`);
      }
      const expected = expectedAgentPath(pathKey, id);
      if (resolve(pathValue) !== expected) {
        throw new Error(
          `${label}.${pathKey} must equal "${expected}" for agent id "${id}", got "${pathValue}"`,
        );
      }
      canonicalPaths[pathKey] = expected;
    }
    if (entry.default === true) {
      throw new Error(
        `${label}.default cannot be true; the primary "${MAIN_AGENT_ID}" agent is always the default`,
      );
    }
    rejectUnknownKeys(entry, ALLOWED_EXTRA_AGENT_KEYS, label);
    const tools = validateExtraAgentTools(entry, label);
    const subagents = validateSubagentsBlock(
      entry.subagents,
      `${label}.subagents`,
      primaryProvider,
    );
    // Build the canonical entry from a fresh object, never from the raw
    // operator input. This guarantees:
    //   - workspace/agentDir are the canonical strings (a dot-segment-laden
    //     path that resolves to the canonical target is normalised before
    //     bake, matching what provision_agent_workspaces parses);
    //   - only allowlisted keys reach the image, at every nesting level.
    const canonical: JsonObject = {
      id,
      workspace: canonicalPaths.workspace,
      agentDir: canonicalPaths.agentDir,
      tools,
    };
    if (Object.keys(subagents).length > 0) {
      canonical.subagents = subagents;
    }
    if (typeof entry.description === "string") {
      canonical.description = entry.description;
    }
    if (entry.model !== undefined) {
      canonical.model = validateModelRef(`${label}.model`, entry.model, primaryProvider);
    }
    return canonical;
  });
  return {
    agents,
    defaults: validateAgentsDefaults(defaultsRaw),
    main: validateMainOverrides(mainRaw, primaryProvider),
  };
}

function buildAgentsList(
  extras: JsonObject[],
  mainOverrides: { tools?: JsonObject; subagents?: JsonObject },
): JsonObject[] {
  const main: JsonObject = { ...MAIN_AGENT_ENTRY };
  if (mainOverrides.tools !== undefined) {
    main.tools = mainOverrides.tools;
  }
  if (mainOverrides.subagents !== undefined) {
    main.subagents = mainOverrides.subagents;
  }
  return [main, ...extras];
}

function applyOpenClawSetupEffects(
  setup: JsonObject,
  inferenceCompat: JsonObject,
  openclawPlugins: JsonObject[],
  pluginIds: Set<string>,
  openclawTools: JsonObject,
): void {
  const effects = setup.effects;
  for (const [key, value] of Object.entries(effects.openclawCompat || {})) {
    if (key in inferenceCompat && inferenceCompat[key] !== value) {
      throw new Error(
        `model-specific setup '${setup.id}' conflicts with inference compat key '${key}'`,
      );
    }
    inferenceCompat[key] = value;
  }

  for (const [key, value] of Object.entries(effects.openclawTools || {})) {
    if (key in openclawTools && openclawTools[key] !== value) {
      throw new Error(
        `model-specific setup '${setup.id}' conflicts with OpenClaw tools key '${key}'`,
      );
    }
    openclawTools[key] = value;
  }

  for (const plugin of effects.openclawPlugins || []) {
    const pluginId = plugin.id;
    if (pluginIds.has(pluginId)) {
      throw new Error(
        `model-specific setup '${setup.id}' declares duplicate OpenClaw plugin '${pluginId}'`,
      );
    }
    pluginIds.add(pluginId);
    openclawPlugins.push(plugin);
  }
}

function decodeJsonEnv(env: Env, name: string, defaultValue: string): any {
  const raw = env[name] || defaultValue;
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
}

export function buildConfig(env: Env = process.env): JsonObject {
  const proxyHost = env.NEMOCLAW_PROXY_HOST || "10.200.0.1";
  const proxyPort = env.NEMOCLAW_PROXY_PORT || "3128";
  const proxyUrl = `http://${proxyHost}:${proxyPort}`;
  const emitOpenClawManagedProxy = truthyEnvDefault(env, "NEMOCLAW_OPENCLAW_MANAGED_PROXY", true);
  const model = env.NEMOCLAW_MODEL as string;
  const rawChatUiUrl = env.CHAT_UI_URL || "";
  let chatUiUrl = rawChatUiUrl || `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`;
  const gatewayPort = resolveGatewayPort(env, chatUiUrl);
  if (
    (env.NEMOCLAW_DASHBOARD_PORT || "").trim() &&
    (!rawChatUiUrl || rawChatUiUrl === `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`)
  ) {
    chatUiUrl = `http://127.0.0.1:${gatewayPort}`;
  }
  const providerKey = env.NEMOCLAW_PROVIDER_KEY as string;
  const primaryModelRef = env.NEMOCLAW_PRIMARY_MODEL_REF as string;
  const inferenceBaseUrl = env.NEMOCLAW_INFERENCE_BASE_URL as string;
  const inferenceApi = env.NEMOCLAW_INFERENCE_API as string;
  const contextWindow = coercePositiveInt(env, "NEMOCLAW_CONTEXT_WINDOW", 131072);
  const maxTokens = coercePositiveInt(env, "NEMOCLAW_MAX_TOKENS", 4096);

  const reasoning = (env.NEMOCLAW_REASONING || "false") === "true";
  const inferenceInputs = (env.NEMOCLAW_INFERENCE_INPUTS || "text")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (inferenceInputs.length === 0) {
    inferenceInputs.push("text");
  }

  const rawAgentTimeout = env.NEMOCLAW_AGENT_TIMEOUT || "600";
  const parsedAgentTimeout = /^\d+$/.test(rawAgentTimeout) ? Number(rawAgentTimeout) : 0;
  if (!Number.isSafeInteger(parsedAgentTimeout) || parsedAgentTimeout <= 0) {
    throw new Error("NEMOCLAW_AGENT_TIMEOUT must be a positive integer");
  }
  const agentTimeout = parsedAgentTimeout;

  let agentHeartbeat = (env.NEMOCLAW_AGENT_HEARTBEAT_EVERY || "").trim();
  if (agentHeartbeat && !/^\d+(s|m|h)$/.test(agentHeartbeat)) {
    console.error(
      `[SECURITY] NEMOCLAW_AGENT_HEARTBEAT_EVERY must match ^\\d+(s|m|h)$, ` +
        `got "${agentHeartbeat}" -- skipping override, preserving OpenClaw default`,
    );
    agentHeartbeat = "";
  }

  const modelSpecificSetups = matchingModelSpecificSetups(
    "openclaw",
    {
      model,
      providerKey,
      baseUrl: inferenceBaseUrl,
      inferenceApi,
    },
    env,
  );

  const inferenceCompat = coerceCompatDict(
    decodeJsonEnv(env, "NEMOCLAW_INFERENCE_COMPAT_B64", "e30="),
  );
  const extraAgentsPayload = validateExtraAgents(
    decodeJsonEnv(env, "NEMOCLAW_EXTRA_AGENTS_JSON_B64", "W10="),
    providerKey,
  );
  const extraAgents = extraAgentsPayload.agents;
  const openclawPlugins: JsonObject[] = [];
  const openclawPluginIds = new Set<string>();
  const openclawToolOverrides: JsonObject = {};
  for (const setup of modelSpecificSetups) {
    applyOpenClawSetupEffects(
      setup,
      inferenceCompat,
      openclawPlugins,
      openclawPluginIds,
      openclawToolOverrides,
    );
  }
  const openclawTools: JsonObject = { toolSearch: true, ...openclawToolOverrides };

  if (providerKey === "ollama" || providerKey === "ollama-local") {
    inferenceCompat.supportsUsageInStreaming ??= true;
  }

  const normalizedUrl = normalizeUrlForParse(chatUiUrl);
  const parsed = parseUrl(normalizedUrl);
  const loopbackOrigin = `http://127.0.0.1:${gatewayPort}`;
  const chatOrigin = parsed.origin || loopbackOrigin;
  const portlessOrigin =
    parsed.scheme && parsed.hostname && parsed.port !== null && !isLoopback(parsed.hostname)
      ? `${parsed.scheme}://${hostForOrigin(parsed.hostname)}`
      : null;
  const origins = unique([loopbackOrigin, chatOrigin, portlessOrigin].filter(Boolean) as string[]);

  const isRemote = !isLoopback(parsed.hostname || "");
  const disableDeviceAuth = env.NEMOCLAW_DISABLE_DEVICE_AUTH === "1" || isRemote;
  const allowInsecure = parsed.scheme === "http";

  const providerModels: JsonObject[] = [
    {
      ...(Object.keys(inferenceCompat).length > 0 ? { compat: inferenceCompat } : {}),
      id: model,
      name: primaryModelRef,
      reasoning,
      input: inferenceInputs,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow,
      maxTokens,
    },
  ];
  const seenModelRefs = new Set<string>([primaryModelRef]);
  const referencedRefs: string[] = [];
  const collectRef = (ref: unknown): void => {
    if (typeof ref !== "string" || !ref) return;
    if (seenModelRefs.has(ref)) return;
    seenModelRefs.add(ref);
    referencedRefs.push(ref);
  };
  for (const agent of extraAgents) {
    collectRef(agent.model);
    if (isObject(agent.subagents)) {
      collectRef(agent.subagents.model);
    }
  }
  if (extraAgentsPayload.main.subagents !== undefined) {
    collectRef(extraAgentsPayload.main.subagents.model);
  }
  for (const ref of referencedRefs) {
    const slash = ref.indexOf("/");
    const secondaryModelId = ref.slice(slash + 1);
    providerModels.push({
      id: secondaryModelId,
      name: ref,
      reasoning,
      input: inferenceInputs,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow,
      maxTokens,
    });
  }
  const providers = {
    [providerKey]: {
      baseUrl: inferenceBaseUrl,
      apiKey: "unused",
      api: inferenceApi,
      models: providerModels,
    },
  };

  const pluginEntries: JsonObject = {
    acpx: { enabled: false },
    bonjour: { enabled: false },
    qqbot: { enabled: false },
  };
  const bundledProviderPlugins: Record<string, Set<string>> = {
    "amazon-bedrock": new Set(["amazon-bedrock", "bedrock"]),
    "amazon-bedrock-mantle": new Set(["amazon-bedrock-mantle"]),
    anthropic: new Set(["anthropic"]),
    "anthropic-vertex": new Set(["anthropic-vertex"]),
    fireworks: new Set(["fireworks"]),
    google: new Set(["google", "google-gemini-cli"]),
    kimi: new Set(["kimi"]),
    lmstudio: new Set(["lmstudio"]),
    ollama: new Set(["ollama", "ollama-local"]),
    openai: new Set(["openai"]),
    xai: new Set(["xai"]),
  };
  for (const [pluginId, providerKeys] of Object.entries(bundledProviderPlugins)) {
    if (!providerKeys.has(providerKey)) {
      pluginEntries[pluginId] = { enabled: false };
    }
  }
  const openclawOtel = buildOpenClawOtelConfig(env);
  if (openclawOtel) {
    pluginEntries["diagnostics-otel"] = { enabled: true };
  }

  const plugins: JsonObject = { entries: pluginEntries };
  const pluginLoadPaths: string[] = [];
  for (const plugin of openclawPlugins) {
    pluginEntries[plugin.id] = { enabled: true };
    if (!pluginLoadPaths.includes(plugin.loadPath)) {
      pluginLoadPaths.push(plugin.loadPath);
    }
  }
  if (pluginLoadPaths.length > 0) {
    plugins.load = { paths: pluginLoadPaths };
  }

  const agentDefaults: JsonObject = {
    model: { primary: primaryModelRef },
    timeoutSeconds: agentTimeout,
    ...(agentHeartbeat ? { heartbeat: { every: agentHeartbeat } } : {}),
    skipBootstrap: true,
    thinkingDefault: "off",
  };
  if (Object.keys(extraAgentsPayload.defaults.subagents).length > 0) {
    agentDefaults.subagents = extraAgentsPayload.defaults.subagents;
  }

  const config: JsonObject = {
    agents: {
      defaults: agentDefaults,
      list: buildAgentsList(extraAgents, extraAgentsPayload.main),
    },
    models: { mode: "merge", providers },
    channels: { defaults: {} },
    tools: openclawTools,
    update: { checkOnStart: false },
    plugins,
    gateway: {
      mode: "local",
      port: gatewayPort,
      controlUi: {
        allowInsecureAuth: allowInsecure,
        dangerouslyDisableDeviceAuth: disableDeviceAuth,
        allowedOrigins: origins,
      },
      trustedProxies: ["127.0.0.1", "::1"],
      auth: { token: "" },
    },
  };

  if (emitOpenClawManagedProxy) {
    config.proxy = {
      enabled: true,
      proxyUrl,
      loopbackMode: "gateway-only",
    };
  }
  if (openclawOtel) {
    config.diagnostics = {
      enabled: true,
      otel: openclawOtel,
    };
  }

  const tools = config.tools;
  tools.web ??= {};
  tools.web.fetch = { enabled: true, useTrustedEnvProxy: true };

  if (env.NEMOCLAW_WEB_SEARCH_ENABLED === "1") {
    // OpenClaw 2026.5.x: web-search providers are external plugins. The
    // provider-owned apiKey lives under plugins.entries.<plugin>.config,
    // not inline in tools.web.search. Writing the legacy inline shape makes
    // the build-time `openclaw plugins install` exit non-zero during its
    // pre-install config validation (the brave plugin is not installed yet),
    // aborting the image build under `set -eu` before `doctor --fix` can
    // migrate it. Emit the current schema directly so install validates
    // cleanly. See NemoClaw #5266 (follow-up to #4955 / #3948).
    tools.web.search = { enabled: true, provider: "brave" };
    config.plugins.entries.brave = {
      enabled: true,
      config: { webSearch: { apiKey: "openshell:resolve:env:BRAVE_API_KEY" } },
    };
  }

  return config;
}

function preserveExistingPluginInstalls(config: JsonObject, configPath: string): void {
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return;
  }
  if (!isObject(existing)) {
    return;
  }
  const existingPlugins = existing.plugins;
  if (!isObject(existingPlugins)) {
    return;
  }
  const existingInstalls = existingPlugins.installs;
  if (!isObject(existingInstalls) || Object.keys(existingInstalls).length === 0) {
    return;
  }

  const currentPlugins = config.plugins;
  if (!isObject(currentPlugins.installs)) {
    currentPlugins.installs = {};
  }
  Object.assign(currentPlugins.installs, existingInstalls);
}

export function writeOpenClawConfig(): void {
  const config = buildConfig();
  const configPath = expandUser("~/.openclaw/openclaw.json");
  preserveExistingPluginInstalls(config, configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  chmodSync(configPath, 0o600);
}

export function main(): void {
  writeOpenClawConfig();
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
