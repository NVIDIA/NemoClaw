// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { showSandboxStatus } from "../../lib/actions/sandbox/status";
import { sandboxNameArg } from "../../lib/sandbox/command-support";

export default class SandboxStatusCommand extends NemoClawCommand {
  static id = "sandbox:status";
  static strict = true;
  static summary = "Sandbox health and NIM status";
  static description = "Show sandbox health, OpenShell gateway state, and local NIM status.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox status alpha"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxStatusCommand);
    await showSandboxStatus(args.sandboxName);
  }
}
