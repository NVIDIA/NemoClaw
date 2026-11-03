// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { recoverSandboxWithHermesCronRestore } from "../../lib/actions/sandbox/runtime/hermes-cron-restore-recovery";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class RecoverCliCommand extends NemoClawCommand {
  static id = "sandbox:recover";
  static strict = true;
  static summary = "Verify sandbox gateway health and repair host forwards";
  static description =
    "Probe sandbox gateway health and repair host forwards without opening an SSH session. For Hermes, also validate and release a NemoClaw cron restore gate left by an interrupted rebuild. A healthy gateway is not restarted. After a clean exit or exit status 79, the Hermes supervisor can wait for authenticated gated recovery. In that state, `recover` requests a supervised gateway relaunch before verification. For other stopped gateways or a forced runtime reload, use `gateway restart`.";
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
