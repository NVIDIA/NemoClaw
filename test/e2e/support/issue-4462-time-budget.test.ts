// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ISSUE_4462_AUTO_PAIR_DEADLINE_SECS,
  ISSUE_4462_INSTALL_TIMEOUT_MS,
  ISSUE_4462_LIVE_TIMEOUT_MS,
} from "../live/issue-4462-time-budget.ts";

describe("auto-pair watcher lifetime", () => {
  it("keeps the auto-pair watcher alive after a near-timeout install", () => {
    const watcherDeadlineMs = Number(ISSUE_4462_AUTO_PAIR_DEADLINE_SECS) * 1_000;
    const nearTimeoutInstallMs = ISSUE_4462_INSTALL_TIMEOUT_MS - 1;

    expect(watcherDeadlineMs).toBe(ISSUE_4462_LIVE_TIMEOUT_MS);
    expect(watcherDeadlineMs - nearTimeoutInstallMs).toBeGreaterThan(0);
  });
});
