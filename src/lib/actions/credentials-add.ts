// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
} from "../adapters/openshell/provider-adapter";
import type { OpenShellGatewayTarget } from "../adapters/openshell/sandbox-observer";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { CLI_NAME } from "../cli/branding";
import {
  isBridgeProviderName,
  recoverCredentialGatewayTargetOrExit,
} from "../credentials/command-support";
import { gatewayStartGuidance } from "../gateway-start-guidance";
import { SECRET_PATTERNS } from "../security/secret-patterns";
import { assertEndpointResolvesPublic } from "../security/trusted-private-endpoint";
import { withMcpCredentialOwnershipLock } from "../state/mcp-lifecycle-lock/credential-ownership";
import { ROOT } from "../state/paths";
import {
  forgetExtraProvider,
  listManagedMcpCredentialReservations,
  recordExtraProvider,
} from "./global";

export type CredentialsAddInput = {
  provider: string;
  type: string;
  credentials: readonly string[];
  configPairs: readonly string[];
  fromExisting: boolean;
};

export type CredentialsAddResult = {
  exitCode: number;
  successLines: readonly string[];
  failureLines: readonly string[];
};

export type CredentialsAddDeps = Readonly<{
  providerAdapter?: OpenShellProviderAdapter;
}>;

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,255}$/;
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CONFIG_KEY_DENYLIST =
  /(?:^|_)(?:key|token|secret|password|credential|authorization|bearer|api[_-]?key)(?:_|$)/i;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/i;
const PROVIDER_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/i;
const MAX_CONFIG_ENTRY_LENGTH = 4096;
const MAX_PROVIDER_BASE_URL_LENGTH = 2048;

function ok(successLines: readonly string[]): CredentialsAddResult {
  return { exitCode: 0, successLines, failureLines: [] };
}

function fail(failureLines: readonly string[], exitCode = 1): CredentialsAddResult {
  return { exitCode, successLines: [], failureLines };
}

function managedMcpCollisionFailure(
  provider: string,
  credentialKeys: readonly string[],
  reservations: ReturnType<typeof listManagedMcpCredentialReservations>,
): CredentialsAddResult | null {
  for (const credential of credentialKeys) {
    const collision = reservations.find((reservation) =>
      reservation.credentialKeys.includes(credential),
    );
    if (collision) {
      return fail([
        `  Credential key '${credential}' is reserved by managed MCP server '${collision.server}' on sandbox '${collision.sandboxName}'.`,
        `  Refusing to register provider '${provider}' because registered providers attach during sandbox rebuild.`,
        "  Use a different credential key, or remove the managed MCP server before retrying.",
      ]);
    }
  }
  return null;
}

function typedProviderConfigFailure(type: string, key: string, value: string): string[] | null {
  if (type.toLowerCase() !== "openai" || key !== "OPENAI_BASE_URL") {
    return [
      `  --config '${key}' is not a supported non-secret setting for provider type '${type}'.`,
      "  Supported: --type openai with --config OPENAI_BASE_URL=<http(s)://public-IP/path>.",
      "  Use --from-existing for provider configuration already stored by OpenShell.",
    ];
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch {
    return [
      "  --config 'OPENAI_BASE_URL' must be an absolute HTTP(S) URL without credentials, query parameters, or a fragment.",
    ];
  }
  if (
    value !== value.trim() ||
    value.length > MAX_PROVIDER_BASE_URL_LENGTH ||
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    return [
      "  --config 'OPENAI_BASE_URL' must be an absolute HTTP(S) URL without credentials, query parameters, or a fragment.",
    ];
  }
  return null;
}

async function providerConfigEndpointFailure(
  config: readonly { key: string; value: string }[],
): Promise<string[] | null> {
  const baseUrl = config.find((entry) => entry.key === "OPENAI_BASE_URL")?.value;
  if (!baseUrl) return null;

  const hostname = new URL(baseUrl).hostname;
  const bareHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bareHostname) === 0) {
    return [
      "  --config 'OPENAI_BASE_URL' accepts only a public IP-literal URL.",
      "  DNS hostnames are not supported because OpenShell cannot enforce admission-time address pins for this credential-bearing path.",
      `  Configure a hostname-based endpoint through '${CLI_NAME} onboard' so NemoClaw can preserve its address pins.`,
    ];
  }

  const preflight = await assertEndpointResolvesPublic(baseUrl);
  if (preflight.ok) return null;

  return [
    "  --config 'OPENAI_BASE_URL' failed endpoint security validation.",
    `  ${preflight.reason ?? "The endpoint is not safe to use."}`,
    `  Use a routable public endpoint, or configure a trusted private inference endpoint through '${CLI_NAME} onboard' so NemoClaw can preserve its trust and address pins.`,
  ];
}

function bundledProviderProfile(type: string): { profileType: string; profilePath: string } | null {
  const profileType = type.toLowerCase();
  const profilePath = path.join(
    ROOT,
    "nemoclaw-blueprint",
    "provider-profiles",
    `${profileType}.yaml`,
  );
  return fs.existsSync(profilePath) ? { profileType, profilePath } : null;
}

function bundledProviderProfileRecoveryLines(error: OpenShellProviderError): string[] {
  switch (error.kind) {
    case "authentication":
      return ["  Restore OpenShell authentication for the selected gateway, then retry."];
    case "timeout":
      return ["  Confirm the selected OpenShell gateway is available, then retry."];
    case "schema":
      return ["  Update OpenShell with scripts/install-openshell.sh, then retry."];
    case "validation":
      return ["  Restore the bundled provider profile from this NemoClaw release, then retry."];
    case "transport":
      switch (error.reason) {
        case "unreachable":
          return [`  ${gatewayStartGuidance()}`, "  Then retry this command."];
        case "identity_mismatch":
          return [
            "  Re-select the intended OpenShell gateway and restore its recorded identity, then retry.",
          ];
        case "process_start":
          return ["  Repair OpenShell with scripts/install-openshell.sh, then retry."];
      }
    case "command":
      return ["  Fix the reported OpenShell provider-profile error, then retry."];
  }
}

async function ensureBundledProviderProfile(
  profile: { profileType: string; profilePath: string } | null,
  target: OpenShellGatewayTarget,
  providerAdapter: OpenShellProviderAdapter,
): Promise<CredentialsAddResult | null> {
  if (!profile) return null;

  const result = await providerAdapter.importProviderProfile({
    target,
    profilePath: profile.profilePath,
    timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (result.ok) return null;
  if (result.error.kind === "command" && result.error.reason === "profile_incompatible") {
    return fail([
      `  OpenShell provider profile '${profile.profileType}' does not match NemoClaw's checked-in credential boundary.`,
      "  Remove the conflicting provider profile, then retry this command.",
      `  ${result.error.message}`,
    ]);
  }
  return fail([
    `  Could not import bundled provider profile '${profile.profileType}'.`,
    ...bundledProviderProfileRecoveryLines(result.error),
    `  ${result.error.message}`,
  ]);
}

function isUncertainProviderCreateError(error: OpenShellProviderError): boolean {
  return (
    error.kind === "timeout" ||
    (error.kind === "transport" && error.reason === "unreachable") ||
    (error.kind === "command" && error.reason === "uncertain")
  );
}

async function reconcileUncertainProviderCreate(
  provider: string,
  target: OpenShellGatewayTarget,
  providerAdapter: OpenShellProviderAdapter,
): Promise<{ keepReservation: boolean; lines: string[] }> {
  const inventory = await providerAdapter.listProviders({
    target,
    timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (inventory.ok && inventory.value.names.includes(provider)) {
    return {
      keepReservation: false,
      lines: [
        `  OpenShell reports a provider named '${provider}', but a name-only inventory cannot verify that this command created it.`,
        "  Local provider ownership was not recorded.",
        "  Do not rebuild a sandbox from this result. Resolve the provider through a verified gateway operation, then retry.",
      ],
    };
  }
  if (inventory.ok) {
    return {
      keepReservation: false,
      lines: [
        `  OpenShell confirms provider '${provider}' is absent.`,
        "  It is safe to retry the credentials add command.",
      ],
    };
  }
  return {
    keepReservation: false,
    lines: [
      `  Could not determine whether provider '${provider}' was registered; local provider ownership was not recorded.`,
      "  Do not rebuild a sandbox from this result. Resolve the provider through a verified gateway operation, then retry.",
      `  ${inventory.error.message}`,
    ],
  };
}

export async function runCredentialsAddAction(
  input: CredentialsAddInput,
  deps: CredentialsAddDeps = {},
): Promise<CredentialsAddResult> {
  const { provider, type, credentials, configPairs, fromExisting } = input;
  const providerAdapter = deps.providerAdapter ?? createCliOpenShellProviderAdapter();

  if (!PROVIDER_NAME_PATTERN.test(provider)) {
    return fail([
      "  Provider name must be 1-128 chars, start with a letter, and use only letters, digits, '.', '_', or '-'.",
    ]);
  }
  if (!PROVIDER_TYPE_PATTERN.test(type)) {
    return fail([
      "  --type must be 1-64 chars, start with a letter, and use only letters, digits, '.', '_', or '-'.",
    ]);
  }

  if (isBridgeProviderName(provider)) {
    return fail([
      `  '${provider}' is a per-sandbox messaging bridge, not a credential.`,
      `  Use \`${CLI_NAME} <sandbox> channels add <channel>\` to attach a messaging integration`,
      "  (it provisions the bridge provider and rebuilds the sandbox).",
    ]);
  }

  if (fromExisting && credentials.length > 0) {
    return fail(["  --from-existing cannot be combined with --credential."]);
  }
  if (!fromExisting && credentials.length === 0) {
    return fail(["  At least one --credential KEY or --from-existing is required."]);
  }

  for (const credential of credentials) {
    if (credential.includes("=")) {
      return fail([
        `  --credential expects an env variable name, not 'KEY=VALUE'.`,
        `  Export the value first (e.g. \`export ${credential.split("=", 1)[0]}=...\`)`,
        `  and rerun with \`--credential ${credential.split("=", 1)[0]}\`.`,
      ]);
    }
    if (!ENV_NAME_PATTERN.test(credential)) {
      return fail([
        "  --credential must be a valid env variable name.",
        "  Use an uppercase env name (e.g. `--credential TAVILY_API_KEY`).",
      ]);
    }
    if (!process.env[credential]) {
      return fail([
        `  Env variable '${credential}' is not set in the current shell.`,
        `  Export it first (e.g. \`export ${credential}=...\`) so the gateway can read the value.`,
      ]);
    }
  }

  const config: Array<{ key: string; value: string }> = [];
  const configKeys = new Set<string>();
  for (const entry of configPairs) {
    if (entry.length > MAX_CONFIG_ENTRY_LENGTH) {
      return fail([`  --config entry exceeds ${MAX_CONFIG_ENTRY_LENGTH} characters.`]);
    }
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      return fail(["  --config must be in KEY=VALUE form."]);
    }
    const key = entry.slice(0, eq);
    if (!CONFIG_KEY_PATTERN.test(key)) {
      return fail([
        "  --config key must be alphanumeric / underscore (e.g. `--config OPENAI_BASE_URL=https://93.184.216.34/v1`).",
      ]);
    }
    if (CONFIG_KEY_DENYLIST.test(key)) {
      return fail([
        `  --config '${key}' looks credential-shaped. Use --credential <ENV_NAME> instead so the value`,
        "  stays in the host environment and never enters argv.",
      ]);
    }
    const value = entry.slice(eq + 1);
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        return fail([
          `  --config '${key}' value looks secret-shaped. Use --credential <ENV_NAME> for credentials,`,
          "  not --config; non-secret config values only.",
        ]);
      }
    }
    if (configKeys.has(key)) {
      return fail([`  --config '${key}' may be provided only once.`]);
    }
    const typedConfigFailure = typedProviderConfigFailure(type, key, value);
    if (typedConfigFailure) return fail(typedConfigFailure);
    configKeys.add(key);
    config.push({ key, value });
  }

  const endpointFailure = await providerConfigEndpointFailure(config);
  if (endpointFailure) return fail(endpointFailure);

  const managedMcpReservations = listManagedMcpCredentialReservations();
  const explicitCollision = managedMcpCollisionFailure(
    provider,
    credentials,
    managedMcpReservations,
  );
  if (explicitCollision) return explicitCollision;

  const recoveryFailureLines: string[] = [];
  const target = await recoverCredentialGatewayTargetOrExit("mutation", (lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!target) {
    return fail(recoveryFailureLines);
  }

  const profile = bundledProviderProfile(type);
  const providerType = profile?.profileType ?? type;
  const providerProfileFailure = await ensureBundledProviderProfile(
    profile,
    target,
    providerAdapter,
  );
  if (providerProfileFailure) return providerProfileFailure;

  let importedCredentialKeys: string[] | null = null;
  if (fromExisting) {
    const inspection = await providerAdapter.inspectProviderProfile({
      target,
      profileType: providerType,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (!inspection.ok) {
      return fail([
        `  Could not inspect credential keys for provider profile '${type}'.`,
        "  Refusing --from-existing because the provider profile credential keys could not be compared with managed MCP reservations.",
        ...(inspection.error.message ? [`  ${inspection.error.message}`] : []),
      ]);
    }
    importedCredentialKeys = [...inspection.value.credentialKeys];
  }

  return withMcpCredentialOwnershipLock(async () => {
    const providerCredentialKeys = importedCredentialKeys ?? credentials;
    const collision = managedMcpCollisionFailure(
      provider,
      providerCredentialKeys,
      listManagedMcpCredentialReservations(),
    );
    if (collision) return collision;

    const recordedReservation = recordExtraProvider(provider);
    let keepReservation = false;
    try {
      const result = await providerAdapter.createProvider({
        target,
        name: provider,
        type: providerType,
        credentials: credentials.map((credential) => ({
          name: credential,
          value: process.env[credential] ?? "",
        })),
        config,
        fromExisting,
        timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
      });

      if (result.ok) {
        keepReservation = true;
        return ok([
          `  Registered provider '${provider}' with the OpenShell gateway.`,
          `  Verify with '${CLI_NAME} credentials list'.`,
          `  Rebuild each sandbox that should use '${provider}' (\`${CLI_NAME} <sandbox> rebuild\`).`,
        ]);
      }

      const lines = [`  Could not register provider '${provider}'.`];
      if (isUncertainProviderCreateError(result.error)) {
        const recovery = await reconcileUncertainProviderCreate(provider, target, providerAdapter);
        keepReservation = recovery.keepReservation;
        lines.push(`  ${result.error.message}`, ...recovery.lines);
        return fail(lines);
      }
      if (result.error.kind === "command" && result.error.reason === "already_exists") {
        lines.push(
          "",
          `  '${provider}' is already registered.`,
          `  Run '${CLI_NAME} credentials reset ${provider} --yes' first if you need to replace it.`,
        );
      } else if (result.error.message) {
        lines.push(`  ${result.error.message}`);
      }
      return fail(lines);
    } finally {
      if (recordedReservation && !keepReservation) forgetExtraProvider(provider);
    }
  });
}
