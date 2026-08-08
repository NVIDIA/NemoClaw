// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CHANNELS_STOP_START_SANDBOX_PREFIXES = Object.freeze({
  openclaw: "e2e-oc-ch-",
  hermes: "e2e-hm-ch-",
});

export function assertChannelsStopStartSandboxName(
  sandboxName: string,
  agent: keyof typeof CHANNELS_STOP_START_SANDBOX_PREFIXES,
): void {
  const prefix = CHANNELS_STOP_START_SANDBOX_PREFIXES[agent];
  if (!sandboxName.startsWith(prefix)) {
    throw new Error(
      `channels-stop-start live test is destructive and only accepts ${agent} sandbox names with prefix ${prefix}; got ${sandboxName}`,
    );
  }
}
