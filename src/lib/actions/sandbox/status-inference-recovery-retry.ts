// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { retryUntilAsync } from "../../core/retry";

export const RECOVERED_INFERENCE_PROBE_ATTEMPTS = 3;
export const RECOVERED_INFERENCE_PROBE_DELAY_MS = 2_000;

export type InferenceRecoveryProbeDelay = (milliseconds: number) => Promise<void>;

export async function probeInferenceAfterGatewayRecovery<T>(options: {
  recoveredManagedGateway: boolean;
  probe: () => T | Promise<T>;
  accept: (result: T) => boolean;
  delay?: InferenceRecoveryProbeDelay;
}): Promise<T> {
  const attempts = options.recoveredManagedGateway ? RECOVERED_INFERENCE_PROBE_ATTEMPTS : 1;
  return retryUntilAsync(options.probe, {
    accept: options.accept,
    retryDelaysMs: Array.from({ length: attempts - 1 }, () => RECOVERED_INFERENCE_PROBE_DELAY_MS),
    sleep: options.delay ?? sleep,
  });
}
