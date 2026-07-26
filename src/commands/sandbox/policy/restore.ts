// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { restoreSandboxBaseline } from "../../../lib/actions/sandbox/policy-channel";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  commonPolicyOptions,
  policyBaselineArgs,
  policyBaselineRestoreFlags,
} from "../../../lib/sandbox/policy-command-support";

export default class PolicyRestoreCommand extends NemoClawCommand {
  static id = "sandbox:policy:restore";
  static strict = true;
  static summary = "Restore a previously excluded baseline entry";
  static description =
    "Restore an excluded baseline network policy entry against the current release baseline and drop its recorded exclusion.";
  static usage = ["<name> <key> [--dry-run]"];
  static examples = [
    "<%= config.bin %> sandbox policy restore alpha nous_research",
    "<%= config.bin %> sandbox policy restore alpha nous_research --dry-run",
  ];
  static args = policyBaselineArgs;
  static flags = policyBaselineRestoreFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicyRestoreCommand);
    await restoreSandboxBaseline(args.sandboxName, {
      key: args.key,
      ...commonPolicyOptions(flags),
    });
  }
}
