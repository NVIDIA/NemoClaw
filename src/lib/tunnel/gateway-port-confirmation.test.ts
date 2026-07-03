// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { confirmGatewayPortReleased } from "./gateway-port-confirmation";

describe("confirmGatewayPortReleased", () => {
  it("caps bind probes at twenty attempts when the port remains occupied", () => {
    let clock = 0;
    const probePortFree = vi.fn(() => false);

    const result = confirmGatewayPortReleased({
      port: 8080,
      timeoutMs: 100_000,
      pollIntervalMs: 1,
      now: () => clock++,
      sleep: () => {},
      probePortFree,
    });

    expect(result.released).toBe(false);
    expect(probePortFree).toHaveBeenCalledTimes(20);
  });
});
