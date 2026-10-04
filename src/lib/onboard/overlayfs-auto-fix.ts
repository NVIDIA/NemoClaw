// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type OverlayfsHostAssessment = {
  hasNestedOverlayConflict: boolean;
  dockerStorageDriver?: string | null;
};

export function createOverlayfsAutoFix(deps: {
  assessHost: () => OverlayfsHostAssessment;
  ensurePatchedClusterImage: (options: {
    upstreamImage: string;
    snapshotter: "fuse-overlayfs" | "native";
  }) => string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}): (upstreamImage: string) => string | null {
  const cache = new Map<string, string | null>();
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const error = deps.error ?? console.error;

  return (upstreamImage) => {
    if (env.NEMOCLAW_DISABLE_OVERLAY_FIX === "1") return null;

    const requestedSnapshotter = (env.NEMOCLAW_OVERLAY_SNAPSHOTTER || "").trim().toLowerCase();
    let snapshotter: "fuse-overlayfs" | "native" = "fuse-overlayfs";
    if (requestedSnapshotter === "native" || requestedSnapshotter === "fuse-overlayfs") {
      snapshotter = requestedSnapshotter;
    } else if (requestedSnapshotter !== "") {
      warn(
        `  NEMOCLAW_OVERLAY_SNAPSHOTTER='${requestedSnapshotter}' is not recognized. ` +
          "Valid values are 'fuse-overlayfs' or 'native'. Falling back to 'fuse-overlayfs'.",
      );
    }
    const cacheKey = `${snapshotter}\0${upstreamImage}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

    let assessment: OverlayfsHostAssessment;
    try {
      assessment = deps.assessHost();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`  Skipping overlayfs auto-fix: host assessment failed (${reason}).`);
      cache.set(cacheKey, null);
      return null;
    }
    if (!assessment.hasNestedOverlayConflict) {
      cache.set(cacheKey, null);
      return null;
    }

    log(
      `  Detected Docker 26+ containerd-snapshotter overlayfs (driver=${assessment.dockerStorageDriver ?? "unknown"}). ` +
        `Routing through a locally-built ${snapshotter} cluster image to bypass nested-overlay break.`,
    );
    log(
      "  Set NEMOCLAW_DISABLE_OVERLAY_FIX=1 to disable this auto-fix; see docs for the manual daemon.json workaround.",
    );

    try {
      const patchedTag = deps.ensurePatchedClusterImage({ upstreamImage, snapshotter });
      cache.set(cacheKey, patchedTag);
      return patchedTag;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      error(`  Patched cluster image build failed: ${reason}`);
      error(
        "  Falling back to the upstream image. The k3s server will likely fail; see docs/reference/troubleshooting.mdx.",
      );
      cache.set(cacheKey, null);
      return null;
    }
  };
}
