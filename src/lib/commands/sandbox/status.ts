// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { showSandboxStatus } from "../../sandbox-runtime-actions";
import { sandboxNameArg } from "./common";

export default class SandboxStatusCommand extends Command {
  static id = "sandbox:status";
  static strict = true;
  static summary = "Sandbox health and NIM status";
  static description = "Show sandbox health, OpenShell gateway state, and local NIM status.";
  static usage = ["<name> status"];
  static examples = ["<%= config.bin %> alpha status"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxStatusCommand);
    await showSandboxStatus(args.sandboxName);
  }
}
