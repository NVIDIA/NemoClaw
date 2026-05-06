// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { runSandboxDoctor } from "../../sandbox-doctor-action";

export default class SandboxDoctorCliCommand extends Command {
  static id = "sandbox:doctor";
  static strict = true;
  static summary = "Diagnose sandbox and gateway health";
  static description = "Run host, gateway, sandbox, inference, messaging, and local service diagnostics.";
  static usage = ["<name> doctor [--json]"];
  static examples = ["<%= config.bin %> alpha doctor", "<%= config.bin %> alpha doctor --json"];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    json: Flags.boolean({ description: "Emit machine-readable JSON diagnostics" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxDoctorCliCommand);
    await runSandboxDoctor(args.sandboxName, flags.json ? ["--json"] : []);
  }
}
