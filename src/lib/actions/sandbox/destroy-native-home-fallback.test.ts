// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { wipeAgentNativeHome } from "./destroy-execution";

describe("native-home destroy fallback", () => {
  it("uses provider-owned stopped-volume cleanup when neither live transport can execute", () => {
    const runOpenshell = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "sandbox is not running",
    }));
    const runPrivileged = vi.fn(() => ({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("container is not running"),
    }));
    const clearStoppedNativeHome = vi.fn(() => ({ cleared: true as const }));

    expect(() =>
      wipeAgentNativeHome(
        "alpha",
        "openclaw",
        runOpenshell,
        undefined,
        runPrivileged,
        clearStoppedNativeHome,
      ),
    ).not.toThrow();
    expect(runPrivileged).toHaveBeenCalledOnce();
    expect(clearStoppedNativeHome).toHaveBeenCalledWith("/sandbox/.openclaw", []);
  });

  it("does not bypass an unsafe native-tree refusal", () => {
    const runOpenshell = vi.fn(() => ({
      status: 21,
      stdout: "",
      stderr: "unsafe protected native-home ancestor",
    }));
    const runPrivileged = vi.fn();
    const clearStoppedNativeHome = vi.fn();

    expect(() =>
      wipeAgentNativeHome(
        "alpha",
        "openclaw",
        runOpenshell,
        undefined,
        runPrivileged,
        clearStoppedNativeHome,
      ),
    ).toThrow("unsafe protected native-home ancestor");
    expect(runPrivileged).not.toHaveBeenCalled();
    expect(clearStoppedNativeHome).not.toHaveBeenCalled();
  });
});
