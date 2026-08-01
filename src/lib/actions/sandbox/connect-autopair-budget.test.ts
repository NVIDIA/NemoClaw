// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_PENDING_READ_ATTEMPTS,
  CONNECT_AUTO_PAIR_PENDING_READ_POLL_S,
  CONNECT_AUTO_PAIR_POST_TIMEOUT_OBSERVE_S,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "./connect-autopair-budget";

const ordinaryInnerWorstCaseMs =
  (CONNECT_AUTO_PAIR_LIST_TIMEOUT_S +
    CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S * CONNECT_AUTO_PAIR_MAX_APPROVALS) *
  1000;
const restoredCloneInnerWorstCaseMs =
  ((CONNECT_AUTO_PAIR_PENDING_READ_ATTEMPTS - 1) * CONNECT_AUTO_PAIR_PENDING_READ_POLL_S +
    CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S +
    CONNECT_AUTO_PAIR_POST_TIMEOUT_OBSERVE_S) *
  1000;
const innerWorstCaseMs = Math.max(ordinaryInnerWorstCaseMs, restoredCloneInnerWorstCaseMs);

describe("connect auto-pair budget", () => {
  it("keeps the outer spawnSync cap above the worst-case inner runtime", () => {
    // If this ever inverts, the outer timeout can terminate a legitimately slow
    // approve mid-loop, stranding the allowlisted request (#4504).
    expect(CONNECT_AUTO_PAIR_TIMEOUT_MS).toBeGreaterThan(innerWorstCaseMs);
  });

  it("keeps 10 seconds beyond inner work for OpenShell and interpreter startup", () => {
    expect(CONNECT_AUTO_PAIR_TIMEOUT_MS - innerWorstCaseMs).toBeGreaterThanOrEqual(10_000);
  });

  it("uses positive whole numbers for attempt, command, and outer budgets", () => {
    for (const value of [
      CONNECT_AUTO_PAIR_MAX_APPROVALS,
      CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
      CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
      CONNECT_AUTO_PAIR_PENDING_READ_ATTEMPTS,
      CONNECT_AUTO_PAIR_POST_TIMEOUT_OBSERVE_S,
      CONNECT_AUTO_PAIR_TIMEOUT_MS,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("uses a positive pending-read poll interval", () => {
    expect(CONNECT_AUTO_PAIR_PENDING_READ_POLL_S).toBeGreaterThan(0);
  });
});
