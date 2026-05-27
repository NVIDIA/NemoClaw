// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { getSandboxStatusReport, showSandboxStatus } from "../../lib/actions/sandbox/status";
import { sandboxNameArg } from "../../lib/sandbox/command-support";

export default class SandboxStatusCommand extends NemoClawCommand {
  static id = "sandbox:status";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Sandbox health and NIM status";
  static description = "Show sandbox health, OpenShell gateway state, and local NIM status.";
  static usage = ["<name> [--json]"];
  static examples = [
    "<%= config.bin %> sandbox status alpha",
    "<%= config.bin %> sandbox status alpha --json",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
  };

  public async run(): Promise<unknown> {
    const { args } = await this.parse(SandboxStatusCommand);
    if (this.jsonEnabled()) {
      const report = await getSandboxStatusReport(args.sandboxName);
      if (!report.found || report.gatewayState !== "present") {
        process.exitCode = 1;
      }
      return report;
    }
    await showSandboxStatus(args.sandboxName);
  }
}
