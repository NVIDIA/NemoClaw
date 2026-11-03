// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import {
  hostedNativeProvider,
  HOSTED_NATIVE_PROVIDERS,
  nativeHostedAgentConfig,
} from "./inference/native-provider/agent-config.ts";
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
} from "./inference/native-nvidia/contract.ts";

export const HERMES_SWITCHYARD_ROUTING_SCHEMA_VERSION = 1 as const;
export const HERMES_SWITCHYARD_ROUTE_ID = "switchyard" as const;
export const HERMES_SWITCHYARD_ROUTING_ENV = "NEMOCLAW_HERMES_SWITCHYARD_ROUTING_B64" as const;
export const HERMES_RELAY_PLUGINS_ENV = "HERMES_NEMO_RELAY_PLUGINS_TOML" as const;
export const HERMES_RELAY_PLUGINS_FILE =
  "/usr/local/share/nemoclaw/hermes-relay-plugins.toml" as const;
export const HERMES_RELAY_PLUGIN_STATE_FILE =
  "/usr/local/share/nemoclaw/.dynamic-plugins.json" as const;
export const HERMES_SWITCHYARD_DEPLOYMENT_FILE =
  "/usr/local/share/nemoclaw/hermes-switchyard-v1.toml" as const;
export const HERMES_SWITCHYARD_PLUGIN_MANIFEST =
  "/opt/nemo-relay/plugins/switchyard/relay-plugin.toml" as const;
export const HERMES_RELAY_PLUGINS_STAGING_FILE = "hermes-relay-plugins.toml" as const;
export const HERMES_RELAY_PLUGIN_STATE_STAGING_FILE = "hermes-relay-plugin-state.json" as const;
export const HERMES_SWITCHYARD_DEPLOYMENT_STAGING_FILE = "hermes-switchyard-v1.toml" as const;

const MAX_MODEL_BYTES = 512;
const MAX_ROUTING_BYTES = 8 * 1024;
const STANDARD_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/u;
const CREDENTIAL_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SECRET_VALUE_PATTERNS = [
  /(?:nvapi|nvcf|sk-(?:proj-|ant-)?|ghp_|github_pat_|hf_|glpat-|gsk_|pypi-|tvly-)/u,
  /Bearer\s+/iu,
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u,
] as const;

type FixedHostedProvider = Exclude<
  (typeof HOSTED_NATIVE_PROVIDERS)[number]["logicalProvider"],
  "hermes-provider"
>;

export type HermesSwitchyardProvider = typeof NVIDIA_HOSTED_LOGICAL_PROVIDER | FixedHostedProvider;

const HOSTED_SWITCHYARD_PROVIDER_DEFINITIONS = HOSTED_NATIVE_PROVIDERS.filter(
  (definition) => definition.logicalProvider !== "hermes-provider",
);

/** Provider IDs come from the existing fixed hosted-profile registry. */
export const HERMES_SWITCHYARD_PROVIDERS: readonly HermesSwitchyardProvider[] = [
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  ...HOSTED_SWITCHYARD_PROVIDER_DEFINITIONS.map(
    (definition) => definition.logicalProvider as FixedHostedProvider,
  ),
];

export interface HermesSwitchyardTargetSelection {
  readonly provider: HermesSwitchyardProvider;
  readonly model: string;
}

export interface HermesSwitchyardRoutingIntent {
  readonly schemaVersion: typeof HERMES_SWITCHYARD_ROUTING_SCHEMA_VERSION;
  readonly routeId: typeof HERMES_SWITCHYARD_ROUTE_ID;
  readonly efficient: HermesSwitchyardTargetSelection;
  readonly capable: HermesSwitchyardTargetSelection;
  readonly judge: {
    readonly mode: "reuse-capable";
    readonly target: "capable";
  };
}

export interface SerializedHermesSwitchyardRouting {
  readonly relayPluginsToml: string;
  readonly relayPluginStateJson: string;
  readonly switchyardDeploymentToml: string;
}

export class HermesSwitchyardRoutingError extends Error {
  constructor(message: string) {
    super(`Invalid Hermes Switchyard routing: ${message}`);
    this.name = "HermesSwitchyardRoutingError";
  }
}

function fail(message: string): never {
  throw new HermesSwitchyardRoutingError(message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${where} contains unknown fields`);
}

function provider(value: unknown, where: string): HermesSwitchyardProvider {
  if (
    typeof value !== "string" ||
    !(HERMES_SWITCHYARD_PROVIDERS as readonly string[]).includes(value)
  ) {
    return fail(`${where} must name an approved fixed hosted provider profile`);
  }
  return value as HermesSwitchyardProvider;
}

function model(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_MODEL_BYTES ||
    !MODEL_PATTERN.test(value) ||
    value.includes("://") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("${") ||
    value.toLowerCase().includes("openshell:resolve") ||
    SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    return fail(`${where} must be a bounded provider model ID without credentials or endpoints`);
  }
  return value;
}

function target(value: unknown, where: string): HermesSwitchyardTargetSelection {
  const selection = record(value, where);
  rejectUnknownKeys(selection, new Set(["provider", "model"]), where);
  return {
    provider: provider(selection.provider, `${where}.provider`),
    model: model(selection.model, `${where}.model`),
  };
}

/** Validate and rebuild the canonical secret-free routing intent. */
export function validateHermesSwitchyardRoutingIntent(
  value: unknown,
): HermesSwitchyardRoutingIntent {
  const routing = record(value, "routing");
  rejectUnknownKeys(
    routing,
    new Set(["schemaVersion", "routeId", "efficient", "capable", "judge"]),
    "routing",
  );
  if (routing.schemaVersion !== HERMES_SWITCHYARD_ROUTING_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${String(HERMES_SWITCHYARD_ROUTING_SCHEMA_VERSION)}`);
  }
  if (routing.routeId !== HERMES_SWITCHYARD_ROUTE_ID) {
    fail(`routeId must be ${HERMES_SWITCHYARD_ROUTE_ID}`);
  }
  const efficient = target(routing.efficient, "routing.efficient");
  const capable = target(routing.capable, "routing.capable");
  if (efficient.model === capable.model) {
    fail("efficient and capable must select different model IDs");
  }
  const judge = record(routing.judge, "routing.judge");
  rejectUnknownKeys(judge, new Set(["mode", "target"]), "routing.judge");
  if (judge.mode !== "reuse-capable" || judge.target !== "capable") {
    fail("judge must explicitly reuse the capable target");
  }
  return {
    schemaVersion: HERMES_SWITCHYARD_ROUTING_SCHEMA_VERSION,
    routeId: HERMES_SWITCHYARD_ROUTE_ID,
    efficient,
    capable,
    judge: { mode: "reuse-capable", target: "capable" },
  };
}

export function createHermesSwitchyardRoutingIntent(input: {
  readonly efficient: unknown;
  readonly capable: unknown;
}): HermesSwitchyardRoutingIntent {
  return validateHermesSwitchyardRoutingIntent({
    schemaVersion: HERMES_SWITCHYARD_ROUTING_SCHEMA_VERSION,
    routeId: HERMES_SWITCHYARD_ROUTE_ID,
    efficient: input.efficient,
    capable: input.capable,
    judge: { mode: "reuse-capable", target: "capable" },
  });
}

export function encodeHermesSwitchyardRoutingIntent(value: HermesSwitchyardRoutingIntent): string {
  const routing = validateHermesSwitchyardRoutingIntent(value);
  return Buffer.from(JSON.stringify(routing), "utf8").toString("base64");
}

export function decodeHermesSwitchyardRoutingIntent(
  encoded: string,
): HermesSwitchyardRoutingIntent {
  if (
    encoded.length === 0 ||
    encoded.length > Math.ceil(MAX_ROUTING_BYTES / 3) * 4 ||
    !STANDARD_BASE64_RE.test(encoded)
  ) {
    return fail("encoded routing transport is invalid");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length > MAX_ROUTING_BYTES || decoded.toString("base64") !== encoded) {
    return fail("encoded routing transport is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return fail("encoded routing transport must contain JSON");
  }
  return validateHermesSwitchyardRoutingIntent(parsed);
}

export function readHermesSwitchyardRoutingEnvironment(
  env: NodeJS.ProcessEnv,
): HermesSwitchyardRoutingIntent | null {
  const encoded = env[HERMES_SWITCHYARD_ROUTING_ENV];
  return encoded === undefined || encoded === ""
    ? null
    : decodeHermesSwitchyardRoutingIntent(encoded);
}

type SwitchyardClientProfile = {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly format: "openai_chat" | "anthropic_messages";
  readonly extraHeaders: Readonly<Record<string, string>>;
};

function validateClientProfile(profile: SwitchyardClientProfile): SwitchyardClientProfile {
  let endpoint: URL;
  try {
    endpoint = new URL(profile.baseUrl);
  } catch {
    return fail("provider profile has an invalid endpoint");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.hostname === "inference.local" ||
    /[\\\s]/u.test(profile.baseUrl) ||
    !CREDENTIAL_ENV_PATTERN.test(profile.apiKeyEnv)
  ) {
    return fail("provider profile is not safe for Switchyard onboarding");
  }
  for (const [name, value] of Object.entries(profile.extraHeaders)) {
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      /[\r\n]/u.test(value) ||
      ["authorization", "proxy-authorization", "x-api-key"].includes(name.toLowerCase())
    ) {
      return fail("provider profile contains an unsafe Switchyard header");
    }
  }
  return profile;
}

function clientProfile(providerId: HermesSwitchyardProvider): SwitchyardClientProfile {
  if (providerId === NVIDIA_HOSTED_LOGICAL_PROVIDER) {
    return validateClientProfile({
      baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
      apiKeyEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
      format: "openai_chat",
      extraHeaders: {},
    });
  }
  const definition = hostedNativeProvider(providerId);
  if (!definition || definition.logicalProvider === "hermes-provider") {
    return fail("provider profile is not supported by Switchyard onboarding");
  }
  const agentConfig = nativeHostedAgentConfig(providerId, definition.endpoint);
  if (!agentConfig) return fail("provider profile has no managed credential binding");
  return validateClientProfile({
    baseUrl: definition.endpoint,
    apiKeyEnv: definition.credentialEnv,
    format: definition.api === "anthropic-messages" ? "anthropic_messages" : "openai_chat",
    extraHeaders: agentConfig.headers ?? {},
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringMap(value: Readonly<Record<string, string>>): string {
  const fields = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, headerValue]) => `${tomlString(name)} = ${tomlString(headerValue)}`);
  return `{ ${fields.join(", ")} }`;
}

function clientAndTargetToml(
  role: "efficient" | "capable",
  selection: HermesSwitchyardTargetSelection,
): string[] {
  const client = clientProfile(selection.provider);
  return [
    `[llm_clients.${role}]`,
    `format = ${tomlString(client.format)}`,
    `base_url = ${tomlString(client.baseUrl)}`,
    `api_key_env = ${tomlString(client.apiKeyEnv)}`,
    "forward_auth = false",
    ...(Object.keys(client.extraHeaders).length > 0
      ? [`extra_headers = ${tomlStringMap(client.extraHeaders)}`]
      : []),
    "",
    `[targets.${role}]`,
    `id = ${tomlString(selection.model)}`,
    `llm_client = ${tomlString(role)}`,
    "",
  ];
}

/** Serialize only the released Relay 0.8.x and Switchyard 0.3.0 contracts. */
export function serializeHermesSwitchyardRouting(
  value: HermesSwitchyardRoutingIntent,
): SerializedHermesSwitchyardRouting {
  const routing = validateHermesSwitchyardRoutingIntent(value);
  const relayPluginsToml = [
    "version = 1",
    "",
    "[[plugins.dynamic]]",
    `manifest = ${tomlString(HERMES_SWITCHYARD_PLUGIN_MANIFEST)}`,
    "",
    "[plugins.dynamic.config]",
    "priority = 0",
    `switchyard_config_path = ${tomlString(HERMES_SWITCHYARD_DEPLOYMENT_FILE)}`,
    "",
    '[plugins.policy.overrides."nvidia.switchyard"]',
    'attestation = "integrity_only"',
    "",
  ].join("\n");
  const switchyardDeploymentToml = [
    "schema_version = 1",
    "",
    ...clientAndTargetToml("efficient", routing.efficient),
    ...clientAndTargetToml("capable", routing.capable),
    `[routes.${routing.routeId}]`,
    `id = ${tomlString(routing.routeId)}`,
    'type = "llm_classifier"',
    'mode = "capability"',
    'classifier_target = "capable"',
    'strong_target = "capable"',
    'weak_target = "efficient"',
    "base_threshold = 0.5",
    'classify_trigger = "new_session"',
    "message_hash_fallback = true",
    "",
  ].join("\n");
  // Relay 0.8.x keeps dynamic-plugin enablement in the lifecycle sidecar
  // beside plugins.toml. The manifest deliberately defaults to disabled, so
  // registration alone cannot activate the route. Hermes 0.21.3 treats its
  // explicitly selected plugins.toml as activation consent and does not mutate
  // this immutable lifecycle record.
  const relayPluginStateJson = `${JSON.stringify(
    {
      schema_version: 1,
      records: [
        {
          metadata: {
            id: "nvidia.switchyard",
            kind: "rust_dynamic",
            generation: 1,
          },
          source: { manifest_ref: HERMES_SWITCHYARD_PLUGIN_MANIFEST },
          spec: { present: true, enabled: true },
          compatibility: {
            rust_dynamic: { relay: ">=0.8.0, <1.0.0", native_api: "1" },
          },
          load: {
            rust_dynamic: {
              library: "libswitchyard_nemo_relay_plugin.so",
              symbol: "nemo_relay_register_plugin",
            },
          },
          status: {},
        },
      ],
    },
    null,
    2,
  )}\n`;
  return { relayPluginsToml, relayPluginStateJson, switchyardDeploymentToml };
}
