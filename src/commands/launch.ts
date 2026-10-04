// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { launchSandbox } from "../lib/actions/sandbox/launch";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class LaunchCommand extends NemoClawCommand {
  static id = "launch";
  static strict = true;
  static summary = "Connect to a sandbox and start its agent";
  static description =
    "Validate a current launch-readiness lease or run the complete connect preflight, then start the sandbox's agent in one step so an interactive session does not need a second command typed inside the sandbox.";
  static usage = ["launch <name>"];
  static examples = ["<%= config.bin %> launch alpha"];
  static args = {
    sandboxName: Args.string({
      name: "name",
      description: "Sandbox name to connect to",
      required: true,
    }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(LaunchCommand);
    await launchSandbox(args.sandboxName);
  }
}
