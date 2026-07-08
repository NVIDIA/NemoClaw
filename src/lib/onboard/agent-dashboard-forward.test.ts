// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { ensureAgentDashboardForward } from "./agent-dashboard-forward";

describe("ensureAgentDashboardForward", () => {
  it("preserves additional host-forward ports during dashboard refresh", () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "http://127.0.0.1:18789") => {
      const parsed = new URL(chatUiUrl);
      return Number(parsed.port);
    });

    expect(
      ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        preserveForwardPorts: [3978],
      }),
    ).toBe(18789);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:18789", {
      preserveSandboxPorts: [18789, 8642, 3978],
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8642", {
      preserveSandboxPorts: [18789, 8642, 3978],
      allowPortReallocation: false,
    });
  });
});
