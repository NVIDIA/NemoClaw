// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  buildHostAliasArgs,
  getHostsRuntimeBridge,
  hostAliasAddArgs,
  hostAliasMutationFlags,
  isHostAliasFailure,
} from "../../../lib/sandbox/hosts-command-support";

export default class HostsAddCommand extends NemoClawCommand {
  static id = "sandbox:hosts:add";
  static strict = true;
  static summary = "Add a sandbox /etc/hosts alias";
  static description = "Add a host alias to the sandbox pod template.";
  static usage = ["<name> <hostname> <ip> [--dry-run]"];
  static examples = ["<%= config.bin %> sandbox hosts add alpha searxng.local 192.168.1.105"];
  static args = hostAliasAddArgs;
  static flags = hostAliasMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(HostsAddCommand);
    try {
      getHostsRuntimeBridge().addSandboxHostAlias(
        args.sandboxName,
        buildHostAliasArgs([args.hostname, args.ip], flags),
      );
    } catch (error) {
      if (isHostAliasFailure(error)) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
