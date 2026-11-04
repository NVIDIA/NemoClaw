// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { startSandbox } from "../../lib/actions/sandbox/start";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxStartCommand extends NemoClawCommand {
  static id = "sandbox:start";
  static strict = true;
  static summary = "Restart a stopped sandbox container";
  static description =
    "Start a sandbox container stopped with 'stop' or by a host reboot, then verify agent runtime readiness. For gateway-based agents, check gateway health and restore host forwards.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox start alpha"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxStartCommand);
    this.applyExitResult(await startSandbox(args.sandboxName));
  }
}
