// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PublicCommandDisplayEntry } from "../../../lib/cli/command-display";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  commonPolicyOptions,
  getPolicyRuntimeBridge,
  policyMutationArgs,
  policyMutationFlags,
} from "../../../lib/sandbox/policy-command-support";

export default class PolicyRemoveCommand extends NemoClawCommand {
  static id = "sandbox:policy:remove";
  static strict = true;
  static summary = "Remove an applied policy preset";
  static description = "Remove a built-in or custom policy preset from a sandbox.";
  static usage = ["<name> [preset] [--yes|-y] [--dry-run]"];
  static examples = [
    "<%= config.bin %> sandbox policy remove alpha slack --yes",
    "<%= config.bin %> sandbox policy remove alpha slack --dry-run",
  ];
  static publicDisplay = [
    {
      usage: "nemoclaw <name> policy-remove",
      description: "Remove an applied policy preset (built-in or custom)",
      flags: "(--yes, -y, --dry-run)",
      group: "Policy Presets",
      scope: "sandbox",
      order: 18,
    },
  ] satisfies readonly PublicCommandDisplayEntry[];
  static args = policyMutationArgs;
  static flags = policyMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicyRemoveCommand);
    await getPolicyRuntimeBridge().sandboxPolicyRemove(args.sandboxName, {
      preset: args.preset,
      ...commonPolicyOptions(flags),
    });
  }
}
