// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { rejectSandboxPolicyRequest } from "../../../lib/actions/sandbox/policy/requests";
import { createPolicyRequestsHost } from "../../../lib/actions/sandbox/policy-channel";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { policyRequestArgs } from "../../../lib/sandbox/policy-command-support";

export default class SandboxPolicyRejectCommand extends NemoClawCommand {
  static id = "sandbox:policy:reject";
  static strict = true;
  static summary = "Reject a blocked network request";
  static description =
    "Reject a pending network request so the destination stays blocked. The optional reason is returned to the agent so it can propose a narrower rule.";
  static usage = ["<name> <id> [--reason <text>]"];
  static examples = [
    "<%= config.bin %> sandbox policy reject alpha 4f1c2a9e",
    '<%= config.bin %> sandbox policy reject alpha 4f1c2a9e --reason "Only GET /docs is needed"',
  ];
  static args = policyRequestArgs;
  static flags = {
    reason: Flags.string({
      description: "Guidance returned to the agent with the rejection",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxPolicyRejectCommand);
    const outcome = await rejectSandboxPolicyRequest(
      args.sandboxName,
      { requestId: args.requestId, reason: flags.reason },
      createPolicyRequestsHost(this.config.bin),
    );
    this.setExitCode(outcome.exitCode);
  }
}
