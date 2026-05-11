// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { listSandboxChannels } from "../../../actions/sandbox/policy-channel";
import { sandboxNameArg } from "../common";

export default class SandboxChannelsListCommand extends Command {
  static id = "sandbox:channels:list";
  static strict = true;
  static summary = "List supported messaging channels";
  static description = "List supported messaging channels for a sandbox.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox channels list alpha"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxChannelsListCommand);
    listSandboxChannels(args.sandboxName);
  }
}
