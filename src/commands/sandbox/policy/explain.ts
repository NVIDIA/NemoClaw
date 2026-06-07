// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { explainSandboxPolicy } from "../../../lib/actions/sandbox/policy-explain";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class SandboxPolicyExplainCommand extends NemoClawCommand {
  static id = "sandbox:policy:explain";
  static strict = true;
  static summary = "Explain the active policy context for the sandbox";
  static description =
    "Print a redacted summary of the active policy presets, allowed host categories, approval paths, and support boundaries. The agent can read this output to decide whether a host or integration is allowed and what remediation step to suggest.";
  static usage = ["<name> [--json] [--write]"];
  static examples = [
    "<%= config.bin %> sandbox policy explain alpha",
    "<%= config.bin %> sandbox policy explain alpha --json",
    "<%= config.bin %> sandbox policy explain alpha --write",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    json: Flags.boolean({
      description: "Emit the policy context as JSON for agent consumption.",
      default: false,
    }),
    write: Flags.boolean({
      description:
        "Also write the rendered context to the sandbox at /sandbox/.openclaw/workspace/POLICY.md so the in-sandbox agent can read it.",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxPolicyExplainCommand);
    explainSandboxPolicy(
      args.sandboxName,
      { json: flags.json, writeToSandbox: flags.write },
      { logJson: (value) => this.logJson(value) },
    );
  }
}
