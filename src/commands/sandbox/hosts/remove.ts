// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { removeSandboxHostAlias } from "../../../lib/actions/sandbox/host-aliases";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  hostAliasMutationArgs,
  hostAliasMutationFlags,
  isHostAliasFailure,
} from "../../../lib/sandbox/hosts-command-support";

export default class HostsRemoveCommand extends NemoClawCommand {
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
    try {
      removeSandboxHostAlias(args.sandboxName, {
        hostname: args.hostname,
        dryRun: flags["dry-run"] === true,
      });
    } catch (error) {
      if (isHostAliasFailure(error)) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
