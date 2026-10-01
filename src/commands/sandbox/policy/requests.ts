// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { listSandboxPolicyRequests } from "../../../lib/actions/sandbox/policy/requests";
import { createPolicyRequestsHost } from "../../../lib/actions/sandbox/policy-channel";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { policySandboxArgs } from "../../../lib/sandbox/policy-command-support";

export default class SandboxPolicyRequestsCommand extends NemoClawCommand {
  static id = "sandbox:policy:requests";
  static strict = true;
  static summary = "List blocked network requests waiting for approval";
  static description =
    "List the network requests that OpenShell blocked for this sandbox and holds for operator review, with the destination, the binary that made each request, and OpenShell's security and prover notes.";
  static usage = ["<name> [--json]"];
  static examples = [
    "<%= config.bin %> sandbox policy requests alpha",
    "<%= config.bin %> sandbox policy requests alpha --json",
  ];
  static args = policySandboxArgs;
  static flags = {
    json: Flags.boolean({
      description: "Print pending requests as JSON",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxPolicyRequestsCommand);
    const outcome = await listSandboxPolicyRequests(
      args.sandboxName,
      { json: flags.json },
      createPolicyRequestsHost(this.config.bin),
      { logJson: (value) => this.logJson(value) },
    );
    this.setExitCode(outcome.exitCode);
  }
}
