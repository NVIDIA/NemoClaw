// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

import { showSandboxStatus } from "../../actions/sandbox/status";
import { sandboxNameArg } from "./common";

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
