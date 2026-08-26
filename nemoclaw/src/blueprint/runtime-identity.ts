// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import { isSubprocessEnvNameAllowed } from "../lib/subprocess-env.js";
import { isPlainObject } from "../shared/object-record.js";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,255}$/;
const CLIENT_ID_ENV_PATTERN = /(?:^|_)CLIENT_ID$/;
const SECRET_MATERIAL_ENV_PATTERN = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/;
const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const PROVIDER_FIELD_PATTERN = /^\s*(Name|Type|Credential keys|Config keys):\s*(.*?)\s*$/i;
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/gu;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const UNSAFE_CONTROL_PATTERN = /[\x00-\x08\x0A-\x1F\x7F-\x9F]/u;
const MISSING_RESOURCE_PATTERN = /\b(?:not found|does not exist|unknown provider)\b/i;
const MAX_PROVIDER_OUTPUT_BYTES = 16 * 1024;
const RUNTIME_IDENTITY_REFRESH_STATUSES = new Set([
  "configured",
  "error",
  "refreshed",
  "rotation_requested",
]);
const MAX_SETTINGS_OUTPUT_BYTES = 16 * 1024;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_PROFILE_ENDPOINTS = 32;
const MAX_DESTINATION_URL_LENGTH = 2048;
const PROVIDERS_V2_SETTING = "providers_v2_enabled";
const RUNTIME_IDENTITY_BINARIES = Object.freeze([
  "/usr/local/bin/node",
  "/usr/bin/node",
  "/usr/local/bin/curl",
  "/usr/bin/curl",
]);
const RUNTIME_IDENTITY_PROFILE_KEYS = Object.freeze([
  "id",
  "display_name",
  "description",
  "category",
  "credentials",
  "endpoints",
  "binaries",
  "inference_capable",
]);
const RUNTIME_IDENTITY_CREDENTIAL_KEYS = Object.freeze([
  "name",
  "description",
  "env_vars",
  "required",
  "auth_style",
  "header_name",
  "refresh",
]);
const RUNTIME_IDENTITY_REFRESH_KEYS = Object.freeze([
  "strategy",
  "token_url",
  "refresh_before_seconds",
  "max_lifetime_seconds",
  "material",
]);
const RUNTIME_IDENTITY_ENDPOINT_KEYS = Object.freeze([
  "host",
  "port",
  "protocol",
  "enforcement",
  "rules",
]);

export interface RuntimeIdentityConfig {
  profile_path: string;
  provider_type: string;
  provider_name: string;
  credential_key: string;
  client_id_env: string;
  refresh_token_env: string;
  client_secret_env?: string;
}

export interface RuntimeIdentityPlan {
  provider_type: string;
  provider_name: string;
  credential_key: string;
}

export interface RuntimeIdentityReceipt extends RuntimeIdentityPlan {
  provider_created: boolean;
  attachment_created: boolean;
}

export interface RuntimeIdentityCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeIdentityCommandOptions {
  env?: Record<string, string>;
}

export interface RuntimeIdentityCommandDeps {
  run(
    args: string[],
    options?: RuntimeIdentityCommandOptions,
  ): Promise<RuntimeIdentityCommandResult>;
  formatError(output: string, secretValues?: readonly string[]): string;
  blueprintPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeIdentityValidatedDestination {
  dnsResolved: boolean;
}

export interface RuntimeIdentityProfilePolicy {
  providerType: string;
  clientIdEnvironmentName: string;
  dnsResolution: "reject" | "identity-platform-controlled";
  tokenIssuer: {
    trustedHostnames: readonly string[];
    trustedHostSuffixes: readonly string[];
  };
  credentialDelivery: {
    method: "GET";
    path: string;
    trustedHostnames: readonly string[];
    trustedHostSuffixes: readonly string[];
  };
  trustedBinaries: readonly string[];
}

const RUNTIME_IDENTITY_PROFILE_POLICIES: Readonly<Record<string, RuntimeIdentityProfilePolicy>> =
  Object.freeze({
    "okta-runtime-v1": Object.freeze({
      providerType: "okta-runtime-v1",
      clientIdEnvironmentName: "OKTA_CLIENT_ID",
      dnsResolution: "identity-platform-controlled",
      tokenIssuer: Object.freeze({
        trustedHostnames: Object.freeze([]),
        trustedHostSuffixes: Object.freeze(["okta.com"]),
      }),
      credentialDelivery: Object.freeze({
        method: "GET",
        path: "/**",
        trustedHostnames: Object.freeze([]),
        trustedHostSuffixes: Object.freeze(["okta.com"]),
      }),
      trustedBinaries: RUNTIME_IDENTITY_BINARIES,
    }),
    "entra-runtime-v1": Object.freeze({
      providerType: "entra-runtime-v1",
      clientIdEnvironmentName: "ENTRA_CLIENT_ID",
      dnsResolution: "identity-platform-controlled",
      tokenIssuer: Object.freeze({
        trustedHostnames: Object.freeze(["login.microsoftonline.com"]),
        trustedHostSuffixes: Object.freeze([]),
      }),
      credentialDelivery: Object.freeze({
        method: "GET",
        path: "/v1.0/me",
        trustedHostnames: Object.freeze(["graph.microsoft.com"]),
        trustedHostSuffixes: Object.freeze([]),
      }),
      trustedBinaries: RUNTIME_IDENTITY_BINARIES,
    }),
  });

export interface RuntimeIdentityDeps extends RuntimeIdentityCommandDeps {
  validateEndpointUrl(url: string): Promise<RuntimeIdentityValidatedDestination>;
  persistReceipt(receipt: RuntimeIdentityReceipt): void;
  profilePolicy?: RuntimeIdentityProfilePolicy;
}

interface RuntimeIdentityProviderMetadata {
  name: string;
  type: string;
  credentialKeys: string[];
  configKeys: string[];
}

interface ParsedRuntimeIdentityProfile {
  document: Record<string, unknown>;
  destinations: string[];
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function requireBoundedProfileText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 1024 ||
    UNSAFE_CONTROL_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a non-empty string no longer than 1024 characters`);
  }
  return value;
}

function requireExactRefreshMaterial(
  value: unknown,
  label: string,
): Array<Record<string, unknown>> {
  const expected = [
    { name: "client_id", required: true },
    { name: "refresh_token", required: true, secret: true },
    { name: "client_secret", required: false, secret: true },
  ];
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    !value.every(
      (entry, index) =>
        isPlainObject(entry) &&
        hasOnlyKeys(entry, ["name", "required", "secret"]) &&
        isDeepStrictEqual(entry, expected[index]),
    )
  ) {
    throw new Error(
      `${label} must declare only client_id, secret refresh_token, and optional secret client_secret`,
    );
  }
  return expected;
}

function requireTrustedBinaries(
  value: unknown,
  policy: RuntimeIdentityProfilePolicy,
  label: string,
): string[] {
  const trusted = policy.trustedBinaries;
  if (
    !Array.isArray(value) ||
    value.length !== trusted.length ||
    !value.every((entry) => typeof entry === "string") ||
    new Set(value).size !== value.length ||
    !trusted.every((binary) => value.includes(binary))
  ) {
    throw new Error(
      `${label} must declare exactly the reviewed executable allowlist for '${policy.providerType}'`,
    );
  }
  return [...trusted];
}

function requireTrustedProfileHostname(
  hostname: string,
  trustedHostnamesInput: readonly string[],
  trustedHostSuffixesInput: readonly string[],
  providerType: string,
  label: string,
): void {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  const trustedHostnames = trustedHostnamesInput.map((candidate) =>
    candidate.toLowerCase().replace(/\.$/u, ""),
  );
  const trustedSuffixes = trustedHostSuffixesInput.map((candidate) =>
    candidate.toLowerCase().replace(/\.$/u, ""),
  );
  if (
    !trustedHostnames.includes(normalized) &&
    !trustedSuffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))
  ) {
    throw new Error(
      `${label} host '${hostname}' is outside the trusted destination policy for '${providerType}'`,
    );
  }
}

function requireHttpsDestination(
  value: string,
  trustedHostnames: readonly string[],
  trustedHostSuffixes: readonly string[],
  providerType: string,
  label: string,
): string {
  if (value.length === 0 || value.length > MAX_DESTINATION_URL_LENGTH) {
    throw new Error(`${label} must be a non-empty URL no longer than 2048 characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${label} must not include URL credentials`);
  }
  requireTrustedProfileHostname(
    parsed.hostname,
    trustedHostnames,
    trustedHostSuffixes,
    providerType,
    label,
  );
  return parsed.toString();
}

function parseRuntimeIdentityEndpoint(
  endpoint: unknown,
  index: number,
  policy: RuntimeIdentityProfilePolicy,
): { destination: string; document: Record<string, unknown> } {
  const label = `Runtime identity provider profile endpoint ${String(index + 1)}`;
  if (!isPlainObject(endpoint) || !hasOnlyKeys(endpoint, RUNTIME_IDENTITY_ENDPOINT_KEYS)) {
    throw new Error(`${label} must be a mapping`);
  }
  const { enforcement, host, port, protocol, rules } = endpoint;
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    host.length > 253 ||
    /[\/@?#\s]/u.test(host)
  ) {
    throw new Error(`${label} must declare a valid host`);
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error(`${label} must declare a valid port`);
  }
  const unbracketedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (unbracketedHost.includes("[") || unbracketedHost.includes("]")) {
    throw new Error(`${label} must declare a valid host`);
  }
  requireTrustedProfileHostname(
    unbracketedHost,
    policy.credentialDelivery.trustedHostnames,
    policy.credentialDelivery.trustedHostSuffixes,
    policy.providerType,
    `${label} credential delivery`,
  );
  if (
    protocol !== "rest" ||
    enforcement !== "enforce" ||
    !Array.isArray(rules) ||
    rules.length !== 1 ||
    !isPlainObject(rules[0]) ||
    !hasOnlyKeys(rules[0], ["allow"]) ||
    !isPlainObject(rules[0].allow) ||
    !hasOnlyKeys(rules[0].allow, ["method", "path"]) ||
    rules[0].allow.method !== policy.credentialDelivery.method ||
    rules[0].allow.path !== policy.credentialDelivery.path
  ) {
    throw new Error(
      `${label} must enforce the reviewed REST ${policy.credentialDelivery.method} ` +
        `${policy.credentialDelivery.path} credential-delivery policy`,
    );
  }
  const urlHost = unbracketedHost.includes(":") ? `[${unbracketedHost}]` : unbracketedHost;
  return {
    destination: requireHttpsDestination(
      `https://${urlHost}:${String(port)}/`,
      policy.credentialDelivery.trustedHostnames,
      policy.credentialDelivery.trustedHostSuffixes,
      policy.providerType,
      label,
    ),
    document: {
      host,
      port,
      protocol: "rest",
      enforcement: "enforce",
      rules: [
        {
          allow: {
            method: policy.credentialDelivery.method,
            path: policy.credentialDelivery.path,
          },
        },
      ],
    },
  };
}

function parseRuntimeIdentityProfile(
  content: string,
  config: RuntimeIdentityConfig,
  policy: RuntimeIdentityProfilePolicy,
  label: string,
): ParsedRuntimeIdentityProfile {
  if (Buffer.byteLength(content, "utf8") > MAX_PROFILE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_PROFILE_BYTES}-byte limit`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error(`${label} is not valid YAML`);
  }
  if (!isPlainObject(parsed) || parsed.id !== config.provider_type) {
    throw new Error(`${label} must declare id '${config.provider_type}'`);
  }
  if (!hasOnlyKeys(parsed, RUNTIME_IDENTITY_PROFILE_KEYS)) {
    throw new Error(`${label} contains unsupported top-level fields`);
  }
  const displayName = requireBoundedProfileText(parsed.display_name, `${label} display_name`);
  const description = requireBoundedProfileText(parsed.description, `${label} description`);
  if (parsed.category !== "agent" || parsed.inference_capable !== false) {
    throw new Error(`${label} must be a non-inference agent provider profile`);
  }
  const credentials = parsed.credentials;
  if (
    !Array.isArray(credentials) ||
    credentials.length !== 1 ||
    !isPlainObject(credentials[0]) ||
    !hasOnlyKeys(credentials[0], RUNTIME_IDENTITY_CREDENTIAL_KEYS) ||
    credentials[0].name !== config.credential_key
  ) {
    throw new Error(
      `${label} must declare exactly one credential named '${config.credential_key}'`,
    );
  }
  const credentialDescription = requireBoundedProfileText(
    credentials[0].description,
    `${label} credential description`,
  );
  if (
    !Array.isArray(credentials[0].env_vars) ||
    credentials[0].env_vars.length !== 1 ||
    credentials[0].env_vars[0] !== config.credential_key ||
    credentials[0].required !== true ||
    credentials[0].auth_style !== "bearer" ||
    credentials[0].header_name !== "authorization"
  ) {
    throw new Error(`${label} credential presentation policy is not supported`);
  }
  const refresh = credentials[0].refresh;
  if (
    !isPlainObject(refresh) ||
    !hasOnlyKeys(refresh, RUNTIME_IDENTITY_REFRESH_KEYS) ||
    refresh.strategy !== "oauth2_refresh_token" ||
    typeof refresh.token_url !== "string" ||
    !Number.isInteger(refresh.refresh_before_seconds) ||
    (refresh.refresh_before_seconds as number) < 60 ||
    (refresh.refresh_before_seconds as number) > 3600 ||
    !Number.isInteger(refresh.max_lifetime_seconds) ||
    (refresh.max_lifetime_seconds as number) <= (refresh.refresh_before_seconds as number) ||
    (refresh.max_lifetime_seconds as number) > 86400
  ) {
    throw new Error(`${label} must declare a refresh token_url`);
  }
  const material = requireExactRefreshMaterial(refresh.material, `${label} refresh material`);
  const tokenUrl = requireHttpsDestination(
    refresh.token_url,
    policy.tokenIssuer.trustedHostnames,
    policy.tokenIssuer.trustedHostSuffixes,
    policy.providerType,
    `${label} refresh token_url`,
  );
  const endpoints = parsed.endpoints;
  if (
    !Array.isArray(endpoints) ||
    endpoints.length === 0 ||
    endpoints.length > MAX_PROFILE_ENDPOINTS
  ) {
    throw new Error(
      `${label} must declare between 1 and ${String(MAX_PROFILE_ENDPOINTS)} endpoints`,
    );
  }
  const parsedEndpoints = endpoints.map((endpoint, index) =>
    parseRuntimeIdentityEndpoint(endpoint, index, policy),
  );
  const binaries = requireTrustedBinaries(parsed.binaries, policy, `${label} binaries`);
  return {
    document: {
      id: config.provider_type,
      display_name: displayName,
      description,
      category: "agent",
      credentials: [
        {
          name: config.credential_key,
          description: credentialDescription,
          env_vars: [config.credential_key],
          required: true,
          auth_style: "bearer",
          header_name: "authorization",
          refresh: {
            strategy: "oauth2_refresh_token",
            token_url: tokenUrl,
            refresh_before_seconds: refresh.refresh_before_seconds,
            max_lifetime_seconds: refresh.max_lifetime_seconds,
            material,
          },
        },
      ],
      endpoints: parsedEndpoints.map(({ document }) => document),
      binaries,
      inference_capable: false,
    },
    destinations: [tokenUrl, ...parsedEndpoints.map(({ destination }) => destination)],
  };
}

async function validateProfileDestinations(
  profile: ParsedRuntimeIdentityProfile,
  policy: RuntimeIdentityProfilePolicy,
  deps: RuntimeIdentityDeps,
): Promise<void> {
  for (const destination of profile.destinations) {
    const validated = await deps.validateEndpointUrl(destination);
    if (validated.dnsResolved && policy.dnsResolution !== "identity-platform-controlled") {
      throw new Error(
        `DNS-backed runtime identity destination '${destination}' is outside the reviewed ` +
          `DNS policy for '${policy.providerType}'`,
      );
    }
  }
}

function isValidProviderKey(value: string): boolean {
  return ENV_NAME_PATTERN.test(value);
}

function parseProviderKeys(value: string): string[] | null {
  if (value === "<none>") return [];
  const keys = value.split(",").map((key) => key.trim());
  return keys.length > 0 &&
    keys.length <= 32 &&
    keys.every((key) => key.length <= 128 && isValidProviderKey(key)) &&
    new Set(keys).size === keys.length
    ? keys
    : null;
}

export function parseRuntimeIdentityProviderMetadata(
  output: string,
): RuntimeIdentityProviderMetadata | null {
  if (Buffer.byteLength(output, "utf8") > MAX_PROVIDER_OUTPUT_BYTES) return null;

  const fields = new Map<string, string>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(ANSI_OSC_PATTERN, "").replace(ANSI_CSI_PATTERN, "");
    const match = line.match(PROVIDER_FIELD_PATTERN);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (fields.has(field) || UNSAFE_CONTROL_PATTERN.test(value)) return null;
    fields.set(field, value);
  }

  const name = fields.get("name");
  const type = fields.get("type");
  const credentialKeysValue = fields.get("credential keys");
  const configKeysValue = fields.get("config keys");
  if (
    name === undefined ||
    type === undefined ||
    credentialKeysValue === undefined ||
    configKeysValue === undefined ||
    !PROVIDER_NAME_PATTERN.test(name) ||
    !PROVIDER_TYPE_PATTERN.test(type)
  ) {
    return null;
  }

  const credentialKeys = parseProviderKeys(credentialKeysValue);
  const configKeys = parseProviderKeys(configKeysValue);
  return credentialKeys && configKeys ? { name, type, credentialKeys, configKeys } : null;
}

export function isRuntimeIdentityConfig(value: unknown): value is RuntimeIdentityConfig {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      "profile_path",
      "provider_type",
      "provider_name",
      "credential_key",
      "client_id_env",
      "refresh_token_env",
      "client_secret_env",
    ])
  ) {
    return false;
  }
  const credentialEnvironmentNames = [
    value.client_id_env,
    value.refresh_token_env,
    value.client_secret_env,
  ].filter((name): name is string => typeof name === "string");
  return (
    typeof value.profile_path === "string" &&
    value.profile_path.trim().length > 0 &&
    typeof value.provider_type === "string" &&
    PROVIDER_TYPE_PATTERN.test(value.provider_type) &&
    typeof value.provider_name === "string" &&
    PROVIDER_NAME_PATTERN.test(value.provider_name) &&
    typeof value.credential_key === "string" &&
    ENV_NAME_PATTERN.test(value.credential_key) &&
    typeof value.client_id_env === "string" &&
    ENV_NAME_PATTERN.test(value.client_id_env) &&
    CLIENT_ID_ENV_PATTERN.test(value.client_id_env) &&
    typeof value.refresh_token_env === "string" &&
    ENV_NAME_PATTERN.test(value.refresh_token_env) &&
    SECRET_MATERIAL_ENV_PATTERN.test(value.refresh_token_env) &&
    (value.client_secret_env === undefined ||
      (typeof value.client_secret_env === "string" &&
        ENV_NAME_PATTERN.test(value.client_secret_env) &&
        SECRET_MATERIAL_ENV_PATTERN.test(value.client_secret_env))) &&
    new Set(credentialEnvironmentNames).size === credentialEnvironmentNames.length &&
    credentialEnvironmentNames.every((name) => !isSubprocessEnvNameAllowed(name))
  );
}

export function isRuntimeIdentityReceipt(value: unknown): value is RuntimeIdentityReceipt {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, [
      "provider_type",
      "provider_name",
      "credential_key",
      "provider_created",
      "attachment_created",
    ]) &&
    typeof value.provider_type === "string" &&
    PROVIDER_TYPE_PATTERN.test(value.provider_type) &&
    typeof value.provider_name === "string" &&
    PROVIDER_NAME_PATTERN.test(value.provider_name) &&
    typeof value.credential_key === "string" &&
    ENV_NAME_PATTERN.test(value.credential_key) &&
    typeof value.provider_created === "boolean" &&
    typeof value.attachment_created === "boolean"
  );
}

export function buildRuntimeIdentityPlan(config: RuntimeIdentityConfig): RuntimeIdentityPlan {
  return {
    provider_type: config.provider_type,
    provider_name: config.provider_name,
    credential_key: config.credential_key,
  };
}

function commandOutput(result: RuntimeIdentityCommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function isMissingResource(result: RuntimeIdentityCommandResult): boolean {
  return result.exitCode !== 0 && MISSING_RESOURCE_PATTERN.test(commandOutput(result));
}

function requiredEnvironmentValue(
  config: RuntimeIdentityConfig,
  name: string,
  env: NodeJS.ProcessEnv,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Runtime identity provider '${config.provider_name}' requires local environment variable '${name}' to be set`,
    );
  }
  return value;
}

async function requireProviderDerivedPolicy(deps: RuntimeIdentityCommandDeps): Promise<void> {
  const result = await deps.run(["openshell", "settings", "get", "--global", "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to inspect OpenShell provider-policy prerequisite: ${deps.formatError(commandOutput(result))}`,
    );
  }

  let enabled = false;
  if (Buffer.byteLength(result.stdout, "utf8") <= MAX_SETTINGS_OUTPUT_BYTES) {
    try {
      const document: unknown = JSON.parse(result.stdout);
      enabled =
        isPlainObject(document) &&
        isPlainObject(document.settings) &&
        document.settings[PROVIDERS_V2_SETTING] === "true";
    } catch {
      enabled = false;
    }
  }
  if (!enabled) {
    throw new Error(
      "Runtime identity requires OpenShell global setting 'providers_v2_enabled=true' " +
        "so the attached provider's enforced network policy and credential injection are active",
    );
  }
}

export function resolveRuntimeIdentityProfilePath(
  profilePath: string,
  blueprintPath: string,
): string {
  if (isAbsolute(profilePath)) {
    throw new Error("identity profile_path must be relative to the blueprint directory");
  }

  let blueprintRoot: string;
  let resolvedProfile: string;
  try {
    blueprintRoot = realpathSync(blueprintPath);
    resolvedProfile = realpathSync(resolve(blueprintRoot, profilePath));
  } catch {
    throw new Error(`identity profile_path '${profilePath}' must name an existing file`);
  }

  const relativeProfile = relative(blueprintRoot, resolvedProfile);
  if (
    relativeProfile === "" ||
    relativeProfile === ".." ||
    relativeProfile.startsWith(`..${sep}`) ||
    isAbsolute(relativeProfile)
  ) {
    throw new Error("identity profile_path must stay inside the blueprint directory");
  }
  if (!statSync(resolvedProfile).isFile()) {
    throw new Error(`identity profile_path '${profilePath}' must name a regular file`);
  }
  return resolvedProfile;
}

function assertMatchingProvider(
  result: RuntimeIdentityCommandResult,
  expected: RuntimeIdentityPlan,
  deps: RuntimeIdentityCommandDeps,
  allowConfiguredRefresh = false,
): "configured" | "minted" {
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to inspect runtime identity provider '${expected.provider_name}': ${deps.formatError(commandOutput(result))}`,
    );
  }
  const metadata = parseRuntimeIdentityProviderMetadata(commandOutput(result));
  if (
    !metadata ||
    metadata.name !== expected.provider_name ||
    metadata.type !== expected.provider_type ||
    metadata.configKeys.length !== 0
  ) {
    throw new Error(
      `Runtime identity provider '${expected.provider_name}' exists with an incompatible non-secret binding`,
    );
  }
  if (
    metadata.credentialKeys.length === 1 &&
    metadata.credentialKeys[0] === expected.credential_key
  ) {
    return "minted";
  }
  if (allowConfiguredRefresh && metadata.credentialKeys.length === 0) return "configured";
  throw new Error(
    `Runtime identity provider '${expected.provider_name}' exists with an incompatible non-secret binding`,
  );
}

function hasConfiguredRuntimeIdentityRefresh(
  output: string,
  expected: RuntimeIdentityPlan,
): boolean {
  if (Buffer.byteLength(output, "utf8") > MAX_PROVIDER_OUTPUT_BYTES) return false;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(ANSI_OSC_PATTERN, "").replace(ANSI_CSI_PATTERN, "");
    if (UNSAFE_CONTROL_PATTERN.test(line)) return false;
    const fields = line.trim().split(/\s{2,}/u);
    if (
      fields[0] === expected.provider_name &&
      fields[1] === expected.credential_key &&
      RUNTIME_IDENTITY_REFRESH_STATUSES.has(fields[3] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

async function requireConfiguredRuntimeIdentityRefresh(
  expected: RuntimeIdentityPlan,
  deps: RuntimeIdentityCommandDeps,
): Promise<void> {
  const result = await deps.run([
    "openshell",
    "provider",
    "refresh",
    "status",
    expected.provider_name,
    "--credential-key",
    expected.credential_key,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to inspect runtime identity refresh binding for '${expected.provider_name}': ${deps.formatError(commandOutput(result))}`,
    );
  }
  if (!hasConfiguredRuntimeIdentityRefresh(result.stdout, expected)) {
    throw new Error(
      `Runtime identity provider '${expected.provider_name}' exists with an incompatible non-secret refresh binding`,
    );
  }
}

async function inspectProvider(
  expected: RuntimeIdentityPlan,
  deps: RuntimeIdentityCommandDeps,
  allowConfiguredRefresh = false,
): Promise<"absent" | "matching"> {
  const result = await deps.run(["openshell", "provider", "get", expected.provider_name]);
  if (isMissingResource(result)) return "absent";
  const credentialState = assertMatchingProvider(result, expected, deps, allowConfiguredRefresh);
  if (credentialState === "configured") {
    await requireConfiguredRuntimeIdentityRefresh(expected, deps);
  }
  return "matching";
}

async function deleteCreatedProvider(
  receipt: RuntimeIdentityReceipt,
  deps: RuntimeIdentityCommandDeps,
): Promise<void> {
  const providerState = await inspectProvider(receipt, deps, true);
  if (providerState === "absent") return;
  const result = await deps.run(["openshell", "provider", "delete", receipt.provider_name]);
  if (result.exitCode !== 0 && !isMissingResource(result)) {
    throw new Error(
      `Failed to delete runtime identity provider '${receipt.provider_name}': ${deps.formatError(commandOutput(result))}`,
    );
  }
}

async function compensatePreparationFailure(
  receipt: RuntimeIdentityReceipt,
  error: unknown,
  deps: RuntimeIdentityCommandDeps,
): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await deleteCreatedProvider(receipt, deps);
  } catch (cleanupError) {
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`${message}; cleanup failed: ${cleanupMessage}`);
  }
  throw error;
}

async function importValidatedProfile(
  profileSource: string,
  deps: RuntimeIdentityCommandDeps,
): Promise<RuntimeIdentityCommandResult> {
  const snapshotDir = mkdtempSync(join(tmpdir(), "nemoclaw-runtime-identity-profile-"));
  const snapshotPath = join(snapshotDir, "profile.yaml");
  try {
    chmodSync(snapshotDir, 0o700);
    writeFileSync(snapshotPath, profileSource, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return await deps.run(["openshell", "provider", "profile", "import", "--file", snapshotPath]);
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

export async function prepareRuntimeIdentity(
  config: RuntimeIdentityConfig,
  deps: RuntimeIdentityDeps,
): Promise<RuntimeIdentityReceipt> {
  if (!isRuntimeIdentityConfig(config)) {
    throw new Error("Runtime identity configuration is invalid");
  }
  const env = deps.env ?? process.env;
  const profilePolicy =
    deps.profilePolicy ?? RUNTIME_IDENTITY_PROFILE_POLICIES[config.provider_type];
  if (!profilePolicy || profilePolicy.providerType !== config.provider_type) {
    throw new Error(
      `Runtime identity provider type '${config.provider_type}' has no reviewed trust policy`,
    );
  }
  if (config.client_id_env !== profilePolicy.clientIdEnvironmentName) {
    throw new Error(
      `Runtime identity client_id_env for '${config.provider_type}' must be the reviewed ` +
        `non-secret name '${profilePolicy.clientIdEnvironmentName}'`,
    );
  }
  const profilePath = resolveRuntimeIdentityProfilePath(
    config.profile_path,
    deps.blueprintPath ?? process.env.NEMOCLAW_BLUEPRINT_PATH ?? ".",
  );
  const profileSource = readFileSync(profilePath, "utf8");
  const requestedProfile = parseRuntimeIdentityProfile(
    profileSource,
    config,
    profilePolicy,
    "Runtime identity provider profile",
  );
  await validateProfileDestinations(requestedProfile, profilePolicy, deps);
  const clientId = requiredEnvironmentValue(config, config.client_id_env, env);
  const refreshToken = requiredEnvironmentValue(config, config.refresh_token_env, env);
  const clientSecret = config.client_secret_env
    ? requiredEnvironmentValue(config, config.client_secret_env, env)
    : undefined;
  await requireProviderDerivedPolicy(deps);
  const plan = buildRuntimeIdentityPlan(config);
  const providerState = await inspectProvider(plan, deps);
  if (providerState === "matching") {
    throw new Error(
      `Runtime identity provider '${config.provider_name}' already exists and cannot be safely ` +
        "reused because its prior refresh configuration cannot be restored",
    );
  }

  const profileImport = await importValidatedProfile(profileSource, deps);
  if (profileImport.exitCode !== 0) {
    if (!/already exists/i.test(commandOutput(profileImport))) {
      throw new Error(
        `Failed to import runtime identity provider profile: ${deps.formatError(commandOutput(profileImport))}`,
      );
    }
    const profileExport = await deps.run([
      "openshell",
      "provider",
      "profile",
      "export",
      config.provider_type,
      "--output",
      "yaml",
    ]);
    if (profileExport.exitCode !== 0) {
      throw new Error(
        `Failed to inspect existing runtime identity provider profile: ${deps.formatError(commandOutput(profileExport))}`,
      );
    }
    let existingProfile: ParsedRuntimeIdentityProfile;
    try {
      existingProfile = parseRuntimeIdentityProfile(
        profileExport.stdout,
        config,
        profilePolicy,
        "Existing runtime identity provider profile",
      );
    } catch {
      throw new Error(
        `Runtime identity provider profile '${config.provider_type}' exists with an incompatible binding`,
      );
    }
    if (!isDeepStrictEqual(existingProfile.document, requestedProfile.document)) {
      throw new Error(
        `Runtime identity provider profile '${config.provider_type}' exists with an incompatible binding`,
      );
    }
  }

  const receipt: RuntimeIdentityReceipt = {
    ...plan,
    provider_created: true,
    attachment_created: false,
  };
  let providerAcquired = false;
  try {
    const providerCreate = await deps.run([
      "openshell",
      "provider",
      "create",
      "--name",
      config.provider_name,
      "--type",
      config.provider_type,
      "--runtime-credentials",
    ]);
    if (providerCreate.exitCode !== 0) {
      throw new Error(
        `Failed to create runtime identity provider '${config.provider_name}': ${deps.formatError(commandOutput(providerCreate))}`,
      );
    }
    deps.persistReceipt(receipt);
    // Cleanup authority begins only after the ownership receipt is durable. If
    // persistence fails, preserve the provider instead of deleting a resource
    // that the next process cannot prove this run created.
    providerAcquired = true;

    const refreshArgs = [
      "openshell",
      "provider",
      "refresh",
      "configure",
      config.provider_name,
      "--credential-key",
      config.credential_key,
      "--strategy",
      "oauth2-refresh-token",
      "--material",
      `client_id=${clientId}`,
      "--secret-material-env",
      `refresh_token=${config.refresh_token_env}`,
    ];
    const refreshEnv: Record<string, string> = {
      [config.refresh_token_env]: refreshToken,
    };
    if (config.client_secret_env && clientSecret) {
      refreshArgs.push("--secret-material-env", `client_secret=${config.client_secret_env}`);
      refreshEnv[config.client_secret_env] = clientSecret;
    }
    const refreshResult = await deps.run(refreshArgs, { env: refreshEnv });
    if (refreshResult.exitCode !== 0) {
      throw new Error(
        `Failed to configure runtime identity credential refresh: ${deps.formatError(commandOutput(refreshResult), [clientId, refreshToken, clientSecret ?? ""])}`,
      );
    }
  } catch (error) {
    if (providerAcquired) {
      return compensatePreparationFailure(receipt, error, deps);
    }
    throw error;
  }

  return receipt;
}

export async function mintRuntimeIdentityCredential(
  receipt: RuntimeIdentityReceipt,
  deps: RuntimeIdentityCommandDeps,
): Promise<void> {
  const rotate = await deps.run([
    "openshell",
    "provider",
    "refresh",
    "rotate",
    receipt.provider_name,
    "--credential-key",
    receipt.credential_key,
  ]);
  if (rotate.exitCode !== 0) {
    throw new Error(
      `Failed to mint runtime identity credential: ${deps.formatError(commandOutput(rotate))}`,
    );
  }
}

export async function attachRuntimeIdentity(
  receipt: RuntimeIdentityReceipt,
  sandboxName: string,
  deps: RuntimeIdentityCommandDeps,
): Promise<boolean> {
  await requireProviderDerivedPolicy(deps);
  const state = await inspectProvider(receipt, deps, true);
  if (state === "absent") {
    throw new Error(
      `Runtime identity provider '${receipt.provider_name}' disappeared before attach`,
    );
  }
  const attach = await deps.run([
    "openshell",
    "sandbox",
    "provider",
    "attach",
    sandboxName,
    receipt.provider_name,
  ]);
  if (attach.exitCode === 0) return true;
  if (/already attached/i.test(commandOutput(attach))) return false;
  throw new Error(
    `Failed to attach runtime identity provider '${receipt.provider_name}': ${deps.formatError(commandOutput(attach))}`,
  );
}

async function detachRuntimeIdentity(
  receipt: RuntimeIdentityReceipt,
  sandboxName: string,
  deps: RuntimeIdentityCommandDeps,
): Promise<void> {
  const providerState = await inspectProvider(receipt, deps, true);
  if (providerState === "absent") return;
  const detach = await deps.run([
    "openshell",
    "sandbox",
    "provider",
    "detach",
    sandboxName,
    receipt.provider_name,
  ]);
  if (
    detach.exitCode !== 0 &&
    !isMissingResource(detach) &&
    !/not attached/i.test(commandOutput(detach))
  ) {
    throw new Error(
      `Failed to detach runtime identity provider '${receipt.provider_name}': ${deps.formatError(commandOutput(detach))}`,
    );
  }
}

export async function compensateRuntimeIdentityApply(
  receipt: RuntimeIdentityReceipt,
  sandboxName: string,
  deps: RuntimeIdentityCommandDeps,
): Promise<void> {
  await removeRuntimeIdentity(receipt, sandboxName, deps);
}

export async function removeRuntimeIdentity(
  receipt: RuntimeIdentityReceipt,
  sandboxName: string,
  deps: RuntimeIdentityCommandDeps,
): Promise<void> {
  if (receipt.attachment_created) {
    await detachRuntimeIdentity(receipt, sandboxName, deps);
  }
  if (receipt.provider_created) {
    await deleteCreatedProvider(receipt, deps);
  }
}
