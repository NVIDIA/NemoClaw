// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { findModelRouterPidForPort } from "./model-router-process";

describe("findModelRouterPidForPort", () => {
  it("returns the PID when a model-router proxy is found via proc scan (direct, #5169)", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: (p) =>
        p === 12345
          ? ["/home/user/.nemoclaw/model-router-venv/bin/model-router", "proxy", "--port", "4000"]
          : null,
      listProcPids: () => [1, 100, 12345, 99999],
    });
    expect(pid).toBe(12345);
  });

  it("returns the PID when model-router is Python-interpreted (args[1], #5169)", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: (p) =>
        p === 12345
          ? [
              "/home/user/.nemoclaw/model-router-venv/bin/python",
              "/home/user/.nemoclaw/model-router-venv/bin/model-router",
              "proxy",
              "--port",
              "4000",
            ]
          : null,
      listProcPids: () => [1, 100, 12345, 99999],
    });
    expect(pid).toBe(12345);
  });

  it("returns null when no model-router is found on that port", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: (p) =>
        p === 12345
          ? ["/home/user/.nemoclaw/model-router-venv/bin/model-router", "proxy", "--port", "9999"]
          : null,
      listProcPids: () => [12345],
    });
    expect(pid).toBe(null);
  });

  it("returns null when listProcPids returns an empty list", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: () => null,
      listProcPids: () => [],
    });
    expect(pid).toBe(null);
  });

  it("returns the first matching PID when multiple model-routers are present", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: (p) => {
        if (p === 100) return ["/opt/model-router", "proxy", "--port", "4000"];
        if (p === 200) return ["/opt/model-router", "proxy", "--port", "4000"];
        return null;
      },
      listProcPids: () => [50, 100, 200],
    });
    expect(pid).toBe(100);
  });
});
