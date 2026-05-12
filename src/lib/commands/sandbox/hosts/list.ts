// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { getHostsRuntimeBridge, hostAliasSandboxArgs } from "./common";

export default class HostsListCommand extends Command {
  static id = "sandbox:hosts:list";
  static strict = true;
  static summary = "List sandbox host aliases";
  static description = "List host aliases configured on the sandbox resource.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox hosts list alpha"];
  static args = hostAliasSandboxArgs;
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(HostsListCommand);
    getHostsRuntimeBridge().listSandboxHostAliases(args.sandboxName);
  }
}
