// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

export function createVirtualClock(startMs = 1_000_000_000_000) {
  let currentMs = startMs;
  const advance = (seconds: number) => {
    currentMs += Math.max(0, seconds) * 1000;
  };
  return {
    advance,
    now: () => currentMs,
    sleeper: vi.fn(advance),
  };
}
