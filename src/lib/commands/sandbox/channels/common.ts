// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

type ChannelsRuntimeBridge = {
  sandboxChannelsAdd: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsRemove: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsStart: (sandboxName: string, args?: string[]) => Promise<void>;
  sandboxChannelsStop: (sandboxName: string, args?: string[]) => Promise<void>;
};

let runtimeBridgeFactory = (): ChannelsRuntimeBridge => {
  const actions = require("../../../policy-channel-actions") as {
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

export function getChannelsRuntimeBridge(): ChannelsRuntimeBridge {
  return runtimeBridgeFactory();
}

const sandboxNameArg = Args.string({ name: "sandbox", description: "Sandbox name", required: true });
const channelArg = Args.string({ name: "channel", description: "Messaging channel", required: true });

export function buildChannelArgs(
  channel: string | undefined,
  flags: { "dry-run"?: boolean },
): string[] {
  const args: string[] = [];
  if (channel) args.push(channel);
  if (flags["dry-run"]) args.push("--dry-run");
  return args;
}

export const channelMutationArgs = {
  sandboxName: sandboxNameArg,
  channel: channelArg,
};

export const channelMutationFlags = {
  help: Flags.help({ char: "h" }),
  "dry-run": Flags.boolean({ description: "Preview the change without applying it" }),
};
