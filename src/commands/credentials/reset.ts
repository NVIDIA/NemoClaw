// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { forgetExtraProvider, runOpenshellProviderCommand } from "../../lib/actions/global";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../lib/adapters/openshell/timeouts";
import { CLI_NAME } from "../../lib/cli/branding";
import { yesFlag } from "../../lib/cli/common-flags";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { isBridgeProviderName, recoverGatewayOrExit } from "../../lib/credentials/command-support";
import { KNOWN_CREDENTIAL_ENV_KEYS, prompt as askPrompt } from "../../lib/credentials/store";
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

    const result = runOpenshellProviderCommand(["provider", "delete", key], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (result.status === 0) {
      forgetExtraProvider(key);
      this.log(`  Removed provider '${key}' from the OpenShell gateway.`);
      this.log(`  Re-run '${CLI_NAME} onboard' to enter a new value.`);
      return;
    }

    const rawStderr = String(result.stderr || "").trim();
    const looksLikeEnvName = KNOWN_CREDENTIAL_ENV_KEY_SET.has(key);
    const alreadyAbsent = /not found|does not exist|already absent/i.test(rawStderr);
    if (alreadyAbsent && !looksLikeEnvName) {
      const removedLocal = forgetExtraProvider(key);
      this.log(
        removedLocal
          ? `  Provider '${key}' is already absent from the OpenShell gateway. Local state was cleaned up.`
          : `  Provider '${key}' is already absent from the OpenShell gateway.`,
      );
      this.log(`  Re-run '${CLI_NAME} onboard' to enter a new value.`);
      return;
    }

    const lines = [`  Could not remove provider '${key}'.`];
    if (looksLikeEnvName) {
      lines.push(
        "",
        `  '${key}' looks like a credential env variable name.`,
        "  As of this release, 'credentials reset' takes an OpenShell",
        `  provider name. Run '${CLI_NAME} credentials list' to see the`,
        "  registered providers, then retry with one of those names.",
      );
    }
    const stderr = redact(rawStderr);
    if (stderr) lines.push(`  ${stderr}`);
    this.failWithLines(lines);
  }
}
