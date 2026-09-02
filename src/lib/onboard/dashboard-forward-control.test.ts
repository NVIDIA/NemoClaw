// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  captureLiveSiblingDashboardForwards,
  createSandboxForwardStopper,
  mergePreservedDashboardForwards,
  reconcileSiblingDashboardForwards,
  revalidatePreservedDashboardForward,
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

  it("rechecks sandbox identity after the forward read and before stop (#9833)", () => {
    const runOpenshell = vi.fn();
    const runCaptureOpenshell = vi.fn().mockReturnValue("");
    const revalidateSandboxIdentity = vi.fn(() => {
      throw new Error("sandbox identity changed");
    });
    const stopForward = createSandboxForwardStopper({
      runOpenshell,
      runCaptureOpenshell,
      sandboxName: "my-sandbox",
      revalidateSandboxIdentity,
    });

    expect(() => stopForward(18789)).toThrow("sandbox identity changed");
    expect(runCaptureOpenshell).toHaveBeenCalledOnce();
    expect(revalidateSandboxIdentity).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});

describe("sibling dashboard forward preservation", () => {
  const header = "SANDBOX BIND PORT PID STATUS";
  const alphaOwner = {
    name: "alpha",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-alpha",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    openshellDriver: "podman",
  };
  const getSandbox = (name: string) => (name === "alpha" ? alphaOwner : null);
  const alpha = {
    sandboxName: "alpha",
    bind: "127.0.0.1",
    port: "18789",
    pid: 101,
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-alpha",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    openshellDriver: "podman",
  };
  const beta = { sandboxName: "beta", bind: "127.0.0.1", port: "18790" };

  it("restores a sibling that becomes dead while starting the target forward", () => {
    const beforeCreate = `${header}\nalpha 127.0.0.1 18789 101 running`;
    const beforeTargetStart = `${header}\nalpha 127.0.0.1 18789 101 dead`;
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
        preserved: mergePreservedDashboardForwards(
          captureLiveSiblingDashboardForwards(beforeCreate, "beta", getSandbox),
          captureLiveSiblingDashboardForwards(beforeTargetStart, "beta", getSandbox),
        ),
        target: beta,
        fetch,
        revalidateLive: (forward, snapshot) =>
          revalidatePreservedDashboardForward(forward, snapshot, getSandbox),
        restore,
      }),
    ).toEqual({ ok: true });
    expect(restore).toHaveBeenCalledExactlyOnceWith(alpha);
  });

  it("deduplicates a sibling that remains live across create and finalization", () => {
    const live = `${header}\nalpha 127.0.0.1 18789 101 running`;

    expect(
      mergePreservedDashboardForwards(
        captureLiveSiblingDashboardForwards(live, "beta", getSandbox),
        captureLiveSiblingDashboardForwards(live, "beta", getSandbox),
      ),
    ).toEqual([alpha]);
  });

  it("rejects an unbounded pre-create sibling snapshot", () => {
    const forwards = Array.from({ length: 129 }, (_, index) => ({
      bind: "127.0.0.1",
      gatewayName: "nemoclaw",
      lifecycleGeneration: `generation-${index}`,
      lifecycleLiveIdentityFingerprint: index.toString(16).padStart(64, "0"),
      openshellDriver: "podman",
      pid: 1_000 + index,
      port: String(20_000 + index),
      sandboxName: `sibling-${index}`,
    }));

    expect(() => mergePreservedDashboardForwards(forwards)).toThrow(
      "Merged sibling dashboard-forward snapshot exceeds its bound.",
    );
  });

  it("does not revive a sibling that was already dead before target startup", () => {
    const before = `${header}\nalpha 127.0.0.1 18789 101 dead`;
    const snapshot = `${header}\nbeta 127.0.0.1 18790 202 running`;
    const restore = vi.fn(() => ({ ok: true }));

    expect(
      reconcileSiblingDashboardForwards({
        preserved: captureLiveSiblingDashboardForwards(before, "beta", getSandbox),
        target: beta,
        fetch: () => snapshot,
        revalidateLive: (forward, live) =>
          revalidatePreservedDashboardForward(forward, live, getSandbox),
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
        preserved: captureLiveSiblingDashboardForwards(before, "beta", getSandbox),
        target: beta,
        fetch,
        revalidateLive: (forward, snapshot) =>
          revalidatePreservedDashboardForward(forward, snapshot, getSandbox),
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

  it("rejects a same-name replacement before restoring its dead forward", () => {
    const before = `${header}\nalpha 127.0.0.1 18789 101 running`;
    const preserved = captureLiveSiblingDashboardForwards(before, "beta", getSandbox)[0]!;

    expect(
      revalidatePreservedDashboardForward(
        preserved,
        `${header}\nalpha 127.0.0.1 18789 101 dead`,
        () => ({ ...alphaOwner, lifecycleGeneration: "generation-replacement" }),
      ),
    ).toBe(false);
  });

  it("rejects an already-live tuple owned by a replacement forward process", () => {
    const preserved = captureLiveSiblingDashboardForwards(
      `${header}\nalpha 127.0.0.1 18789 101 running`,
      "beta",
      getSandbox,
    );
    const replacement =
      `${header}\nalpha 127.0.0.1 18789 303 running\n` + "beta 127.0.0.1 18790 202 running";
    const restore = vi.fn(() => ({ ok: true }));

    expect(
      reconcileSiblingDashboardForwards({
        preserved,
        target: beta,
        fetch: () => replacement,
        revalidateLive: (forward, snapshot) =>
          revalidatePreservedDashboardForward(forward, snapshot, getSandbox),
        restore,
      }),
    ).toEqual({
      ok: false,
      diagnostic: "Forward alpha:18789 changed live ownership.",
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects an already-live tuple after its registry generation changes", () => {
    const live = `${header}\nalpha 127.0.0.1 18789 101 running`;
    const preserved = captureLiveSiblingDashboardForwards(live, "beta", getSandbox);
    const replacementOwner = () => ({
      ...alphaOwner,
      lifecycleGeneration: "generation-replacement",
    });

    expect(
      reconcileSiblingDashboardForwards({
        preserved,
        target: beta,
        fetch: () => `${live}\nbeta 127.0.0.1 18790 202 running`,
        revalidateLive: (forward, snapshot) =>
          revalidatePreservedDashboardForward(forward, snapshot, replacementOwner),
        restore: vi.fn(() => ({ ok: true })),
      }),
    ).toEqual({
      ok: false,
      diagnostic: "Forward alpha:18789 changed live ownership.",
    });
  });
});
