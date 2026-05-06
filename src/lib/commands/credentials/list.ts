// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { CLI_NAME } from "../../branding";
import { runOpenshellProviderCommand } from "../../global-cli-actions";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../openshell-timeouts";
import { isBridgeProviderName, recoverGatewayOrExit } from "./common";

export default class CredentialsListCommand extends Command {
  static id = "credentials:list";
  static strict = true;
  static summary = "List stored credential providers";
  static description = "List provider credentials registered with the OpenShell gateway.";
  static usage = ["credentials list"];
  static examples = ["<%= config.bin %> credentials list"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(CredentialsListCommand);
    await recoverGatewayOrExit("query");

    const result = runOpenshellProviderCommand(["provider", "list", "--names"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      console.error("  Could not query OpenShell gateway. Is it running?");
      console.error(`  Run 'openshell gateway start --name nemoclaw' or '${CLI_NAME} onboard' first.`);
      process.exit(1);
    }

    const allNames = String(result.stdout || "")
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const credentialNames = allNames.filter((name) => !isBridgeProviderName(name)).sort();
    const bridgeNames = allNames.filter((name) => isBridgeProviderName(name));

    if (credentialNames.length === 0) {
      this.log("  No provider credentials registered.");
    } else {
      this.log("  Providers registered with the OpenShell gateway:");
      for (const name of credentialNames) {
        this.log(`    ${name}`);
      }
    }
    if (bridgeNames.length > 0) {
      this.log("");
      this.log(`  ${String(bridgeNames.length)} per-sandbox messaging bridge(s) are also registered.`);
      this.log(`  Manage those with \`${CLI_NAME} <sandbox> channels list/remove/stop\` — not this command.`);
    }
  }
}
