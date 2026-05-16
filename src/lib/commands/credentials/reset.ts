// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import { runOpenshellProviderCommand } from "../../actions/global";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { isBridgeProviderName, recoverGatewayOrExit } from "./common";

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
      required: false,
    }),
  };
  static flags = {
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CredentialsResetCommand);
    const key = args.provider;

    if (!key || key.startsWith("-")) {
      this.failWithLines([
        `  Usage: ${CLI_NAME} credentials reset <PROVIDER> [--yes]`,
        `  PROVIDER is an OpenShell provider name. Run '${CLI_NAME} credentials list' first.`,
      ]);
      return;
    }

    if (isBridgeProviderName(key)) {
      this.failWithLines([
        `  '${key}' is a per-sandbox messaging bridge, not a credential.`,
        `  Use \`${CLI_NAME} <sandbox> channels remove <telegram|discord|slack>\` to retire`,
        "  the integration (it tears down the bridge provider and rebuilds the sandbox),",
        `  or \`${CLI_NAME} <sandbox> channels stop <…>\` to pause it without clearing tokens.`,
      ]);
      return;
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

    if (!(await recoverGatewayOrExit("reach", (lines) => this.failWithLines(lines)))) return;

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

    const lines = [`  Could not remove provider '${key}'.`];
    if (/^[A-Z][A-Z0-9_]+$/.test(key)) {
      lines.push(
        "",
        `  '${key}' looks like a credential env variable name.`,
        "  As of this release, 'credentials reset' takes an OpenShell",
        `  provider name. Run '${CLI_NAME} credentials list' to see the`,
        "  registered providers, then retry with one of those names.",
      );
    }
    const stderr = String(result.stderr || "").trim();
    if (stderr) lines.push(`  ${stderr}`);
    this.failWithLines(lines);
  }
}
