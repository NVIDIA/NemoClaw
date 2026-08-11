// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayReadinessProjection } from "../../readiness/gateway";
import { preparePreflightGatewayAuthority } from "./preflight-gateway-authority";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preflight gateway authority", () => {
  it("rejects a blocked refreshed projection before reuse or lifecycle handling (#7411)", async () => {
    const gatewayReadiness: GatewayReadinessProjection = {
      observations: [],
      capabilities: [],
      findings: [
        {
          id: "gateway.authority.conflict",
          severity: "blocking",
          summary: "Gateway authority conflicts with the selected endpoint.",
        },
      ],
      evidence: [],
    };
    const getGatewayReuseSnapshot = vi.fn(() => ({
      gatewayStatus: "",
      gwInfo: "",
      activeGatewayInfo: "",
      gatewayReuseState: "healthy" as const,
    }));
    const selectNamedGatewayForReuseIfNeeded = vi.fn();
    const refreshDockerDriverGatewayReuseState = vi.fn();
    const checkPortAvailable = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(
      preparePreflightGatewayAuthority({
        collectGatewayReadiness: async () => gatewayReadiness,
        ensureOpenshell: vi.fn(),
        persistTrustedGatewayOwner: vi.fn(),
        gatewayPort: 8080,
        portConflict: {
          checkPortAvailable,
          getGatewayPortCheckOptions: () => ({}),
          isDockerDriverGatewayPortListener: vi.fn(),
          exitProcess: process.exit,
        },
        getGatewayReuseSnapshot,
        selectNamedGatewayForReuseIfNeeded,
        refreshDockerDriverGatewayReuseState,
      }),
    ).rejects.toThrow("exit 1");

    expect(checkPortAvailable).not.toHaveBeenCalled();
    expect(getGatewayReuseSnapshot).not.toHaveBeenCalled();
    expect(selectNamedGatewayForReuseIfNeeded).not.toHaveBeenCalled();
    expect(refreshDockerDriverGatewayReuseState).not.toHaveBeenCalled();
  });
});
