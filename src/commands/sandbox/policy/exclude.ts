// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { excludeSandboxBaseline } from "../../../lib/actions/sandbox/policy-channel";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  commonPolicyOptions,
  policyBaselineArgs,
  policyMutationFlags,
} from "../../../lib/sandbox/policy-command-support";

export default class PolicyExcludeCommand extends NemoClawCommand {
  static id = "sandbox:policy:exclude";
  static strict = true;
  static summary = "Exclude an entry from the agent baseline policy";
  static description =
    "Persistently exclude an exact baseline network policy entry from a sandbox. The removed egress and its support impact are previewed before mutation, and the exclusion is replayed across rebuild.";
  static usage = ["<name> <key> [--force|-f] [--yes|-y] [--dry-run]"];
  static examples = [
    "<%= config.bin %> sandbox policy exclude alpha nous_research --force",
    "<%= config.bin %> sandbox policy exclude alpha nous_research --dry-run",
  ];
  static args = policyBaselineArgs;
  static flags = policyMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicyExcludeCommand);
    await excludeSandboxBaseline(args.sandboxName, {
      key: args.key,
      ...commonPolicyOptions(flags),
    });
  }
}
