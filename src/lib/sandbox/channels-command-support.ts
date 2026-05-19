// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { dryRunFlag } from "../cli/common-flags";

export type ChannelMutationOptions = {
  channel?: string;
  dryRun?: boolean;
};

type ChannelsRuntimeBridge = {
  sandboxChannelsAdd: (sandboxName: string, options?: ChannelMutationOptions) => Promise<void>;
  sandboxChannelsRemove: (sandboxName: string, options?: ChannelMutationOptions) => Promise<void>;
  sandboxChannelsStart: (sandboxName: string, options?: ChannelMutationOptions) => Promise<void>;
  sandboxChannelsStop: (sandboxName: string, options?: ChannelMutationOptions) => Promise<void>;
};

let runtimeBridgeFactory = (): ChannelsRuntimeBridge => {
  const actions = require("../actions/sandbox/policy-channel") as {
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

export function channelMutationOptions(
  channel: string | undefined,
  flags: { "dry-run"?: boolean },
): ChannelMutationOptions {
  return {
    channel,
    dryRun: Boolean(flags["dry-run"]),
  };
}

export const channelMutationArgs = {
  sandboxName: sandboxNameArg,
  channel: channelArg,
};

export const channelMutationFlags = {
  "dry-run": dryRunFlag("Preview the change without applying it"),
};
