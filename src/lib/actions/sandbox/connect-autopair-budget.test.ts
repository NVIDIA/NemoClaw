// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "./connect-autopair-budget";

// Worst-case time the in-sandbox script can legitimately spend inside the outer
// spawnSync timer: one `devices list` plus up to MAX_APPROVALS `devices approve`
// calls, each at its full budget. Expressed in ms to compare against the outer cap.
const innerWorstCaseMs =
  (CONNECT_AUTO_PAIR_LIST_TIMEOUT_S +
    CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S * CONNECT_AUTO_PAIR_MAX_APPROVALS) *
  1000;

describe("connect auto-pair budget", () => {
  it("keeps the outer spawnSync cap above the worst-case inner runtime", () => {
    // If this ever inverts, the outer timeout can terminate a legitimately slow
    // approve mid-loop, stranding the allowlisted request (#4504).
    expect(CONNECT_AUTO_PAIR_TIMEOUT_MS).toBeGreaterThan(innerWorstCaseMs);
  });

  it("leaves headroom for shell/python startup before the inner loop begins", () => {
    // The outer timer starts at `sh` spawn, before proxy env is sourced and
    // python3 launches. The module documents 5 seconds of slack for that startup.
    expect(CONNECT_AUTO_PAIR_TIMEOUT_MS - innerWorstCaseMs).toBeGreaterThanOrEqual(5000);
  });

  it("uses positive, whole-number budgets", () => {
    for (const value of [
      CONNECT_AUTO_PAIR_MAX_APPROVALS,
      CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
      CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
      CONNECT_AUTO_PAIR_TIMEOUT_MS,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
