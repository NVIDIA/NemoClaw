// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { retryUntil } from "../core/retry";
import { sleepSeconds } from "../core/wait";

export const CONTAINER_CHECK_MAX_ATTEMPTS = 3;
export const CONTAINER_CHECK_RETRY_DELAY_SECS = 2;

export type LocalProviderContainerCapture = (
  command: readonly string[],
  options: { ignoreError: true },
) => string;

export function probeLocalProviderContainerReachability(options: {
  command: readonly string[];
  capture: LocalProviderContainerCapture;
  isHealthy: (endpoint: string, output: string) => boolean;
  sleepSeconds?: (seconds: number) => void;
}): string {
  const endpoint = options.command.at(-1) ?? "";
  const sleep = options.sleepSeconds ?? sleepSeconds;
  return retryUntil(() => options.capture(options.command, { ignoreError: true }), {
    accept: (output) => options.isHealthy(endpoint, output),
    retryDelaysMs: Array.from(
      { length: CONTAINER_CHECK_MAX_ATTEMPTS - 1 },
      () => CONTAINER_CHECK_RETRY_DELAY_SECS * 1_000,
    ),
    sleep: (milliseconds) => sleep(milliseconds / 1_000),
  });
}
