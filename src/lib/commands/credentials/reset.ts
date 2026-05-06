// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { CLI_NAME } from "../../branding";
import { prompt as askPrompt } from "../../credentials";
import { runOpenshellProviderCommand } from "../../global-cli-actions";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { isBridgeProviderName, recoverGatewayOrExit } from "./common";

export default class CredentialsResetCommand extends Command {
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
      required: false,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CredentialsResetCommand);
    const key = args.provider;

    if (!key || key.startsWith("-")) {
      console.error(`  Usage: ${CLI_NAME} credentials reset <PROVIDER> [--yes]`);
      console.error(`  PROVIDER is an OpenShell provider name. Run '${CLI_NAME} credentials list' first.`);
      process.exit(1);
    }

    if (isBridgeProviderName(key)) {
      console.error(`  '${key}' is a per-sandbox messaging bridge, not a credential.`);
      console.error(
        `  Use \`${CLI_NAME} <sandbox> channels remove <telegram|discord|slack>\` to retire`,
      );
      console.error("  the integration (it tears down the bridge provider and rebuilds the sandbox),");
      console.error(`  or \`${CLI_NAME} <sandbox> channels stop <…>\` to pause it without clearing tokens.`);
      process.exit(1);
    }

    if (!flags.yes) {
      const answer = (await askPrompt(`  Remove provider '${key}' from the OpenShell gateway? [y/N]: `))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        this.log("  Cancelled.");
        return;
      }
    }

    await recoverGatewayOrExit("reach");

    const result = runOpenshellProviderCommand(["provider", "delete", key], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (result.status === 0) {
      this.log(`  Removed provider '${key}' from the OpenShell gateway.`);
      this.log(`  Re-run '${CLI_NAME} onboard' to enter a new value.`);
      return;
    }

    console.error(`  Could not remove provider '${key}'.`);
    if (/^[A-Z][A-Z0-9_]+$/.test(key)) {
      console.error("");
      console.error(`  '${key}' looks like a credential env variable name.`);
      console.error("  As of this release, 'credentials reset' takes an OpenShell");
      console.error(`  provider name. Run '${CLI_NAME} credentials list' to see the`);
      console.error("  registered providers, then retry with one of those names.");
    }
    const stderr = String(result.stderr || "").trim();
    if (stderr) console.error(`  ${stderr}`);
    process.exit(1);
  }
}
