// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

import { runSandboxDoctor } from "../../actions/sandbox/doctor";

export default class SandboxDoctorCliCommand extends NemoClawCommand {
  static id = "sandbox:doctor";
  static strict = true;
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
  static flags = {
    json: Flags.boolean({ description: "Emit machine-readable JSON diagnostics" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxDoctorCliCommand);
    await runSandboxDoctor(args.sandboxName, flags.json ? ["--json"] : []);
  }
}
