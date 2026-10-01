// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { approveSandboxPolicyRequest } from "../../../lib/actions/sandbox/policy/requests";
import { createPolicyRequestsHost } from "../../../lib/actions/sandbox/policy-channel";
import { yesFlag } from "../../../lib/cli/common-flags";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { policyRequestArgs } from "../../../lib/sandbox/policy-command-support";

export default class SandboxPolicyApproveCommand extends NemoClawCommand {
  static id = "sandbox:policy:approve";
  static strict = true;
  static summary = "Approve a blocked network request";
  static description =
    "Show what a pending network request allows, then add it to the sandbox's live OpenShell policy after confirmation. OpenShell refuses the approval if the proposed rule changed after it was shown.";
  static usage = ["<name> <id> [--yes|-y]"];
  static examples = ["<%= config.bin %> sandbox policy approve alpha 4f1c2a9e"];
  static args = policyRequestArgs;
  static flags = { yes: yesFlag() };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxPolicyApproveCommand);
    const outcome = await approveSandboxPolicyRequest(
      args.sandboxName,
      { requestId: args.requestId, yes: flags.yes },
      createPolicyRequestsHost(this.config.bin),
    );
    this.setExitCode(outcome.exitCode);
  }
}
