// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { listSandboxPolicies } from "../../../actions/sandbox/policy-channel";
import { sandboxNameArg } from "../common";

export default class SandboxPolicyListCommand extends Command {
  static id = "sandbox:policy:list";
  static strict = true;
  static summary = "List policy presets";
  static description = "List built-in and custom policy presets and show which are applied.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox policy list alpha"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxPolicyListCommand);
    listSandboxPolicies(args.sandboxName);
  }
}
