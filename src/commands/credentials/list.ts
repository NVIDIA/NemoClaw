// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../lib/actions/global";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../lib/adapters/openshell/timeouts";
import { CLI_NAME } from "../../lib/cli/branding";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { recoverGatewayOrExit } from "../../lib/credentials/command-support";
import { parseGatewayProviderNames } from "../../lib/credentials/provider-list";

export default class CredentialsListCommand extends NemoClawCommand {
  static id = "credentials:list";
  static strict = true;
  static summary = "List stored credential providers";
  static description = "List provider credentials registered with the OpenShell gateway.";
  static usage = ["credentials list"];
  static examples = ["<%= config.bin %> credentials list"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(CredentialsListCommand);
    if (!(await recoverGatewayOrExit("query", (lines) => this.failWithLines(lines)))) return;

    const result = runOpenshellProviderCommand(["provider", "list", "--names"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      this.failWithLines([
        "  Could not query OpenShell gateway. Is it running?",
        `  Run 'openshell gateway start --name nemoclaw' or '${CLI_NAME} onboard' first.`,
      ]);
      return;
    }

    const { bridgeNames, credentialNames } = parseGatewayProviderNames(result.stdout);

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
      this.log(
        `  ${String(bridgeNames.length)} per-sandbox messaging bridge(s) are also registered.`,
      );
      this.log(
        `  Manage those with \`${CLI_NAME} <sandbox> channels list/remove/stop\` — not this command.`,
      );
    }
  }
}
