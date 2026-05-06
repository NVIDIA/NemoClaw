// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import {
  buildChannelArgs,
  channelMutationArgs,
  channelMutationFlags,
  getChannelsRuntimeBridge,
} from "./common";

export default class ChannelsStopCommand extends Command {
  static id = "sandbox:channels:stop";
  static strict = true;
  static summary = "Disable channel without wiping credentials";
  static description = "Disable a messaging channel while keeping credentials in the gateway.";
  static usage = ["<name> channels stop <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> alpha channels stop discord"];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsStopCommand);
    await getChannelsRuntimeBridge().sandboxChannelsStop(
      args.sandboxName,
      buildChannelArgs(args.channel, flags),
    );
  }
}
