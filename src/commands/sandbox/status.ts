// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { showSandboxStatus } from "../../lib/actions/sandbox/status";
import { getSandboxStatusReport } from "../../lib/inventory";
import { sandboxNameArg } from "../../lib/sandbox/command-support";
import { buildStatusCommandDeps } from "../../lib/status-command-deps";

export default class SandboxStatusCommand extends NemoClawCommand {
  static id = "sandbox:status";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Sandbox health and NIM status";
  static description = "Show sandbox health, OpenShell gateway state, and local NIM status.";
  static usage = ["<name> [--json]"];
  static examples = ["<%= config.bin %> sandbox status alpha", "<%= config.bin %> sandbox status alpha --json"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
  };

  public async run(): Promise<unknown> {
    const { args } = await this.parse(SandboxStatusCommand);
    if (this.jsonEnabled()) {
      const report = getSandboxStatusReport(buildStatusCommandDeps(this.config.root), args.sandboxName);
      if (!report.sandbox || (report.gatewayHealth && !report.gatewayHealth.healthy)) {
        process.exitCode = 1;
      }
      return report;
    }
    await showSandboxStatus(args.sandboxName);
  }
}
