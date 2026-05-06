// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import {
  appendCommonPolicyFlags,
  getPolicyRuntimeBridge,
  policyMutationArgs,
  policyMutationFlags,
} from "./common";

export default class PolicyRemoveCommand extends Command {
  static id = "sandbox:policy:remove";
  static strict = true;
  static summary = "Remove an applied policy preset";
  static description = "Remove a built-in or custom policy preset from a sandbox.";
  static usage = ["<name> policy-remove [preset] [--yes|-y] [--dry-run]"];
  static examples = [
    "<%= config.bin %> alpha policy-remove slack --yes",
    "<%= config.bin %> alpha policy-remove slack --dry-run",
  ];
  static args = policyMutationArgs;
  static flags = policyMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicyRemoveCommand);
    const legacyArgs: string[] = [];
    if (args.preset) legacyArgs.push(args.preset);
    appendCommonPolicyFlags(legacyArgs, flags);
    await getPolicyRuntimeBridge().sandboxPolicyRemove(args.sandboxName, legacyArgs);
  }
}
