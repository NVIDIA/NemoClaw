// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { dryRunFlag, forceFlag } from "../cli/common-flags";

export type ChannelMutationOptions = {
  channel?: string;
  dryRun?: boolean;
  force?: boolean;
};

const sandboxNameArg = Args.string({ name: "sandbox", description: "Sandbox name", required: true });
const channelArg = Args.string({ name: "channel", description: "Messaging channel", required: true });

export function channelMutationOptions(
  channel: string | undefined,
  flags: { "dry-run"?: boolean; force?: boolean },
): ChannelMutationOptions {
  return {
    channel,
    dryRun: Boolean(flags["dry-run"]),
    force: Boolean(flags.force),
  };
}

export const channelMutationArgs = {
  sandboxName: sandboxNameArg,
  channel: channelArg,
};

export const channelMutationFlags = {
  "dry-run": dryRunFlag("Preview the change without applying it"),
};

// `--force` is add-only: only `channels add` can overlap a messaging
// credential another sandbox already uses, so only it exposes the override.
// Keeping it off remove/start/stop avoids a misleading no-op flag and keeps
// CLI/docs flag parity (the shared object would surface --force everywhere).
export const channelAddFlags = {
  ...channelMutationFlags,
  force: forceFlag("Add the channel even if another sandbox already uses this credential"),
};
