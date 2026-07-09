// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { getSandboxPolicy } from "../../../lib/actions/sandbox/policy-get";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class SandboxPolicyGetCommand extends NemoClawCommand {
  static id = "sandbox:policy:get";
  static strict = true;
  static summary = "Export the round-trippable sandbox base policy";
  static description =
    "Retrieve the OpenShell base policy for a sandbox. By default, strips the OpenShell metadata header and outputs YAML suitable for review, editing, and policy set. Use --raw to emit the unparsed --base response.";
  static usage = ["<name> [--raw]"];
  static examples = [
    "<%= config.bin %> sandbox policy get alpha",
    "<%= config.bin %> sandbox policy get alpha --raw",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    raw: Flags.boolean({
      description: "Output the unparsed OpenShell --base response, including its metadata header",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxPolicyGetCommand);

    const { raw, yaml } = getSandboxPolicy(args.sandboxName);

    if (!raw) {
      this.error("Failed to retrieve base policy from sandbox.");
    }

    if (flags.raw) {
      this.log(raw);
      return;
    }

    if (!yaml) {
      this.error("Failed to parse base policy YAML from sandbox output.");
    }

    this.log(yaml);
  }
}
