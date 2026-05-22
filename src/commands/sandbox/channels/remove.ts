// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { removeSandboxChannel } from "../../../lib/actions/sandbox/policy-channel";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  channelMutationOptions,
  channelMutationArgs,
  channelMutationFlags,
} from "../../../lib/sandbox/channels-command-support";

export default class ChannelsRemoveCommand extends NemoClawCommand {
  static id = "sandbox:channels:remove";
  static strict = true;
  static summary = "Clear messaging channel credentials and rebuild";
  static description = "Remove credentials for a messaging channel and queue a sandbox rebuild.";
  static usage = ["<name> <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> sandbox channels remove alpha slack --dry-run"];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsRemoveCommand);
    await removeSandboxChannel(args.sandboxName, channelMutationOptions(args.channel, flags));
  }
}
