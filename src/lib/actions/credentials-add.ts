// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { CLI_NAME } from "../cli/branding";
import { isBridgeProviderName, recoverGatewayOrExit } from "../credentials/command-support";
import { redact } from "../security/redact";
import { runOpenshellProviderCommand } from "./global";

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

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function ok(successLines: readonly string[]): CredentialsAddResult {
  return { exitCode: 0, successLines, failureLines: [] };
}

function fail(failureLines: readonly string[], exitCode = 1): CredentialsAddResult {
  return { exitCode, successLines: [], failureLines };
}

export async function runCredentialsAddAction(
  input: CredentialsAddInput,
): Promise<CredentialsAddResult> {
  const { provider, type, credentials, configPairs, fromExisting } = input;

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
        `  --credential '${credential}' is not a valid env variable name.`,
        `  Use an uppercase env name (e.g. \`--credential TAVILY_API_KEY\`).`,
      ]);
    }
    if (!process.env[credential]) {
      return fail([
        `  Env variable '${credential}' is not set in the current shell.`,
        `  Export it first (e.g. \`export ${credential}=...\`) so the gateway can read the value.`,
      ]);
    }
  }

  const validatedConfig: string[] = [];
  for (const entry of configPairs) {
    if (!entry.includes("=")) {
      return fail([`  --config '${entry}' must be in KEY=VALUE form.`]);
    }
    validatedConfig.push(entry);
  }

  const recoveryFailureLines: string[] = [];
  const recovered = await recoverGatewayOrExit("reach", (lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!recovered) {
    return fail(recoveryFailureLines);
  }

  const openshellArgs: string[] = ["provider", "create", "--name", provider, "--type", type];
  if (fromExisting) {
    openshellArgs.push("--from-existing");
  } else {
    for (const credential of credentials) {
      openshellArgs.push("--credential", credential);
    }
  }
  for (const configPair of validatedConfig) {
    openshellArgs.push("--config", configPair);
  }

  const result = runOpenshellProviderCommand(openshellArgs, {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });

  if (result.status === 0) {
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
