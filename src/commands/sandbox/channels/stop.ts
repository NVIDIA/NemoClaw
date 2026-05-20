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

export default class ChannelsStopCommand extends NemoClawCommand {
  static id = "sandbox:channels:stop";
  static strict = true;
  static summary = "Disable channel without wiping credentials";
  static description = "Disable a messaging channel while keeping credentials in the gateway.";
  static usage = ["<name> <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> sandbox channels stop alpha discord"];
  static publicDisplay = [
    {
      usage: "nemoclaw <name> channels stop",
      description: "Disable channel (keeps credentials)",
      flags: "<channel> [--dry-run]",
      group: "Messaging Channels",
      scope: "sandbox",
      order: 23,
    },
  ] satisfies readonly PublicCommandDisplayEntry[];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsStopCommand);
    await getChannelsRuntimeBridge().sandboxChannelsStop(
      args.sandboxName,
      channelMutationOptions(args.channel, flags),
    );
  }
}
