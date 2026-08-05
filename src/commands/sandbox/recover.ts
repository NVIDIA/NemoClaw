// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { recoverSandboxWithHermesCronRestore } from "../../lib/actions/sandbox/runtime/hermes-cron-restore-recovery";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class RecoverCliCommand extends NemoClawCommand {
  static id = "sandbox:recover";
  static strict = true;
  static summary = "Repair a stopped sandbox gateway and host forwards";
  static description =
    "Probe sandbox gateway health and repair stopped gateways or host forwards without opening an SSH session. For Hermes, also validate and release a NemoClaw cron restore gate left by an interrupted rebuild. A healthy gateway is not restarted; use `gateway restart` when you need a forced runtime reload.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox recover alpha"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(RecoverCliCommand);
    await recoverSandboxWithHermesCronRestore(args.sandboxName);
  }
}
