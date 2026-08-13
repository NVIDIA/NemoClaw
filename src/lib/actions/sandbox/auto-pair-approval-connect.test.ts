// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runConnectAutoPairApprovalPass,
  runSandboxAutoPairApprovalPass,
} from "./auto-pair-approval";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "./connect-autopair-budget";

describe("connect auto-pair approval pass", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the shared connect approval budget", () => {
    const runApprovalPass = vi.fn();

    runConnectAutoPairApprovalPass("alpha", "nemoclaw-8091", runApprovalPass);

    expect(runApprovalPass).toHaveBeenCalledWith("alpha", {
      budget: {
        maxApprovals: CONNECT_AUTO_PAIR_MAX_APPROVALS,
        listTimeoutS: CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
        approveTimeoutS: CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
        timeoutMs: CONNECT_AUTO_PAIR_TIMEOUT_MS,
      },
      gatewayName: "nemoclaw-8091",
    });
  });

  it("pins sandbox exec to the owning OpenShell gateway despite ambient gateway drift (#8942)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
    const spawn = vi.fn((_binary: string, _args: readonly string[]) => ({
      status: 0,
      signal: null,
      stdout: "__NEMOCLAW_AUTO_PAIR_APPROVED__=0\n",
      stderr: "",
    }));

    runSandboxAutoPairApprovalPass(
      "alpha",
      { capture: true, gatewayName: "nemoclaw-8091" },
      { getOpenshellBinary: () => "openshell", spawnSync: spawn as never },
    );

    expect(process.env.OPENSHELL_GATEWAY).toBe("ambient-sibling");
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8091",
      "--",
      "sh",
      "-s",
    ]);
  });
});
