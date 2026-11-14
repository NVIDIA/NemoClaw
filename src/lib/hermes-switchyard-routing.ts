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
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
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
  readonly judge:
    | { readonly mode: "reuse-capable"; readonly target: "capable" }
    | (HermesSwitchyardTargetSelection & {
        readonly mode: "dedicated";
        readonly target: "judge";
      });
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
  const requestedJudge = record(routing.judge, "routing.judge");
  let judge: HermesSwitchyardRoutingIntent["judge"];
  if (requestedJudge.mode === "dedicated") {
    rejectUnknownKeys(
      requestedJudge,
      new Set(["mode", "target", "provider", "model"]),
      "routing.judge",
    );
    if (requestedJudge.target !== "judge") fail("routing.judge.target must be judge");
    const selection = target(
      { provider: requestedJudge.provider, model: requestedJudge.model },
      "routing.judge",
    );
    if (selection.model === capable.model || selection.model === efficient.model)
      fail("routing.judge must select a dedicated model ID");
    judge = { mode: "dedicated", target: "judge", ...selection };
  } else {
    rejectUnknownKeys(requestedJudge, new Set(["mode", "target"]), "routing.judge");
    if (requestedJudge.mode !== "reuse-capable" || requestedJudge.target !== "capable")
      fail("routing.judge must reuse capable or select a dedicated judge");
    judge = { mode: "reuse-capable", target: "capable" };
  }
  return {
    schemaVersion: HERMES_SWITCHYARD_ROUTING_SCHEMA_VERSION,
    routeId: HERMES_SWITCHYARD_ROUTE_ID,
    efficient,
    capable,
    judge,
  };
}

export function createHermesSwitchyardRoutingIntent(input: {
  readonly efficient: unknown;
  readonly capable: unknown;
  readonly judge?: unknown;
}): HermesSwitchyardRoutingIntent {
  return validateHermesSwitchyardRoutingIntent({
    schemaVersion: HERMES_SWITCHYARD_ROUTING_SCHEMA_VERSION,
    routeId: HERMES_SWITCHYARD_ROUTE_ID,
    efficient: input.efficient,
    capable: input.capable,
    judge:
      input.judge === undefined
        ? { mode: "reuse-capable", target: "capable" }
        : { mode: "dedicated", target: "judge", ...target(input.judge, "routing.judge") },
  });
}

/** Preserve the judge's logical role when it shares a target's physical provider. */
export function switchyardJudgeSelection(
  routing: HermesSwitchyardRoutingIntent,
): HermesSwitchyardTargetSelection {
  return routing.judge.mode === "dedicated"
    ? { provider: routing.judge.provider, model: routing.judge.model }
    : routing.capable;
}

/** One native provider per fixed credential and endpoint boundary, not per model role. */
export function switchyardPhysicalProviders(
  routing: HermesSwitchyardRoutingIntent,
): readonly HermesSwitchyardProvider[] {
  return [
    ...new Set([
      routing.efficient.provider,
      routing.capable.provider,
      switchyardJudgeSelection(routing).provider,
    ]),
  ];
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

export function switchyardClientProfile(
  providerId: HermesSwitchyardProvider,
): SwitchyardClientProfile {
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
  role: "efficient" | "capable" | "judge",
  selection: HermesSwitchyardTargetSelection,
  bindings: SwitchyardProviderBindings,
): string[] {
  const client = switchyardClientProfile(selection.provider);
  const observed = bindings.providers.find((p) => p.providerId === bindings[role].providerId);
  if (!observed) return fail("a target has no observed provider binding");
  return [
    `[llm_clients.${role}]`,
    `format = ${tomlString(client.format)}`,
    `base_url = ${tomlString(observed.endpointUrl)}`,
    `api_key_env = ${tomlString(observed.credentialEnv)}`,
    "forward_auth = false",
    ...(Object.keys(client.extraHeaders).length > 0
      ? [`extra_headers = ${tomlStringMap(client.extraHeaders)}`]
      : []),
    "",
    `[targets.${role}]`,
    `id = ${tomlString(bindings[role].model)}`,
    `llm_client = ${tomlString(role)}`,
    "",
  ];
}

/** Serialize only the released Relay 0.8.x and Switchyard 0.3.0 contracts. */
export function serializeHermesSwitchyardRouting(
  value: HermesSwitchyardRoutingIntent,
  observedBindings?: SwitchyardProviderBindings,
): SerializedHermesSwitchyardRouting {
  const routing = validateHermesSwitchyardRoutingIntent(value);
  const bindings = validateSwitchyardProviderBindings(observedBindings, routing);
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
    ...clientAndTargetToml("efficient", routing.efficient, bindings),
    ...clientAndTargetToml("capable", routing.capable, bindings),
    ...(routing.judge.mode === "dedicated"
      ? clientAndTargetToml("judge", switchyardJudgeSelection(routing), bindings)
      : []),
    `[routes.${routing.routeId}]`,
    `id = ${tomlString(routing.routeId)}`,
    'type = "llm_classifier"',
    'mode = "capability"',
    `classifier_target = ${tomlString(routing.judge.target)}`,
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

export const HERMES_SWITCHYARD_BINDINGS_ENV = "NEMOCLAW_HERMES_SWITCHYARD_BINDINGS_B64";

export interface SwitchyardPhysicalProviderBinding {
  readonly logicalProvider: HermesSwitchyardProvider;
  readonly providerName: string;
  readonly providerId: string;
  readonly resourceVersion: number;
  readonly profileId: string;
  readonly profileSha256: string;
  readonly endpointUrl: string;
  readonly credentialEnv: string;
}

interface SwitchyardTargetBinding {
  readonly providerId: string;
  readonly model: string;
}

/** Public observations only. Credentials remain in OpenShell. */
export interface SwitchyardProviderBindings {
  readonly schemaVersion: 1;
  readonly providers: readonly SwitchyardPhysicalProviderBinding[];
  readonly efficient: SwitchyardTargetBinding;
  readonly capable: SwitchyardTargetBinding;
  readonly judge: SwitchyardTargetBinding & {
    readonly mode: HermesSwitchyardRoutingIntent["judge"]["mode"];
    readonly target: HermesSwitchyardRoutingIntent["judge"]["target"];
  };
}

export interface SwitchyardBindingState {
  readonly routing: HermesSwitchyardRoutingIntent;
  readonly bindings: SwitchyardProviderBindings;
}

export function validateSwitchyardBindingState(value: unknown): SwitchyardBindingState {
  const state = bindingRecord(value, ["routing", "bindings"]);
  const routing = validateHermesSwitchyardRoutingIntent(state.routing);
  return { routing, bindings: validateSwitchyardProviderBindings(state.bindings, routing) };
}

export class SwitchyardProviderBindingError extends Error {
  constructor(message: string) {
    super("Hermes Switchyard provider binding: " + message);
    this.name = "SwitchyardProviderBindingError";
  }
}

function failBinding(): never {
  throw new SwitchyardProviderBindingError("missing, invalid, or ambiguous provider state.");
}

function bindingRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failBinding();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    return failBinding();
  return result;
}

export function isSwitchyardProviderIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(value) &&
    !/(?:nvapi-|nvcf-|sk-|ghp_|github_pat_)/u.test(value)
  );
}

/** Validate persisted observations against the selected roles and approved fixed boundaries. */
export function validateSwitchyardProviderBindings(
  value: unknown,
  intent: HermesSwitchyardRoutingIntent,
): SwitchyardProviderBindings {
  const routing = validateHermesSwitchyardRoutingIntent(intent);
  const bindings = bindingRecord(value, [
    "schemaVersion",
    "providers",
    "efficient",
    "capable",
    "judge",
  ]);
  const logicalProviders = switchyardPhysicalProviders(routing);
  if (
    bindings.schemaVersion !== 1 ||
    !Array.isArray(bindings.providers) ||
    bindings.providers.length !== logicalProviders.length
  )
    return failBinding();
  const providers = bindings.providers.map(
    (input: unknown, index: number): SwitchyardPhysicalProviderBinding => {
      const entry = bindingRecord(input, [
        "logicalProvider",
        "providerName",
        "providerId",
        "resourceVersion",
        "profileId",
        "profileSha256",
        "endpointUrl",
        "credentialEnv",
      ]);
      const logicalProvider = logicalProviders[index];
      const definition = hostedNativeProvider(logicalProvider);
      const profileId =
        logicalProvider === "nvidia-prod" ? NVIDIA_HOSTED_NATIVE_PROFILE_ID : definition?.profileId;
      const endpointUrl =
        logicalProvider === "nvidia-prod" ? NVIDIA_HOSTED_NATIVE_ENDPOINT : definition?.endpoint;
      const credentialEnv =
        logicalProvider === "nvidia-prod"
          ? NVIDIA_HOSTED_CREDENTIAL_ENV
          : definition?.credentialEnv;
      if (
        !logicalProvider ||
        !profileId ||
        !endpointUrl ||
        !credentialEnv ||
        entry.logicalProvider !== logicalProvider ||
        entry.profileId !== profileId ||
        entry.endpointUrl !== endpointUrl ||
        entry.credentialEnv !== credentialEnv ||
        typeof entry.providerName !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(entry.providerName) ||
        !isSwitchyardProviderIdentity(entry.providerId) ||
        typeof entry.resourceVersion !== "number" ||
        !Number.isSafeInteger(entry.resourceVersion) ||
        entry.resourceVersion < 1 ||
        typeof entry.profileSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.profileSha256)
      )
        return failBinding();
      return {
        logicalProvider,
        providerName: entry.providerName,
        providerId: entry.providerId,
        resourceVersion: entry.resourceVersion,
        profileId,
        profileSha256: entry.profileSha256,
        endpointUrl,
        credentialEnv,
      };
    },
  );
  if (
    new Set(providers.map((p) => p.providerId)).size !== providers.length ||
    new Set(providers.map((p) => p.providerName)).size !== providers.length
  )
    return failBinding();
  const role = (key: "efficient" | "capable"): SwitchyardTargetBinding => {
    const selected = routing[key];
    const binding = providers.find((p) => p.logicalProvider === selected.provider);
    const entry = bindingRecord(bindings[key], ["providerId", "model"]);
    if (!binding || entry.providerId !== binding.providerId || entry.model !== selected.model)
      return failBinding();
    return { providerId: binding.providerId, model: selected.model };
  };
  const efficient = role("efficient");
  const capable = role("capable");
  const judge = bindingRecord(bindings.judge, ["providerId", "model", "mode", "target"]);
  const judgeSelection = switchyardJudgeSelection(routing);
  const judgeProvider = providers.find((p) => p.logicalProvider === judgeSelection.provider);
  if (
    !judgeProvider ||
    judge.mode !== routing.judge.mode ||
    judge.target !== routing.judge.target ||
    judge.providerId !== judgeProvider.providerId ||
    judge.model !== judgeSelection.model
  )
    return failBinding();
  return {
    schemaVersion: 1,
    providers,
    efficient,
    capable,
    judge: {
      providerId: judgeProvider.providerId,
      model: judgeSelection.model,
      mode: routing.judge.mode,
      target: routing.judge.target,
    },
  };
}

export function encodeSwitchyardProviderBindings(
  value: SwitchyardProviderBindings,
  routing: HermesSwitchyardRoutingIntent,
): string {
  return Buffer.from(
    JSON.stringify(validateSwitchyardProviderBindings(value, routing)),
    "utf8",
  ).toString("base64");
}

export function readSwitchyardProviderBindingsEnvironment(
  env: NodeJS.ProcessEnv,
  routing: HermesSwitchyardRoutingIntent,
): SwitchyardProviderBindings {
  const encoded = env[HERMES_SWITCHYARD_BINDINGS_ENV];
  if (!encoded || encoded.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
    return failBinding();
  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) return failBinding();
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return failBinding();
  }
  return validateSwitchyardProviderBindings(parsed, routing);
}

/** OpenShell injects workload references; root setup must not supply credential values or handles. */
export function assertSwitchyardRootApplyEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
  state: SwitchyardBindingState,
): void {
  const validated = validateSwitchyardBindingState(state);
  for (const provider of validated.bindings.providers) {
    if (env[provider.credentialEnv] !== undefined)
      throw new SwitchyardProviderBindingError(
        "managed startup must not supply provider credentials or credential placeholders.",
      );
  }
}
