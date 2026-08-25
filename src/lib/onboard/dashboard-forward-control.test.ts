// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  captureLiveSiblingDashboardForwards,
  createSandboxForwardStopper,
  reconcileSiblingDashboardForwards,
} from "./dashboard-forward-control";

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
});

describe("sibling dashboard forward preservation", () => {
  const header = "SANDBOX BIND PORT PID STATUS";
  const alpha = { sandboxName: "alpha", bind: "127.0.0.1", port: "18789" };
  const beta = { sandboxName: "beta", bind: "127.0.0.1", port: "18790" };

  it("restores a sibling that becomes dead while starting the target forward", () => {
    const before = `${header}\nalpha 127.0.0.1 18789 101 running`;
    let restored = false;
    const fetch = vi.fn(() =>
      restored
        ? `${header}\nalpha 127.0.0.1 18789 303 running\nbeta 127.0.0.1 18790 202 running`
        : `${header}\nalpha 127.0.0.1 18789 101 dead\nbeta 127.0.0.1 18790 202 running`,
    );
    const restore = vi.fn(() => {
      restored = true;
      return { ok: true };
    });

    expect(
      reconcileSiblingDashboardForwards({
        preserved: captureLiveSiblingDashboardForwards(before, "beta"),
        target: beta,
        fetch,
        restore,
      }),
    ).toEqual({ ok: true });
    expect(restore).toHaveBeenCalledExactlyOnceWith(alpha);
  });

  it("does not revive a sibling that was already dead before target startup", () => {
    const before = `${header}\nalpha 127.0.0.1 18789 101 dead`;
    const snapshot = `${header}\nbeta 127.0.0.1 18790 202 running`;
    const restore = vi.fn(() => ({ ok: true }));

    expect(
      reconcileSiblingDashboardForwards({
        preserved: captureLiveSiblingDashboardForwards(before, "beta"),
        target: beta,
        fetch: () => snapshot,
        restore,
      }),
    ).toEqual({ ok: true });
    expect(restore).not.toHaveBeenCalled();
  });

  it("fails when restoring a sibling kills the newly started target", () => {
    const before = `${header}\nalpha 127.0.0.1 18789 101 running`;
    let restored = false;
    const fetch = () =>
      restored
        ? `${header}\nalpha 127.0.0.1 18789 303 running\nbeta 127.0.0.1 18790 202 dead`
        : `${header}\nalpha 127.0.0.1 18789 101 dead\nbeta 127.0.0.1 18790 202 running`;

    expect(
      reconcileSiblingDashboardForwards({
        preserved: captureLiveSiblingDashboardForwards(before, "beta"),
        target: beta,
        fetch,
        restore: () => {
          restored = true;
          return { ok: true };
        },
      }),
    ).toEqual({
      ok: false,
      diagnostic: "Forward beta:18790 did not remain live after sibling reconciliation.",
    });
  });
});
