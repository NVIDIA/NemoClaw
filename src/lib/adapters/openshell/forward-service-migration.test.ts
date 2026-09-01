// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { retireLegacySandboxForwards } from "./forward-service-migration";

describe("ForwardTcp legacy migration", () => {
  it("retires only registered NemoClaw ports for the selected sandbox", () => {
    const run = vi.fn(() => ({ status: 0 }));

    expect(
      retireLegacySandboxForwards("nemoclaw", "demo", [18_789], {
        capture: () => ({
          status: 0,
          output: [
            "SANDBOX  BIND       PORT   PID  STATUS",
            "demo     127.0.0.1  18789  10   running",
            "demo     127.0.0.1  19999  11   running",
            "other    127.0.0.1  18789  12   running",
          ].join("\n"),
        }),
        isReachable: () => false,
        run,
      }),
    ).toBe(1);

    expect(run).toHaveBeenCalledWith("nemoclaw", "demo", 18_789);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
