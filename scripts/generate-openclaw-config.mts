#!/usr/bin/env node
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
//   NEMOCLAW_INFERENCE_PROVIDER_ID, NEMOCLAW_UPSTREAM_PROVIDER, NEMOCLAW_PRIMARY_MODEL_REF,
//   NEMOCLAW_INFERENCE_BASE_URL, NEMOCLAW_INFERENCE_API,
//   NEMOCLAW_INFERENCE_INPUTS, NEMOCLAW_CONTEXT_WINDOW,
//   NEMOCLAW_MAX_TOKENS, NEMOCLAW_REASONING,
//   NEMOCLAW_TOOL_DISCLOSURE,
//   NEMOCLAW_AGENT_TIMEOUT, NEMOCLAW_AGENT_HEARTBEAT_EVERY,
//   NEMOCLAW_INFERENCE_COMPAT_B64,
//   NEMOCLAW_DASHBOARD_BIND, NEMOCLAW_WSL_DASHBOARD_EXPOSURE,
//   NEMOCLAW_DISABLE_DEVICE_AUTH,
//   NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE,
//   NEMOCLAW_EXTRA_AGENTS_JSON_B64,
//   NEMOCLAW_PROXY_HOST, NEMOCLAW_PROXY_PORT,
//   NEMOCLAW_OPENCLAW_MANAGED_PROXY, NEMOCLAW_WEB_SEARCH_ENABLED,
//   NEMOCLAW_WEB_SEARCH_PROVIDER,
//   NEMOCLAW_OPENCLAW_OTEL, NEMOCLAW_OPENCLAW_OTEL_ENDPOINT,
//   NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME, NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE,
//   NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION.

import { hasProviderlessInferenceEnvironment } from "../src/lib/providerless-inference.ts";

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
import { buildAgentEntries, validateExtraAgents } from "../src/lib/extra-agents-validation.ts";
import { readToolDisclosureEnv } from "../src/lib/tool-disclosure.ts";

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
const REMOTE_DASHBOARD_BIND_VALUES = new Set(["0.0.0.0"]);
const DEVICE_AUTH_OPT_OUT_SOURCES = new Set(["operator", "managed-onboard"]);
const BOOLEAN_BUILD_FLAG_VALUES = new Set(["0", "1"]);

function readOptionalEnumEnv(env: Env, name: string, allowedValues: ReadonlySet<string>): string {
  const value = env[name] ?? "";
  if (value !== "" && !allowedValues.has(value)) {
    throw new Error(`${name} must be empty or one of: ${[...allowedValues].join(", ")}`);
  }
  return value;
}

function readBooleanBuildFlag(env: Env, name: string): boolean {
  return readOptionalEnumEnv(env, name, BOOLEAN_BUILD_FLAG_VALUES) === "1";
}

const LOCAL_OLLAMA_UPSTREAM_PROVIDER = "ollama-local";
const LOCAL_VLLM_UPSTREAM_PROVIDER = "vllm-local";
const N1X_MANAGED_VLLM_SERVING_PRESET = "vllm.n1x.single.qwen3-6-35b-a3b-nvfp4";
const N1X_COMPACTION_TIMEOUT_SECONDS = 300;
const MANAGED_INFERENCE_PROVIDER_KEY = "inference";
const MANAGED_INFERENCE_HOSTNAME = "inference.local";
// Upstream source of truth (#4781): OpenClaw's `AgentCompactionConfig` schema and
// safeguard compactor/session runtime shipped by the exact `OPENCLAW_VERSION`
// pin in the production image (`Dockerfile` and `Dockerfile.base`). The observed
// long-running `/compact` operation and growing active context occur there after
// NemoClaw hands off this config.
// NemoClaw does not own that runtime, so this is a generator-side mitigation,
// not a source fix.
// The runtime-overrides E2E validates this object with the pinned OpenClaw CLI;
// that does not prove live token reduction, so keep #4781 open. Remove this
// override only after a newer pinned OpenClaw runtime has managed-inference
// regression evidence that `/compact` completes and leaves a no-larger active
// context without it.
const MANAGED_INFERENCE_SAFEGUARD_COMPACTION: JsonObject = {
  mode: "safeguard",
  timeoutSeconds: 120,
  recentTurnsPreserve: 1,
  qualityGuard: { enabled: true, maxRetries: 0 },
  notifyUser: true,
};
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const WEB_SEARCH_PROVIDERS = {
  brave: { credentialEnv: "BRAVE_API_KEY" },
  tavily: { credentialEnv: "TAVILY_API_KEY" },
} as const;
type WebSearchProvider = keyof typeof WEB_SEARCH_PROVIDERS;
const DEFAULT_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";
const DEFAULT_OPENCLAW_OTEL_SERVICE_NAME = "openclaw-gateway";
// Runtime-facing IDs declared by the built-in messaging manifests. Package
// selection remains manifest-derived in messaging-build-applier.mts; this
// paired contract keeps each installed/bundled plugin bound to the channel key
// that must remain disabled in a neutral managed image.
export const MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES = [
  { channelId: "telegram", pluginId: "telegram" },
  { channelId: "discord", pluginId: "discord" },
  { channelId: "openclaw-weixin", pluginId: "openclaw-weixin" },
  { channelId: "slack", pluginId: "slack" },
  { channelId: "whatsapp", pluginId: "whatsapp" },
  { channelId: "msteams", pluginId: "msteams" },
  { channelId: "googlechat", pluginId: "googlechat" },
] as const;
// OpenClaw also ships channel plugins outside NemoClaw's currently supported
// messaging manifests. Keep those bundled entrypoints explicitly inert without
// representing them as activatable managed-image capabilities.
export const MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES = [
  { channelId: "a2a", pluginId: "a2a" },
  { channelId: "reef", pluginId: "reef" },
] as const;
const MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES = [
  ...MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES,
  ...MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES,
] as const;
// The managed-image capability union installs diagnostics-otel and brave-plugin. It does not
// install the Tavily Search plugin. OpenClaw validates each plugins.entries key even when
// the entry is disabled, so omit Tavily from a neutral managed image (#10325).
const MANAGED_IMAGE_OPENCLAW_PLUGIN_IDS = [
  ...MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES.map(({ pluginId }) => pluginId),
  "diagnostics-otel",
  "brave",
] as const;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWebSearchProvider(env: Env): WebSearchProvider {
  const provider = (env.NEMOCLAW_WEB_SEARCH_PROVIDER || "brave").trim();
  if (provider === "brave" || provider === "tavily") return provider;
  throw new Error(
    `NEMOCLAW_WEB_SEARCH_PROVIDER must be "brave" or "tavily", got ${JSON.stringify(provider)}`,
  );
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
  const allowedMatchKeys = new Set([
    "modelIds",
    "modelIdPrefixes",
    "providerKey",
    "inferenceApi",
    "baseUrl",
  ]);
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
  const modelIdPrefixes = match.modelIdPrefixes;
  if (
    modelIdPrefixes !== undefined &&
    (!Array.isArray(modelIdPrefixes) ||
      modelIdPrefixes.length === 0 ||
      !modelIdPrefixes.every((prefix) => typeof prefix === "string" && prefix.trim()))
  ) {
    throw new Error(`${manifestPath}: match.modelIdPrefixes must be a non-empty string array`);
  }
  if (
    Array.isArray(modelIdPrefixes) &&
    modelIdPrefixes.some((prefix) => String(prefix).includes("/"))
  ) {
    throw new Error(
      `${manifestPath}: match.modelIdPrefixes must contain bare model ids without namespaces`,
    );
  }
  if (modelIds !== undefined && modelIdPrefixes !== undefined) {
    throw new Error(
      `${manifestPath}: match.modelIds and match.modelIdPrefixes are mutually exclusive`,
    );
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
      // Source: openclaw@2026.5.27 ToolSearchSchema and resolveToolSearchConfig
      // (`src/config/zod-schema.agent-runtime.ts`, `src/agents/tool-search.ts`).
      // Keep the registry override narrower than the runtime config: false
      // disables Tool Search, while true selects its default code bridge.
      if ("toolSearch" in tools && typeof tools.toolSearch !== "boolean") {
        throw new Error(
          `${manifestPath}: effects.openclawTools.toolSearch must be a boolean override`,
        );
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
  const normalizedModel = String(context.model).trim().toLowerCase();
  const modelIds = match.modelIds;
  if (
    Array.isArray(modelIds) &&
    modelIds.length > 0 &&
    !new Set(modelIds.map((modelId) => String(modelId).trim().toLowerCase())).has(normalizedModel)
  ) {
    return false;
  }

  const modelIdPrefixes = match.modelIdPrefixes;
  const bareModel = normalizedModel.includes("/")
    ? normalizedModel.slice(normalizedModel.lastIndexOf("/") + 1)
    : normalizedModel;
  if (
    Array.isArray(modelIdPrefixes) &&
    modelIdPrefixes.length > 0 &&
    !modelIdPrefixes.some((value) => {
      const prefix = String(value).trim().toLowerCase();
      return (
        bareModel === prefix ||
        bareModel.startsWith(`${prefix}.`) ||
        bareModel.startsWith(`${prefix}-`)
      );
    })
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

const REASONING_EFFORT_VALUES = ["low", "medium", "high"];
const REASONING_EFFORT_DEFAULT = "default";
const REASONING_EFFORT_PROVIDER = "compatible-endpoint";

// OpenClaw merges params.extra_body into openai-completions request bodies, so
// this is the config-level route to a reasoning_effort the endpoint receives.
function buildReasoningEffortParams(env: Env): JsonObject {
  const raw = (env.NEMOCLAW_REASONING_EFFORT || "").trim().toLowerCase();
  const upstreamProvider = (env.NEMOCLAW_UPSTREAM_PROVIDER || "").trim();
  if (!raw || raw === REASONING_EFFORT_DEFAULT) return {};
  if (upstreamProvider !== REASONING_EFFORT_PROVIDER) return {};
  if (!REASONING_EFFORT_VALUES.includes(raw)) {
    throw new Error(
      `NEMOCLAW_REASONING_EFFORT must be one of: ${[
        ...REASONING_EFFORT_VALUES,
        REASONING_EFFORT_DEFAULT,
      ].join(", ")}`,
    );
  }
  if ((env.NEMOCLAW_INFERENCE_API as string) !== "openai-completions") return {};
  return { params: { extra_body: { reasoning_effort: raw } } };
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

function isManagedInferenceLocalRoute(
  providerKey: string | undefined,
  inferenceBaseUrl: string,
): boolean {
  if ((providerKey || "").trim() !== MANAGED_INFERENCE_PROVIDER_KEY) {
    return false;
  }
  return parseUrl(normalizeUrlForParse(inferenceBaseUrl)).hostname === MANAGED_INFERENCE_HOSTNAME;
}

// Managed inference sessions other than Local Ollama use OpenClaw's safeguard
// compaction rather than its plain runtime compactor. A two-minute timeout
// bounds each standard attempt. The N1x managed-vLLM profile needs five minutes
// because its compaction request can exceed two minutes (#11805). OpenClaw
// 2026.9.1 retired the configurable reserve fields, so its runtime owns prompt
// headroom while NemoClaw retains the profile-specific timeout. Lifecycle notices
// expose compaction progress, and successful compaction rotates the active transcript.
// These safeguards do not guarantee that summarization succeeds or that the
// resulting context is smaller.
export function buildManagedInferenceSafeguardCompaction(
  providerKey: string | undefined,
  upstreamProvider: string | undefined,
  inferenceBaseUrl: string,
  servingPreset: string | undefined,
  _contextWindow: number,
  _maxTokens: number,
): JsonObject | undefined {
  if (!isManagedInferenceLocalRoute(providerKey, inferenceBaseUrl)) {
    return undefined;
  }
  if ((upstreamProvider || "").trim() === LOCAL_OLLAMA_UPSTREAM_PROVIDER) {
    return undefined;
  }
  const isN1xManagedVllm =
    (upstreamProvider || "").trim() === LOCAL_VLLM_UPSTREAM_PROVIDER &&
    (servingPreset || "").trim() === N1X_MANAGED_VLLM_SERVING_PRESET;
  return {
    ...MANAGED_INFERENCE_SAFEGUARD_COMPACTION,
    ...(isN1xManagedVllm
      ? {
          timeoutSeconds: N1X_COMPACTION_TIMEOUT_SECONDS,
        }
      : {}),
    qualityGuard: { ...MANAGED_INFERENCE_SAFEGUARD_COMPACTION.qualityGuard },
  };
}

export function buildConfig(env: Env = process.env): JsonObject {
  const providerless = hasProviderlessInferenceEnvironment(env);
  const proxyHost = env.NEMOCLAW_PROXY_HOST || "10.200.0.1";
  const proxyPort = env.NEMOCLAW_PROXY_PORT || "3128";
  const proxyUrl = `http://${proxyHost}:${proxyPort}`;
  const emitOpenClawManagedProxy = truthyEnvDefault(env, "NEMOCLAW_OPENCLAW_MANAGED_PROXY", true);
  const model = env.NEMOCLAW_MODEL as string;
  if (!providerless && !model) throw new Error("NEMOCLAW_MODEL is required");
  const rawChatUiUrl = env.CHAT_UI_URL || "";
  let chatUiUrl = rawChatUiUrl || `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`;
  const gatewayPort = resolveGatewayPort(env, chatUiUrl);
  if (
    (env.NEMOCLAW_DASHBOARD_PORT || "").trim() &&
    (!rawChatUiUrl || rawChatUiUrl === `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`)
  ) {
    chatUiUrl = `http://127.0.0.1:${gatewayPort}`;
  }
  const providerKey = (env.NEMOCLAW_INFERENCE_PROVIDER_ID || env.NEMOCLAW_PROVIDER_KEY) as string;
  const primaryModelRef = env.NEMOCLAW_PRIMARY_MODEL_REF as string;
  const inferenceBaseUrl = env.NEMOCLAW_INFERENCE_BASE_URL as string;
  const inferenceApi = env.NEMOCLAW_INFERENCE_API as string;
  const contextWindow = coercePositiveInt(env, "NEMOCLAW_CONTEXT_WINDOW", 131072);
  const maxTokens = coercePositiveInt(env, "NEMOCLAW_MAX_TOKENS", 4096);
  const toolDisclosure = readToolDisclosureEnv(env);

  const reasoning = (env.NEMOCLAW_REASONING || "false") === "true";
  const reasoningEffortParams = buildReasoningEffortParams(env);
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

  const modelSpecificSetups = providerless
    ? []
    : matchingModelSpecificSetups(
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
  // OpenClaw v2026.5.27 accepts either a boolean shorthand or this object form.
  // Model-specific manifests intentionally remain boolean-only and replace this
  // value wholesale: false disables Tool Search; true restores upstream code
  // mode. Do not shallow-merge a boolean override into the structured object.
  const structuredToolSearch: JsonObject = {
    mode: "tools",
    searchDefaultLimit: 8,
    maxSearchLimit: 20,
  };
  const upstreamProvider = (env.NEMOCLAW_UPSTREAM_PROVIDER || "").trim();
  const openclawTools: JsonObject = {
    ...openclawToolOverrides,
    alsoAllow: ["bundle-mcp"],
    // An explicit direct request is authoritative. Compatibility manifests may
    // downgrade progressive mode to false, but may never re-enable search over
    // a user's direct selection. OpenClaw 2026.9.1 otherwise expands that false
    // fallback into the full direct catalog. llama.cpp rejects the resulting
    // request schema, so keep its progressive route on the compact structured
    // search/describe/call surface even for models whose hosted route still
    // needs the legacy direct-tool compatibility override.
    toolSearch:
      toolDisclosure === "direct"
        ? false
        : upstreamProvider === "llama-cpp-local"
          ? structuredToolSearch
          : "toolSearch" in openclawToolOverrides
            ? openclawToolOverrides.toolSearch
            : structuredToolSearch,
  };

  if (providerKey === "ollama" || providerKey === "ollama-local") {
    inferenceCompat.supportsUsageInStreaming ??= true;
  }
  // NemoClaw exposes managed llama.cpp through the custom `inference`
  // provider ID, so OpenClaw cannot infer its built-in llama.cpp schema
  // projection from the provider name. Select the upstream compatibility
  // profile explicitly before tool schemas reach llama-server's GBNF parser.
  if (upstreamProvider === "llama-cpp-local") {
    inferenceCompat.toolSchemaProfile ??= "llamacpp";
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
  const dashboardBind = readOptionalEnumEnv(
    env,
    "NEMOCLAW_DASHBOARD_BIND",
    REMOTE_DASHBOARD_BIND_VALUES,
  );
  const remoteBindOptIn = dashboardBind === "0.0.0.0";
  readBooleanBuildFlag(env, "NEMOCLAW_WSL_DASHBOARD_EXPOSURE");
  // OpenClaw 2026.9.1 retired and ignores the Control UI device-auth bypass.
  // Keep validating the historical provenance input while managed builders
  // transition, but do not emit the dead upstream configuration key.
  readOptionalEnumEnv(env, "NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE", DEVICE_AUTH_OPT_OUT_SOURCES);

  const providerModels: JsonObject[] = [
    {
      ...(Object.keys(inferenceCompat).length > 0 ? { compat: inferenceCompat } : {}),
      id: model,
      name: primaryModelRef,
      reasoning,
      ...reasoningEffortParams,
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
      ...reasoningEffortParams,
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
      timeoutSeconds: agentTimeout,
      models: providerModels,
    },
  };

  const pluginEntries: JsonObject = {
    bonjour: { enabled: false },
    nemoclaw: { enabled: true },
  };
  const managedImageCapabilityUnion = readBooleanBuildFlag(
    env,
    "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION",
  );
  if (managedImageCapabilityUnion) {
    for (const pluginId of MANAGED_IMAGE_OPENCLAW_PLUGIN_IDS) {
      pluginEntries[pluginId] = { enabled: false };
    }
  }
  const openclawOtel = buildOpenClawOtelConfig(env);
  if (openclawOtel) {
    pluginEntries["diagnostics-otel"] = { enabled: true };
  }
  const webSearchProvider =
    env.NEMOCLAW_WEB_SEARCH_ENABLED === "1" ? resolveWebSearchProvider(env) : undefined;

  const plugins: JsonObject = {
    entries: pluginEntries,
  };
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
    ...(providerless ? {} : { model: { primary: primaryModelRef } }),
    timeoutSeconds: agentTimeout,
    ...(agentHeartbeat ? { heartbeat: { every: agentHeartbeat, isolatedSession: true } } : {}),
    skipBootstrap: true,
    thinkingDefault: "off",
  };
  if (Object.keys(extraAgentsPayload.defaults.subagents).length > 0) {
    agentDefaults.subagents = extraAgentsPayload.defaults.subagents;
  }

  // OpenClaw 2026.9.1 retired the configurable reserveTokens and
  // reserveTokensFloor fields. Its agent runtime now clamps the effective
  // reserve against the selected model's context budget, preserving at least
  // half the window (up to 8k tokens) for prompts. Do not emit the old Local
  // Ollama override: the pinned runtime owns the same small-context safeguard.
  const managedInferenceCompaction = buildManagedInferenceSafeguardCompaction(
    providerKey,
    env.NEMOCLAW_UPSTREAM_PROVIDER,
    inferenceBaseUrl,
    env.NEMOCLAW_SERVING_PRESET,
    contextWindow,
    maxTokens,
  );
  if (managedInferenceCompaction) {
    agentDefaults.compaction = managedInferenceCompaction;
  }

  const channels: JsonObject = { defaults: {} };
  if (managedImageCapabilityUnion) {
    for (const { channelId } of MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES) {
      channels[channelId] = { enabled: false };
    }
  }

  const config: JsonObject = {
    agents: {
      defaults: agentDefaults,
      entries: buildAgentEntries(extraAgents, extraAgentsPayload.main),
    },
    ...(providerless ? {} : { models: { mode: "merge", providers } }),
    channels,
    tools: openclawTools,
    plugins,
    gateway: {
      mode: "local",
      port: gatewayPort,
      controlUi: {
        allowedOrigins: origins,
        ...(remoteBindOptIn && !isRemote ? { dangerouslyAllowHostHeaderOriginFallback: true } : {}),
      },
      trustedProxies: ["127.0.0.1", "::1"],
      auth: { token: "" },
      // Restart-class config changes (plugins.installs, models.pricing,
      // unrecognized keys, ...) must not let the gateway SIGUSR1-restart
      // itself: in containers the in-process restart path can fail and park
      // the process alive with no HTTP listener, which the PID-wait respawn
      // loop in nemoclaw-start.sh cannot observe (#4710). Off mode makes the
      // gateway ignore plan-driven reloads; NemoClaw applies restart-class
      // changes through sandbox rebuild or `nemoclaw <name> recover` instead.
      // Removal condition (also for the serving watchdog in
      // nemoclaw-start.sh): once the pinned OpenClaw release exits non-zero
      // when a failed in-process restart cannot re-bind its listener — so the
      // respawn loop sees the death — this pin can revert to the default
      // reload mode after a wedge drill proves no regression.
      reload: { mode: "off" },
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
  if (managedImageCapabilityUnion) {
    tools.web.search = { enabled: false };
  }

  if (webSearchProvider) {
    // OpenClaw 2026.5.x keeps provider-owned credentials under
    // plugins.entries.<provider>.config rather than inline on tools.web.search.
    // Both providers use the same plugin-scoped configuration shape.
    const credentialEnv = WEB_SEARCH_PROVIDERS[webSearchProvider].credentialEnv;
    tools.web.search = { enabled: true, provider: webSearchProvider };
    config.plugins.entries[webSearchProvider] = {
      enabled: true,
      config: {
        webSearch: { apiKey: `openshell:resolve:env:${credentialEnv}` },
      },
    };
  }

  return config;
}

function boundedOpenClawMetadataText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/[\0\r\n]/u.test(value)
  );
}

function readExistingOpenClawConfig(configPath: string): JsonObject | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
}

function openClawContinuityMetadata(value: unknown): JsonObject | null {
  if (!isObject(value) || !boundedOpenClawMetadataText(value.lastTouchedVersion)) {
    return null;
  }
  return {
    lastTouchedVersion: value.lastTouchedVersion,
  };
}

function preserveExistingOpenClawState(config: JsonObject, configPath: string): void {
  const existing = readExistingOpenClawConfig(configPath);

  // OpenClaw 2026.7 rejects a regenerated config that drops the write
  // metadata carried by its last-known-good snapshot, then restores the old
  // config with `missing-meta-vs-last-good`. The final image-generation pass
  // can leave the active file without metadata while its exact OpenClaw-owned
  // `.bak` retains it, so prefer the active value and otherwise inspect only
  // that one fixed backup path. OpenClaw 2026.9.1 rejects the legacy
  // `lastTouchedAt` key, so carry forward only the bounded version field;
  // every NemoClaw-owned routing field still comes from the managed profile.
  const continuityMeta =
    openClawContinuityMetadata(existing?.meta) ??
    openClawContinuityMetadata(readExistingOpenClawConfig(`${configPath}.bak`)?.meta);
  if (continuityMeta) config.meta = continuityMeta;

  if (!existing) return;
  const existingPlugins = existing.plugins;
  if (!isObject(existingPlugins)) {
    return;
  }
  const currentPlugins = config.plugins;
  if (Array.isArray(existingPlugins.allow)) {
    currentPlugins.allow = unique([
      ...(Array.isArray(currentPlugins.allow) ? currentPlugins.allow : []),
      ...existingPlugins.allow.filter(
        (pluginId): pluginId is string => typeof pluginId === "string",
      ),
    ]);
  }
  const existingInstalls = existingPlugins.installs;
  if (!isObject(existingInstalls) || Object.keys(existingInstalls).length === 0) {
    return;
  }
  if (!isObject(currentPlugins.installs)) {
    currentPlugins.installs = {};
  }
  Object.assign(currentPlugins.installs, existingInstalls);
}

export function writeOpenClawConfig(): void {
  const config = buildConfig();
  const configPath = expandUser("~/.openclaw/openclaw.json");
  preserveExistingOpenClawState(config, configPath);
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
