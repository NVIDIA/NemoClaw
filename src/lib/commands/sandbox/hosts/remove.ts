// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { buildHostAliasArgs, getHostsRuntimeBridge, hostAliasMutationArgs, hostAliasMutationFlags } from "./common";

export default class HostsRemoveCommand extends Command {
  static id = "sandbox:hosts:remove";
  static strict = true;
  static summary = "Remove a sandbox /etc/hosts alias";
  static description = "Remove a host alias from the sandbox pod template.";
  static usage = ["<name> <hostname> [--dry-run]"];
  static examples = ["<%= config.bin %> sandbox hosts remove alpha searxng.local"];
  static args = hostAliasMutationArgs;
  static flags = hostAliasMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(HostsRemoveCommand);
    getHostsRuntimeBridge().removeSandboxHostAlias(
      args.sandboxName,
      buildHostAliasArgs([args.hostname], flags),
    );
  }
}
