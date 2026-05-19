// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  channelMutationOptions,
  channelMutationArgs,
  channelMutationFlags,
  getChannelsRuntimeBridge,
} from "../../../lib/sandbox/channels-command-support";

export default class ChannelsStartCommand extends NemoClawCommand {
  static id = "sandbox:channels:start";
  static strict = true;
  static summary = "Re-enable a stopped messaging channel";
  static description = "Re-enable a previously stopped messaging channel.";
  static usage = ["<name> <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> sandbox channels start alpha discord"];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsStartCommand);
    await getChannelsRuntimeBridge().sandboxChannelsStart(
      args.sandboxName,
      channelMutationOptions(args.channel, flags),
    );
  }
}
