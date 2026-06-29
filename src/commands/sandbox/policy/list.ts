// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { listSandboxPolicies } from "../../../lib/actions/sandbox/policy-channel";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class SandboxPolicyListCommand extends NemoClawCommand {
  static id = "sandbox:policy:list";
  static strict = true;
  static summary = "List policy presets";
  static description = "List built-in and custom policy presets and show which are applied.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox policy list alpha"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxPolicyListCommand);
    listSandboxPolicies(args.sandboxName);
  }
}
