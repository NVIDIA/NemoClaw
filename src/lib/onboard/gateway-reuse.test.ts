// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createGatewayReuseHelpers } from "./gateway-reuse";

describe("gateway reuse inspection", () => {
  it("bounds every OpenShell metadata probe so a foreign listener cannot stall preflight (#6752)", () => {
    const runCaptureOpenshell = vi.fn((_args: string[], _options?: Record<string, unknown>) => "");
    const helpers = createGatewayReuseHelpers({
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    helpers.getGatewayReuseSnapshot();

    expect(runCaptureOpenshell).toHaveBeenCalledTimes(3);
    for (const [, options] of runCaptureOpenshell.mock.calls) {
      expect(options).toMatchObject({ ignoreError: true, timeout: 5_000 });
    }
  });
});
