// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { confirmGatewayPortReleased } from "./gateway-port-confirmation";

describe("confirmGatewayPortReleased", () => {
  it("caps failed listener inspections at twenty without spawning a bind probe", () => {
    let clock = 0;
    const listeningPids = vi.fn(() => null);
    const probePortFree = vi.fn(() => true);

    const result = confirmGatewayPortReleased({
      port: 8080,
      timeoutMs: 100_000,
      pollIntervalMs: 1,
      now: () => clock++,
      sleep: () => {},
      probePortFree,
      listeningPids,
    });

    expect(result.released).toBe(false);
    expect(listeningPids).toHaveBeenCalledTimes(20);
    expect(probePortFree).not.toHaveBeenCalled();
  });

  it("runs the independent bind probe once after listeners clear", () => {
    let clock = 0;
    const listeningPids = vi.fn().mockReturnValueOnce([4242]).mockReturnValue([]);
    const probePortFree = vi.fn(() => true);

    const result = confirmGatewayPortReleased({
      port: 8080,
      timeoutMs: 100_000,
      pollIntervalMs: 1,
      now: () => clock++,
      sleep: () => {},
      probePortFree,
      listeningPids,
    });

    expect(result).toEqual({ released: true, remaining: [] });
    expect(listeningPids).toHaveBeenCalledTimes(2);
    expect(probePortFree).toHaveBeenCalledTimes(1);
  });
});
