// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import {
  appendCommonPolicyFlags,
  getPolicyRuntimeBridge,
  policyMutationArgs,
  policyMutationFlags,
} from "./common";

export default class PolicyAddCommand extends Command {
  static id = "sandbox:policy:add";
  static strict = true;
  static summary = "Add a network or filesystem policy preset";
  static description = "Add a built-in or custom policy preset to a sandbox.";
  static usage = [
    "<name> policy-add [preset] [--yes|-y] [--dry-run] [--from-file <path>] [--from-dir <path>]",
  ];
  static examples = [
    "<%= config.bin %> alpha policy-add slack --yes",
    "<%= config.bin %> alpha policy-add --from-file ./policy.yaml --dry-run",
    "<%= config.bin %> alpha policy-add --from-dir ./policies --yes",
  ];
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
    const legacyArgs: string[] = [];
    if (args.preset) legacyArgs.push(args.preset);
    appendCommonPolicyFlags(legacyArgs, flags);
    if (flags["from-file"]) legacyArgs.push("--from-file", flags["from-file"]);
    if (flags["from-dir"]) legacyArgs.push("--from-dir", flags["from-dir"]);
    await getPolicyRuntimeBridge().sandboxPolicyAdd(args.sandboxName, legacyArgs);
  }
}
