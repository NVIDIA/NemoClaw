// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { addSandboxChannel } from "../../../lib/actions/sandbox/policy-channel";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  channelMutationOptions,
  channelMutationArgs,
  channelMutationFlags,
} from "../../../lib/sandbox/channels-command-support";

export default class ChannelsAddCommand extends NemoClawCommand {
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
    await addSandboxChannel(args.sandboxName, channelMutationOptions(args.channel, flags));
  }
}
