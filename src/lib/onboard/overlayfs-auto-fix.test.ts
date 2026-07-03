// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createOverlayfsAutoFix } from "./overlayfs-auto-fix";

describe("overlayfs auto-fix", () => {
  it("builds and caches the selected snapshotter image for affected hosts", () => {
    const ensurePatchedClusterImage = vi.fn(() => "nemoclaw-cluster:patched");
    const log = vi.fn();
    const applyFix = createOverlayfsAutoFix({
      assessHost: () => ({ hasNestedOverlayConflict: true }),
      ensurePatchedClusterImage,
      env: { NEMOCLAW_OVERLAY_SNAPSHOTTER: "native" },
      log,
    });

    expect(applyFix("ghcr.io/nvidia/openshell/cluster:1")).toBe("nemoclaw-cluster:patched");
    expect(applyFix("ghcr.io/nvidia/openshell/cluster:1")).toBe("nemoclaw-cluster:patched");
    expect(ensurePatchedClusterImage).toHaveBeenCalledOnce();
    expect(ensurePatchedClusterImage).toHaveBeenCalledWith({
      upstreamImage: "ghcr.io/nvidia/openshell/cluster:1",
      snapshotter: "native",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("driver=unknown"));
  });

  it("caches each effective snapshotter choice independently", () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_OVERLAY_SNAPSHOTTER: "native" };
    const ensurePatchedClusterImage = vi.fn(
      ({ snapshotter }: { snapshotter: "fuse-overlayfs" | "native" }) =>
        `nemoclaw-cluster:${snapshotter}`,
    );
    const applyFix = createOverlayfsAutoFix({
      assessHost: () => ({ hasNestedOverlayConflict: true, dockerStorageDriver: "overlayfs" }),
      ensurePatchedClusterImage,
      env,
      log: vi.fn(),
    });

    expect(applyFix("upstream:1")).toBe("nemoclaw-cluster:native");
    env.NEMOCLAW_OVERLAY_SNAPSHOTTER = "fuse-overlayfs";
    expect(applyFix("upstream:1")).toBe("nemoclaw-cluster:fuse-overlayfs");
    env.NEMOCLAW_OVERLAY_SNAPSHOTTER = "native";
    expect(applyFix("upstream:1")).toBe("nemoclaw-cluster:native");

    expect(ensurePatchedClusterImage).toHaveBeenCalledTimes(2);
    expect(ensurePatchedClusterImage).toHaveBeenNthCalledWith(1, {
      upstreamImage: "upstream:1",
      snapshotter: "native",
    });
    expect(ensurePatchedClusterImage).toHaveBeenNthCalledWith(2, {
      upstreamImage: "upstream:1",
      snapshotter: "fuse-overlayfs",
    });
  });

  it("skips unaffected hosts and explicit opt-outs", () => {
    const ensurePatchedClusterImage = vi.fn();
    const assessHost = vi.fn(() => ({
      hasNestedOverlayConflict: false,
      dockerStorageDriver: "overlay2",
    }));
    const affectedHost = vi.fn(() => ({
      hasNestedOverlayConflict: true,
      dockerStorageDriver: "overlayfs",
    }));
    expect(
      createOverlayfsAutoFix({ assessHost, ensurePatchedClusterImage })(
        "ghcr.io/nvidia/openshell/cluster:1",
      ),
    ).toBeNull();
    expect(
      createOverlayfsAutoFix({
        assessHost: affectedHost,
        ensurePatchedClusterImage,
        env: { NEMOCLAW_DISABLE_OVERLAY_FIX: "1" },
      })("ghcr.io/nvidia/openshell/cluster:1"),
    ).toBeNull();
    expect(affectedHost).not.toHaveBeenCalled();
    expect(ensurePatchedClusterImage).not.toHaveBeenCalled();
  });

  it("falls back to the upstream image when assessment or patching fails", () => {
    const warn = vi.fn();
    const error = vi.fn();
    const assessmentFailure = createOverlayfsAutoFix({
      assessHost: () => {
        throw new Error("docker unavailable");
      },
      ensurePatchedClusterImage: vi.fn(),
      warn,
    });
    expect(assessmentFailure("upstream:1")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("docker unavailable"));

    const patchFailure = createOverlayfsAutoFix({
      assessHost: () => ({ hasNestedOverlayConflict: true, dockerStorageDriver: "overlayfs" }),
      ensurePatchedClusterImage: () => {
        throw new Error("build failed");
      },
      log: vi.fn(),
      error,
    });
    expect(patchFailure("upstream:1")).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("build failed"));
  });
});
