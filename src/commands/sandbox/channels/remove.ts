// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PublicCommandDisplayEntry } from "../../../lib/cli/command-display";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  channelMutationOptions,
  channelMutationArgs,
  channelMutationFlags,
  getChannelsRuntimeBridge,
} from "../../../lib/sandbox/channels-command-support";

export default class ChannelsRemoveCommand extends NemoClawCommand {
  static id = "sandbox:channels:remove";
  static strict = true;
  static summary = "Clear messaging channel credentials and rebuild";
  static description = "Remove credentials for a messaging channel and queue a sandbox rebuild.";
  static usage = ["<name> <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> sandbox channels remove alpha slack --dry-run"];
  static publicDisplay = [
    {
      usage: "nemoclaw <name> channels remove",
      description: "Remove a configured messaging channel",
      flags: "<channel> [--dry-run]",
      group: "Messaging Channels",
      scope: "sandbox",
      order: 22,
    },
  ] satisfies readonly PublicCommandDisplayEntry[];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsRemoveCommand);
    await getChannelsRuntimeBridge().sandboxChannelsRemove(
      args.sandboxName,
      channelMutationOptions(args.channel, flags),
    );
  }
}
