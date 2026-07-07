// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { forgetExtraProvider, runOpenshellProviderCommand } from "../../lib/actions/global";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../lib/adapters/openshell/timeouts";
import { CLI_NAME } from "../../lib/cli/branding";
import { yesFlag } from "../../lib/cli/common-flags";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { isBridgeProviderName, recoverGatewayOrExit } from "../../lib/credentials/command-support";
import { prompt as askPrompt, KNOWN_CREDENTIAL_ENV_KEYS } from "../../lib/credentials/store";
import {
  deleteProviderWithRecovery,
  type ProviderDeleteWithRecoveryResult,
} from "../../lib/onboard/sandbox-provider-cleanup";
import { redact } from "../../lib/security/redact";

const KNOWN_CREDENTIAL_ENV_KEY_SET = new Set(KNOWN_CREDENTIAL_ENV_KEYS);

export default class CredentialsResetCommand extends NemoClawCommand {
  static id = "credentials:reset";
  static strict = true;
  static summary = "Remove a provider credential";
  static description = "Remove a provider credential so onboard re-prompts for it.";
  static usage = ["credentials reset <PROVIDER> [--yes]"];
  static examples = [
    "<%= config.bin %> credentials reset nvidia-prod",
    "<%= config.bin %> credentials reset nvidia-prod --yes",
  ];
  static args = {
    provider: Args.string({
      name: "PROVIDER",
      description: "OpenShell provider name",
      ignoreStdin: true,
      required: true,
    }),
  };
  static flags = {
    yes: yesFlag(),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CredentialsResetCommand);
    const key = args.provider;

    if (isBridgeProviderName(key)) {
      this.failWithLines([
        `  '${key}' is a per-sandbox messaging bridge, not a credential.`,
        `  Use \`${CLI_NAME} <sandbox> channels remove <channel>\` to retire`,
        "  the integration (it tears down the bridge provider and rebuilds the sandbox),",
        `  or \`${CLI_NAME} <sandbox> channels stop <…>\` to pause it without clearing tokens.`,
      ]);
      return;
    }

    if (!flags.yes) {
      const answer = (
        await askPrompt(`  Remove provider '${key}' from the OpenShell gateway? [y/N]: `)
      )
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        this.log("  Cancelled.");
        return;
      }
    }

    if (!(await recoverGatewayOrExit("reach", (lines) => this.failWithLines(lines)))) return;

    // `provider delete` trips on FailedPrecondition when the provider is still
    // attached to a sandbox (e.g. `<sandbox>-brave-search` after onboard). The
    // recovery helper detaches the listed sandboxes and retries the delete once
    // so `credentials reset` is no longer a dead end (#5560).
    const recovery = deleteProviderWithRecovery(key, {
      runOpenshell: (cmdArgs) =>
        runOpenshellProviderCommand(cmdArgs, {
          ignoreError: true,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
        }),
    });
    // A gateway "not found" on a non-env-name key means the provider is already
    // gone; clean up any local extra-provider state and report it. Handled here
    // rather than in formatResetOutcome because the message depends on whether
    // local state was actually removed (#5969).
    if (
      !recovery.ok &&
      recovery.recoveryFailures.length === 0 &&
      !KNOWN_CREDENTIAL_ENV_KEY_SET.has(key) &&
      /not found|does not exist|already absent/i.test(recovery.stderr.trim())
    ) {
      const removedLocal = forgetExtraProvider(key);
      this.log(
        removedLocal
          ? `  Provider '${key}' is already absent from the OpenShell gateway. Local state was cleaned up.`
          : `  Provider '${key}' is already absent from the OpenShell gateway.`,
      );
      this.log(`  Re-run '${CLI_NAME} onboard' to enter a new value.`);
      return;
    }

    const outcome = formatResetOutcome(key, recovery);
    if (outcome.ok) {
      forgetExtraProvider(key);
      for (const line of outcome.lines) this.log(line);
      return;
    }
    this.failWithLines(outcome.lines);
  }
}

/**
 * Build the user-facing output for a `credentials reset` after running the
 * delete-with-recovery helper. Extracted so the success / still-attached /
 * env-var-name-hint branches can be unit tested without the oclif command
 * harness (#5560).
 */
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
