// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import {
  buildChannelArgs,
  channelMutationArgs,
  channelMutationFlags,
  getChannelsRuntimeBridge,
} from "./common";

export default class ChannelsAddCommand extends Command {
  static id = "sandbox:channels:add";
  static strict = true;
  static summary = "Save messaging channel credentials and rebuild";
  static description = "Store credentials for a messaging channel and queue a sandbox rebuild.";
  static usage = ["<name> <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> sandbox channels add alpha telegram"];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsAddCommand);
    await getChannelsRuntimeBridge().sandboxChannelsAdd(
      args.sandboxName,
      buildChannelArgs(args.channel, flags),
    );
  }
}
