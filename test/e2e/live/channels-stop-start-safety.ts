// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CHANNELS_STOP_START_SANDBOX_PREFIX = "e2e-channels-stop-start-";

export function assertChannelsStopStartSandboxName(sandboxName: string): void {
  if (!sandboxName.startsWith(CHANNELS_STOP_START_SANDBOX_PREFIX)) {
    throw new Error(
      `channels-stop-start live test is destructive and only accepts sandbox names with prefix ${CHANNELS_STOP_START_SANDBOX_PREFIX}; got ${sandboxName}`,
    );
  }
}
