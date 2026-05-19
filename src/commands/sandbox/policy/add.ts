// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import type { PublicCommandDisplayEntry } from "../../../lib/cli/command-display";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  commonPolicyOptions,
  getPolicyRuntimeBridge,
  policyMutationArgs,
  policyMutationFlags,
} from "../../../lib/sandbox/policy-command-support";

export default class PolicyAddCommand extends NemoClawCommand {
  static id = "sandbox:policy:add";
  static strict = true;
  static summary = "Add a network or filesystem policy preset";
  static description = "Add a built-in or custom policy preset to a sandbox.";
  static usage = [
    "<name> [preset] [--yes|-y] [--dry-run] [--from-file <path>] [--from-dir <path>]",
  ];
  static examples = [
    "<%= config.bin %> sandbox policy add alpha slack --yes",
    "<%= config.bin %> sandbox policy add alpha --from-file ./policy.yaml --dry-run",
    "<%= config.bin %> sandbox policy add alpha --from-dir ./policies --yes",
  ];
  static publicDisplay = [
    {
      usage: "nemoclaw <name> policy-add",
      description: "Add a network or filesystem policy preset",
      flags: "(--yes, -y, --dry-run, --from-file <path>, --from-dir <path>)",
      group: "Policy Presets",
      scope: "sandbox",
      order: 17,
    },
  ] satisfies readonly PublicCommandDisplayEntry[];
  static args = policyMutationArgs;
  static flags = {
    ...policyMutationFlags,
    "from-file": Flags.string({
      description: "Load one custom preset YAML file",
      exclusive: ["from-dir"],
    }),
    "from-dir": Flags.string({
      description: "Load all custom preset YAML files in a directory",
      exclusive: ["from-file"],
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicyAddCommand);
    await getPolicyRuntimeBridge().sandboxPolicyAdd(args.sandboxName, {
      preset: args.preset,
      ...commonPolicyOptions(flags),
      fromFile: flags["from-file"],
      fromDir: flags["from-dir"],
    });
  }
}
