// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { CLI_NAME } from "../../cli/branding";
import {
  isBridgeProviderName,
  recoverGatewayForCredentialMutationOrExit,
} from "../../credentials/command-support";
import { prompt as askPrompt, KNOWN_CREDENTIAL_ENV_KEYS } from "../../credentials/store";
import {
  deleteProviderWithRecovery,
  type ProviderDeleteWithRecoveryResult,
} from "../../onboard/sandbox-provider-cleanup";
import { redact } from "../../security/redact";
import { forgetExtraProvider } from "../global";

export type CredentialsResetInput = {
  provider: string;
  confirmed: boolean;
};

export type CredentialsResetResult = {
  exitCode: number;
  outputLines: readonly string[];
  failureLines: readonly string[];
};

const KNOWN_CREDENTIAL_ENV_KEY_SET = new Set(KNOWN_CREDENTIAL_ENV_KEYS);

function ok(outputLines: readonly string[]): CredentialsResetResult {
  return { exitCode: 0, outputLines, failureLines: [] };
}

function fail(failureLines: readonly string[]): CredentialsResetResult {
  return { exitCode: 1, outputLines: [], failureLines };
}

export async function runCredentialsResetAction(
  input: CredentialsResetInput,
): Promise<CredentialsResetResult> {
  const key = input.provider;
  if (isBridgeProviderName(key)) {
    return fail([
      `  '${key}' is a per-sandbox messaging bridge, not a credential.`,
      `  Use \`${CLI_NAME} <sandbox> channels remove <channel>\` to retire`,
      "  the integration (it tears down the bridge provider and rebuilds the sandbox),",
      `  or \`${CLI_NAME} <sandbox> channels stop <…>\` to pause it without clearing tokens.`,
    ]);
  }

  if (!input.confirmed) {
    const answer = (
      await askPrompt(`  Remove provider '${key}' from the OpenShell gateway? [y/N]: `)
    )
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "yes") return ok(["  Cancelled."]);
  }

  const recoveryFailureLines: string[] = [];
  const recovered = await recoverGatewayForCredentialMutationOrExit((lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!recovered) return fail(recoveryFailureLines);

  // `provider delete` trips on FailedPrecondition while the provider is still
  // attached to a sandbox. Detach listed sandboxes and retry once (#5560).
  const recovery = deleteProviderWithRecovery(key, {
    runOpenshell: (cmdArgs) =>
      runOpenshellProviderCommand(cmdArgs, {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      }),
  });

  if (
    !recovery.ok &&
    recovery.recoveryFailures.length === 0 &&
    !KNOWN_CREDENTIAL_ENV_KEY_SET.has(key) &&
    /not found|does not exist|already absent/i.test(recovery.stderr.trim())
  ) {
    const removedLocal = forgetExtraProvider(key);
    return ok([
      removedLocal
        ? `  Provider '${key}' is already absent from the OpenShell gateway. Local state was cleaned up.`
        : `  Provider '${key}' is already absent from the OpenShell gateway.`,
      `  Re-run '${CLI_NAME} onboard' to enter a new value.`,
    ]);
  }

  const outcome = formatResetOutcome(key, recovery);
  if (!outcome.ok) return fail(outcome.lines);

  forgetExtraProvider(key);
  return ok(outcome.lines);
}

/** Build the user-facing result after a provider delete attempt. */
export function formatResetOutcome(
  key: string,
  recovery: ProviderDeleteWithRecoveryResult,
): { ok: boolean; lines: string[] } {
  const onboardHint = `  Re-run '${CLI_NAME} onboard' to enter a new value.`;
  if (recovery.ok) {
    return {
      ok: true,
      lines: [`  Removed provider '${key}' from the OpenShell gateway.`, onboardHint],
    };
  }

  const lines = [`  Could not remove provider '${key}'.`];
  if (KNOWN_CREDENTIAL_ENV_KEY_SET.has(key)) {
    lines.push(
      "",
      `  '${key}' looks like a credential env variable name.`,
      "  As of this release, 'credentials reset' takes an OpenShell",
      `  provider name. Run '${CLI_NAME} credentials list' to see the`,
      "  registered providers, then retry with one of those names.",
    );
  }
  if (recovery.recoveryFailures.length > 0) {
    const stuck = recovery.recoveryFailures.map((failure) => failure.sandbox).join(", ");
    lines.push(
      "",
      `  '${key}' is still attached to sandbox(es): ${stuck}.`,
      `  Detach it with 'openshell sandbox provider detach <sandbox> ${key}'`,
      `  for each, then re-run '${CLI_NAME} credentials reset ${key}'.`,
    );
  }
  const stderr = redact(recovery.stderr.trim());
  if (stderr) lines.push(`  ${stderr}`);
  return { ok: false, lines };
}
