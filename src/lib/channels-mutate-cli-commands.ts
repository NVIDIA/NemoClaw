// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapters covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

type ChannelsRuntimeBridge = {
  sandboxChannelsAdd: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsRemove: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsStart: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsStop: (sandboxName: string, args?: string[]) => Promise<void>;
};

let runtimeBridgeFactory = (): ChannelsRuntimeBridge => {
  const actions = require("./policy-channel-actions") as {
    addSandboxChannel: ChannelsRuntimeBridge["sandboxChannelsAdd"];
    removeSandboxChannel: ChannelsRuntimeBridge["sandboxChannelsRemove"];
    startSandboxChannel: ChannelsRuntimeBridge["sandboxChannelsStart"];
    stopSandboxChannel: ChannelsRuntimeBridge["sandboxChannelsStop"];
  };
  return {
    sandboxChannelsAdd: actions.addSandboxChannel,
    sandboxChannelsRemove: actions.removeSandboxChannel,
    sandboxChannelsStart: actions.startSandboxChannel,
    sandboxChannelsStop: actions.stopSandboxChannel,
  };
};

export function setChannelsRuntimeBridgeFactoryForTest(
  factory: () => ChannelsRuntimeBridge,
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): ChannelsRuntimeBridge {
  return runtimeBridgeFactory();
}

const sandboxNameArg = Args.string({ name: "sandbox", description: "Sandbox name", required: true });
const channelArg = Args.string({ name: "channel", description: "Messaging channel", required: true });

function buildArgs(channel: string | undefined, flags: { "dry-run"?: boolean }): string[] {
  const args: string[] = [];
  if (channel) args.push(channel);
  if (flags["dry-run"]) args.push("--dry-run");
  return args;
}

const channelMutationArgs = {
  sandboxName: sandboxNameArg,
  channel: channelArg,
};
const channelMutationFlags = {
  help: Flags.help({ char: "h" }),
  "dry-run": Flags.boolean({ description: "Preview the change without applying it" }),
};

export class ChannelsAddCommand extends Command {
  static id = "sandbox:channels:add";
  static strict = true;
  static summary = "Save messaging channel credentials and rebuild";
  static description = "Store credentials for a messaging channel and queue a sandbox rebuild.";
  static usage = ["<name> channels add <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> alpha channels add telegram"];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsAddCommand);
    await getRuntimeBridge().sandboxChannelsAdd(args.sandboxName, buildArgs(args.channel, flags));
  }
}

export class ChannelsRemoveCommand extends Command {
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
    await getRuntimeBridge().sandboxChannelsRemove(args.sandboxName, buildArgs(args.channel, flags));
  }
}

export class ChannelsStopCommand extends Command {
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
    await getRuntimeBridge().sandboxChannelsStop(args.sandboxName, buildArgs(args.channel, flags));
  }
}

export class ChannelsStartCommand extends Command {
  static id = "sandbox:channels:start";
  static strict = true;
  static summary = "Re-enable a stopped messaging channel";
  static description = "Re-enable a previously stopped messaging channel.";
  static usage = ["<name> channels start <channel> [--dry-run]"];
  static examples = ["<%= config.bin %> alpha channels start discord"];
  static args = channelMutationArgs;
  static flags = channelMutationFlags;

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ChannelsStartCommand);
    await getRuntimeBridge().sandboxChannelsStart(args.sandboxName, buildArgs(args.channel, flags));
  }
}
