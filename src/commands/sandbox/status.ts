// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { getSandboxStatusReport, showSandboxStatus } from "../../lib/actions/sandbox/status";
import { sandboxNameArg } from "../../lib/sandbox/command-support";
import { redactForLog } from "../../lib/security/redact";

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
  static flags = {};

  public async run(): Promise<unknown> {
    const { args } = await this.parse(SandboxStatusCommand);
    if (this.jsonEnabled()) {
      const report = await getSandboxStatusReport(args.sandboxName);
      if (
        !report.found ||
        report.gatewayState !== "present" ||
        report.rpcIssue ||
        report.failureLayer
      ) {
        process.exitCode = 1;
      }
      // #4310: route the machine-readable report through the centralized
      // redactForLog source of truth so health diagnostics (inferenceHealth
      // endpoint/detail/subprobes) cannot leak token-shaped values into
      // automation that persists CLI JSON output.
      return redactForLog(report);
    }
    await showSandboxStatus(args.sandboxName);
  }
}
