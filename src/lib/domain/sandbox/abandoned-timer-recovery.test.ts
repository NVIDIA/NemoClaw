// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decideAbandonedTimerRecoveryToken } from "./abandoned-timer-recovery";

describe("abandoned timer recovery", () => {
  it.each([
    [
      "unchanged snapshot",
      { key: "a:1:", token: "a".repeat(32) },
      { key: "a:1:", token: "a".repeat(32) },
      "a".repeat(32),
    ],
    [
      "replacement key",
      { key: "a:1:", token: "a".repeat(32) },
      { key: "b:1:", token: "b".repeat(32) },
      undefined,
    ],
    ["missing confirm", { key: "a:1:", token: "a".repeat(32) }, null, undefined],
  ] as const)("admits recovery only for an %s", (_name, aged, current, token) => {
    expect(decideAbandonedTimerRecoveryToken(aged, current)).toBe(token);
  });
});
