// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listSandboxHostAliases } from "../../../lib/actions/sandbox/host-aliases";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { hostAliasSandboxArgs, isHostAliasFailure } from "../../../lib/sandbox/hosts-command-support";

export default class HostsListCommand extends NemoClawCommand {
  static id = "sandbox:hosts:list";
  static strict = true;
  static summary = "List sandbox host aliases";
  static description = "List host aliases configured on the sandbox resource.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox hosts list alpha"];
  static args = hostAliasSandboxArgs;
  static flags = {
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(HostsListCommand);
    try {
      listSandboxHostAliases(args.sandboxName);
    } catch (error) {
      if (isHostAliasFailure(error)) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
