// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { runSandboxDoctor } from "../../lib/actions/sandbox/doctor";

export default class SandboxDoctorCliCommand extends NemoClawCommand {
  static id = "sandbox:doctor";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Diagnose sandbox and gateway health";
  static description = "Run host, gateway, sandbox, inference, messaging, and local service diagnostics.";
  static usage = ["<name> [--json]"];
  static examples = ["<%= config.bin %> sandbox doctor alpha", "<%= config.bin %> sandbox doctor alpha --json"];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {};

  public async run(): Promise<unknown> {
    const { args } = await this.parse(SandboxDoctorCliCommand);
    const report = await runSandboxDoctor(
      args.sandboxName,
      this.jsonEnabled() ? ["--json"] : [],
      { quietJson: this.jsonEnabled() },
    );
    if (this.jsonEnabled()) {
      if (report && report.failed > 0) process.exitCode = 1;
      return report;
    }
  }
}
