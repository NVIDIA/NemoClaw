// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  legacySandboxForwardPid,
  retireLegacySandboxForwards,
} from "./forward-service-migration";

describe("ForwardTcp legacy migration", () => {
  it("names the listed process for the exact sandbox and port only (#11149)", () => {
    const output = [
      "SANDBOX  BIND       PORT   PID  STATUS",
      "demo     127.0.0.1  18789  10   running",
      "demo     127.0.0.1  19999  11   running",
      "demo     127.0.0.1  20000  -    running",
      "other    127.0.0.1  18789  12   running",
    ].join("\n");

    expect(legacySandboxForwardPid(output, "demo", 18_789)).toBe(10);
    expect(legacySandboxForwardPid(output, "demo", 20_000)).toBeNull();
    expect(legacySandboxForwardPid(output, "demo", 19_000)).toBeUndefined();
    expect(legacySandboxForwardPid(output, "other", 19_999)).toBeUndefined();
    expect(legacySandboxForwardPid(null, "demo", 18_789)).toBeUndefined();
  });

  it("retires only registered NemoClaw ports for the selected sandbox", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const assertAuthority = vi.fn();

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
        assertAuthority,
      }),
    ).toBe(1);

    expect(assertAuthority).toHaveBeenCalledWith([18_789]);
    expect(run).toHaveBeenCalledWith("nemoclaw", "demo", 18_789);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not stop a legacy forward when ownership authority is ambiguous", () => {
    const run = vi.fn(() => ({ status: 0 }));

    expect(() =>
      retireLegacySandboxForwards("nemoclaw", "demo", [18_789], {
        capture: () => ({
          status: 0,
          output: "SANDBOX BIND PORT PID STATUS\ndemo 127.0.0.1 18789 10 running",
        }),
        isReachable: () => true,
        run,
        assertAuthority: () => {
          throw new Error("ambiguous gateway owner");
        },
      }),
    ).toThrow(/ambiguous gateway owner/u);
    expect(run).not.toHaveBeenCalled();
  });
});
