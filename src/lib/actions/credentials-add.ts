// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { CLI_NAME } from "../cli/branding";
import { isBridgeProviderName, recoverGatewayOrExit } from "../credentials/command-support";
import { redact } from "../security/redact";
import { SECRET_PATTERNS } from "../security/secret-patterns";
import { ROOT } from "../state/paths";
import { recordExtraProvider, runOpenshellProviderCommand } from "./global";

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

  const recoveryFailureLines: string[] = [];
  const recovered = await recoverGatewayOrExit("reach", (lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!recovered) {
    return fail(recoveryFailureLines);
  }

  const providerProfileFailure = ensureBundledProviderProfile(type);
  if (providerProfileFailure) return providerProfileFailure;

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

  const result = runOpenshellProviderCommand(openshellArgs, {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });

  if (result.status === 0) {
    recordExtraProvider(provider);
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
}
