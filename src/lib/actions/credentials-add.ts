// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { runOpenshellProviderCommand } from "../adapters/openshell/provider-command";
import {
  checkOpenAiInferenceProviderProfile,
  OPENAI_GATEWAY_PROVIDER_TYPE,
} from "../adapters/openshell/provider-profile";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { CLI_NAME } from "../cli/branding";
import {
  isBridgeProviderName,
  recoverGatewayForCredentialMutationOrExit,
} from "../credentials/command-support";
import { redact } from "../security/redact";
import { SECRET_PATTERNS } from "../security/secret-patterns";
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

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,255}$/;
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CONFIG_KEY_DENYLIST =
  /(?:^|_)(?:key|token|secret|password|credential|authorization|bearer|api[_-]?key)(?:_|$)/i;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/i;
const PROVIDER_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/i;
const MAX_CONFIG_ENTRY_LENGTH = 4096;

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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderProfileCredentialKeys(output: string): string[] | null {
  let profile: unknown;
  try {
    profile = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isObjectRecord(profile) || !Array.isArray(profile.credentials)) return null;

  const keys = new Set<string>();
  for (const credential of profile.credentials) {
    if (!isObjectRecord(credential) || !Array.isArray(credential.env_vars)) return null;
    for (const key of credential.env_vars) {
      if (typeof key !== "string" || !ENV_NAME_PATTERN.test(key)) return null;
      keys.add(key);
    }
  }
  return [...keys].sort();
}

function inspectProviderProfileCredentialKeys(type: string): {
  credentialKeys: string[] | null;
  diagnostic: string;
} {
  const result = runOpenshellProviderCommand(
    ["provider", "profile", "export", type, "--output", "json"],
    {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    },
  );
  return {
    credentialKeys:
      result.status === 0 ? parseProviderProfileCredentialKeys(String(result.stdout || "")) : null,
    diagnostic: redact(`${String(result.stderr || "")} ${String(result.stdout || "")}`).trim(),
  };
}

function bundledProviderProfilePath(type: string): string {
  return path.join(ROOT, "nemoclaw-blueprint", "provider-profiles", `${type.toLowerCase()}.yaml`);
}

function ensureBundledProviderProfile(type: string): CredentialsAddResult | null {
  const profilePath = bundledProviderProfilePath(type);
  if (!fs.existsSync(profilePath)) return null;

  const result = runOpenshellProviderCommand(
    ["provider", "profile", "import", "--file", profilePath],
    {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    },
  );
  if (result.status === 0) return null;

  const rawDiagnostic = `${String(result.stderr || "")} ${String(result.stdout || "")}`;
  if (/already exists/i.test(rawDiagnostic)) return null;

  const redactedDiagnostic = redact(rawDiagnostic).trim();
  return fail([
    `  Could not import bundled provider profile '${type}'.`,
    "  Update OpenShell with scripts/install-openshell.sh and retry.",
    ...(redactedDiagnostic ? [`  ${redactedDiagnostic}`] : []),
  ]);
}

function ensureCredentialProviderProfile(type: string): CredentialsAddResult | null {
  if (type.toLowerCase() !== OPENAI_GATEWAY_PROVIDER_TYPE) {
    return ensureBundledProviderProfile(type);
  }
  const profile = checkOpenAiInferenceProviderProfile({
    runOpenshell: (args, options) =>
      runOpenshellProviderCommand(args, {
        ...options,
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      }),
  });
  return profile.ok ? null : fail(profile.messages);
}

export async function runCredentialsAddAction(
  input: CredentialsAddInput,
): Promise<CredentialsAddResult> {
  const { provider, type, credentials, configPairs, fromExisting } = input;

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
        `  and re-run with \`--credential ${credential.split("=", 1)[0]}\`.`,
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
        "  --config key must be alphanumeric / underscore (e.g. `--config region=us-east-1`).",
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
  }

  const managedMcpReservations = listManagedMcpCredentialReservations();
  const explicitCollision = managedMcpCollisionFailure(
    provider,
    credentials,
    managedMcpReservations,
  );
  if (explicitCollision) return explicitCollision;

  if (fromExisting && managedMcpReservations.length > 0) {
    return fail([
      "  --from-existing does not expose credential keys before provider creation.",
      "  Cannot compare imported provider credentials with keys reserved by managed MCP servers.",
      "  Rerun with explicit --credential <ENV_NAME> input, or remove every managed MCP server that reserves credential keys before retrying.",
    ]);
  }

  const recoveryFailureLines: string[] = [];
  const recovered = await recoverGatewayForCredentialMutationOrExit((lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!recovered) {
    return fail(recoveryFailureLines);
  }

  const providerProfileFailure = ensureCredentialProviderProfile(type);
  if (providerProfileFailure) return providerProfileFailure;

  let importedCredentialKeys: string[] | null = null;
  if (fromExisting) {
    const inspection = inspectProviderProfileCredentialKeys(type);
    if (!inspection.credentialKeys) {
      return fail([
        `  Could not inspect credential keys for provider profile '${type}'.`,
        "  Refusing --from-existing because the provider profile credential keys could not be compared with managed MCP reservations.",
        ...(inspection.diagnostic ? [`  ${inspection.diagnostic}`] : []),
      ]);
    }
    importedCredentialKeys = inspection.credentialKeys;
  }

  const openshellArgs: string[] = ["provider", "create", "--name", provider, "--type", type];
  if (fromExisting) {
    openshellArgs.push("--from-existing");
  } else {
    for (const credential of credentials) {
      openshellArgs.push("--credential", credential);
    }
  }
  for (const configPair of configPairs) {
    openshellArgs.push("--config", configPair);
  }

  return withMcpCredentialOwnershipLock(() => {
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
      const result = runOpenshellProviderCommand(openshellArgs, {
        env: Object.fromEntries(
          credentials.map((credential) => [credential, process.env[credential]]),
        ),
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      });

      if (result.status === 0) {
        keepReservation = true;
        return ok([
          `  Registered provider '${provider}' with the OpenShell gateway.`,
          `  Verify with '${CLI_NAME} credentials list'.`,
          `  Rebuild the target sandbox (\`${CLI_NAME} <sandbox> rebuild\`) to attach the new provider.`,
        ]);
      }

      const rawStderr = String(result.stderr || "").trim();
      const redactedStderr = redact(rawStderr);
      const lines = [`  Could not register provider '${provider}'.`];
      if (/already exists/i.test(rawStderr)) {
        lines.push(
          "",
          `  '${provider}' is already registered.`,
          `  Run '${CLI_NAME} credentials reset ${provider} --yes' first if you need to replace it.`,
        );
      } else if (redactedStderr) {
        lines.push(`  ${redactedStderr}`);
      }
      return fail(lines);
    } finally {
      if (recordedReservation && !keepReservation) forgetExtraProvider(provider);
    }
  });
}
