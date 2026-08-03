// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runConnectAutoPairApprovalPass } from "./auto-pair-approval";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "./connect-autopair-budget";

describe("connect auto-pair approval pass", () => {
  it("uses the shared connect approval budget", () => {
    const runApprovalPass = vi.fn();

    runConnectAutoPairApprovalPass("alpha", runApprovalPass);

    expect(runApprovalPass).toHaveBeenCalledWith("alpha", {
      budget: {
        maxApprovals: CONNECT_AUTO_PAIR_MAX_APPROVALS,
        listTimeoutS: CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
        approveTimeoutS: CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
        timeoutMs: CONNECT_AUTO_PAIR_TIMEOUT_MS,
      },
    });
  });
});
