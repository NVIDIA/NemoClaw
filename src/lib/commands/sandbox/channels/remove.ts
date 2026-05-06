// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import {
  buildChannelArgs,
  channelMutationArgs,
  channelMutationFlags,
  getChannelsRuntimeBridge,
} from "./common";

export default class ChannelsRemoveCommand extends Command {
  static id = "sandbox:channels:remove";
  static strict = true;
  static summary = "Clear messaging channel credentials and rebuild";
  static description = "Remove credentials for a messaging channel and queue a sandbox rebuild.";
  static usage = ["<name> channels remove <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> alpha channels remove slack --dry-run"];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsRemoveCommand);
    await getChannelsRuntimeBridge().sandboxChannelsRemove(
      args.sandboxName,
      buildChannelArgs(args.channel, flags),
    );
  }
}
