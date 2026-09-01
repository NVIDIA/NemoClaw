// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createReadinessWaitOptions, runReadinessWait } from "../onboard/readiness-wait";

export function waitForAgentGatewayReady(options: {
  timeoutSeconds: number;
  probe: () => boolean;
  sleepSeconds: (seconds: number) => void;
  now?: () => number;
}): boolean {
  const waitOptions = createReadinessWaitOptions({
    budgetMs: Math.max(0, options.timeoutSeconds * 1000),
    maxIntervalMs: 3_000,
    now: options.now,
    sleep: (ms) => options.sleepSeconds(ms / 1000),
  });
  return waitOptions !== null && runReadinessWait(options.probe, waitOptions);
}
