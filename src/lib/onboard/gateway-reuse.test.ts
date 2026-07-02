// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createGatewayReuseHelpers } from "./gateway-reuse";

describe("createGatewayReuseHelpers", () => {
  it("resolves the gateway-name getter for each snapshot", () => {
    let gatewayName = "nemoclaw";
    const runCaptureOpenshell = vi.fn(() => "");
    const helpers = createGatewayReuseHelpers({
      gatewayName: () => gatewayName,
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    helpers.getGatewayReuseSnapshot();
    expect(runCaptureOpenshell).toHaveBeenCalledWith(["gateway", "info", "-g", "nemoclaw"], {
      ignoreError: true,
    });

    gatewayName = "nemoclaw-19080";
    helpers.getGatewayReuseSnapshot();
    expect(runCaptureOpenshell).toHaveBeenCalledWith(["gateway", "info", "-g", "nemoclaw-19080"], {
      ignoreError: true,
    });
  });
});
