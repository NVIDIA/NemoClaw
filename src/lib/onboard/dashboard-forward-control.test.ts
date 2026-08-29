// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSandboxForwardStopper } from "./dashboard-forward-control";

describe("createSandboxForwardStopper", () => {
  it("skips the stop when the forward-list capture fails (#8522)", () => {
    const runOpenshell = vi.fn();
    const runCaptureOpenshell = vi.fn().mockReturnValue(null);
    const stopForward = createSandboxForwardStopper({
      runOpenshell,
      runCaptureOpenshell,
      sandboxName: "my-sandbox",
    });

    expect(stopForward(18789)).toBe("list-failed");
    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      ["forward", "list"],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("rechecks policy authority after the forward read and before stop (#9833)", () => {
    const runOpenshell = vi.fn();
    const runCaptureOpenshell = vi.fn().mockReturnValue("");
    const revalidatePolicyAuthority = vi.fn(() => {
      throw new Error("policy authority changed");
    });
    const stopForward = createSandboxForwardStopper({
      runOpenshell,
      runCaptureOpenshell,
      sandboxName: "my-sandbox",
      revalidatePolicyAuthority,
    });

    expect(() => stopForward(18789)).toThrow("policy authority changed");
    expect(runCaptureOpenshell).toHaveBeenCalledOnce();
    expect(revalidatePolicyAuthority).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
