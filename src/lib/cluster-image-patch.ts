// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Build-on-demand patched OpenShell cluster image.
//
// Docker 26+ flips the install-time default storage driver from the legacy
// `overlay2` graph driver to the new containerd image-store with `overlayfs`
// snapshotter. K3s inside the OpenShell cluster container relies on the host
// overlayfs supporting nested overlay mounts, which the new snapshotter does
// not. The kernel rejects the nested mount with EINVAL ("invalid argument"),
// k3s loops, and the gateway never reaches healthy.
//
// Upstream OpenShell closed this class of bug wontfix while a multi-month
// roadmap migration off k3s lands. NemoClaw downstream cannot wait. This
// module produces a locally-built drop-in replacement for the cluster image
// that routes around the kernel limitation by selecting `fuse-overlayfs` (or
// `native`) as the k3s snapshotter and installing the userspace
// fuse-overlayfs binary.
//
// The patched image is built on the user's machine via `docker build` from
// the upstream image plus a tiny Dockerfile fragment. We do not publish the
// patched image; the cache is the user's local Docker engine.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SnapshotterChoice = "fuse-overlayfs" | "native";

export const DEFAULT_SNAPSHOTTER: SnapshotterChoice = "fuse-overlayfs";

const TAG_PREFIX = "nemoclaw-cluster";

export interface PatchFsApi {
  mkdtempSync: (prefix: string) => string;
  writeFileSync: (filePath: string, data: string, encoding: BufferEncoding) => void;
  rmSync: (filePath: string, options?: { recursive?: boolean; force?: boolean }) => void;
}

export interface RunOpts {
  ignoreError?: boolean;
  /** Hard wall-clock timeout (ms). Child is killed on expiry. */
  timeoutMs?: number;
  /**
   * Drop captured stdout/stderr instead of forwarding them to the user's
   * terminal. Used for noisy commands (`docker manifest inspect`,
   * `docker build`) whose raw output is internal-only — the caller logs
   * its own progress lines.
   */
  suppressOutput?: boolean;
}

export interface EnsurePatchedClusterImageOpts {
  /** Upstream OpenShell cluster image reference, e.g. `ghcr.io/nvidia/openshell/cluster:0.0.36`. */
  upstreamImage: string;
  /** Snapshotter to bake into the patched image's k3s CMD. Defaults to fuse-overlayfs. */
  snapshotter?: SnapshotterChoice;
  /** Captures stdout from a command (used to probe `docker image inspect`). */
  runCaptureImpl?: (cmd: readonly string[], opts?: RunOpts) => string;
  /** Streams a command's stdio (used for `docker pull` and `docker build`). */
  runImpl?: (cmd: readonly string[], opts?: RunOpts) => { status: number | null };
  /** Logger for human-readable progress lines. Defaults to console.error. */
  logger?: (msg: string) => void;
  /** Filesystem implementation (testing seam). */
  fsImpl?: PatchFsApi;
  /** Temp dir resolver (testing seam). */
  tmpdirImpl?: () => string;
  /**
   * Hard wall-clock timeout (ms) for `docker pull`. spawnSync has no native
   * timeout safety on its own, and a stuck registry on this critical path
   * would hang the entire onboard. Default 10 minutes.
   */
  pullTimeoutMs?: number;
  /**
   * Hard wall-clock timeout (ms) for `docker build`. The patched image is
   * tiny (one apt-get layer + CMD) so 5 minutes is generous. Default 5 minutes.
   */
  buildTimeoutMs?: number;
  /**
   * Hard wall-clock timeout (ms) for the `docker image inspect` cache
   * probe. A stuck Docker daemon would otherwise hang onboard at the
   * very first step. Default 30 seconds.
   */
  inspectTimeoutMs?: number;
}

/** 10 minutes — generous for a slow registry, short enough to fail fast on a hung daemon. */
export const DEFAULT_PULL_TIMEOUT_MS = 10 * 60 * 1000;
/** 5 minutes — a one-layer apt-get build should complete in seconds. */
export const DEFAULT_BUILD_TIMEOUT_MS = 5 * 60 * 1000;
/** 30 seconds — `docker image inspect` against a healthy daemon is sub-second. */
export const DEFAULT_INSPECT_TIMEOUT_MS = 30 * 1000;

/**
 * Pinned digest for the `ubuntu:24.04` builder base image. The patched-image
 * tag is a SHA over the Dockerfile *text*, so a floating `ubuntu:24.04` tag
 * would let the same NemoClaw tag produce different image bytes whenever
 * Ubuntu publishes a security update. Pinning to a digest keeps the
 * (text → bytes) contract honest.
 *
 * To refresh: `docker pull ubuntu:24.04 && docker images --digests ubuntu:24.04`.
 * Update both this constant and the same value in any unit test fixture.
 */
export const UBUNTU_BUILDER_DIGEST =
  "sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b";

/** Returns the Dockerfile contents used to patch a single upstream cluster image. */
export function buildPatchDockerfile(snapshotter: SnapshotterChoice): string {
  // The upstream entrypoint (cluster-entrypoint.sh) does
  // `exec /bin/k3s "$@" ...kubelet args...`, so CMD becomes the k3s
  // positional args. Override CMD to inject `--snapshotter=...` before the
  // entrypoint's appended kubelet args so k3s picks the requested snapshotter.

  if (snapshotter === "native") {
    // K3s native snapshotter copies image layers instead of overlaying
    // them. No userspace overlay binary is needed — the only thing the
    // patched image has to do is override the upstream CMD.
    return [
      "# Generated by NemoClaw — see src/lib/cluster-image-patch.ts.",
      "ARG UPSTREAM",
      "FROM ${UPSTREAM}",
      'CMD ["server", "--snapshotter=native"]',
      "",
    ].join("\n");
  }

  // fuse-overlayfs path. We deliberately use a clean `ubuntu:24.04` builder
  // stage rather than the cluster image itself because the cluster image's
  // base ships BusyBox `tar` rather than GNU `tar`, so `dpkg-deb` cannot
  // extract any `.deb` package directly there. The upstream cluster image
  // also lacks `curl`, so we cannot fetch a static binary in-place.
  //
  // Standard `ubuntu:24.04` (matching the cluster image's noble glibc ABI)
  // has working apt + GNU tar. We install `fuse-overlayfs` there, copy the
  // binary plus its sole non-libc shared dependency (`libfuse3.so.3`) into
  // the cluster image, then `ldconfig` to expose the lib.
  return [
    "# Generated by NemoClaw — see src/lib/cluster-image-patch.ts.",
    "# syntax=docker/dockerfile:1",
    "ARG UPSTREAM",
    "",
    `FROM ubuntu:24.04@${UBUNTU_BUILDER_DIGEST} AS bin-fetcher`,
    'RUN set -eux; \\',
    "    apt-get update; \\",
    "    apt-get install -y --no-install-recommends fuse-overlayfs ca-certificates; \\",
    "    rm -rf /var/lib/apt/lists/*; \\",
    "    mkdir -p /export/lib; \\",
    "    cp /usr/bin/fuse-overlayfs /export/fuse-overlayfs; \\",
    "    LIBFUSE=$(ldd /usr/bin/fuse-overlayfs | awk '/libfuse3/ {print $3}'); \\",
    '    test -n "$LIBFUSE" && test -f "$LIBFUSE"; \\',
    '    cp -L "$LIBFUSE" /export/lib/libfuse3.so.3; \\',
    "    /usr/bin/fuse-overlayfs --version",
    "",
    "FROM ${UPSTREAM}",
    "USER root",
    "COPY --from=bin-fetcher /export/fuse-overlayfs /usr/local/bin/fuse-overlayfs",
    "COPY --from=bin-fetcher /export/lib/libfuse3.so.3 /usr/local/lib/libfuse3.so.3",
    'RUN ldconfig 2>/dev/null || true',
    `CMD ["server", "--snapshotter=${snapshotter}"]`,
    "",
  ].join("\n");
}

/**
 * Strips registry prefix and digest, returning the version portion of a tag.
 * A colon only delimits a tag when it appears after the last path separator —
 * references like `registry:5000/repo` (registry with explicit port, no tag)
 * must not be parsed as if `5000/repo` were the tag.
 */
export function extractUpstreamVersion(upstreamImage: string): string {
  const withoutDigest = upstreamImage.split("@")[0] ?? "";
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  if (lastColon > lastSlash && lastColon < withoutDigest.length - 1) {
    return withoutDigest.slice(lastColon + 1);
  }
  return "unknown";
}

/**
 * Deterministic local image tag derived from upstream identity, snapshotter,
 * and Dockerfile content.
 *
 * `upstreamDigest`, when supplied, is the resolved content digest of the
 * upstream image (e.g. `sha256:abc…`). Including it binds the patched-image
 * tag to the actual upstream bytes — if the registry republishes
 * `ghcr.io/nvidia/openshell/cluster:0.0.36` with a security fix, the digest
 * changes, the SHA changes, the patched tag changes, and the next onboard
 * rebuilds. Without it, a stale upstream re-push is silently invisible.
 *
 * Callers should resolve and pass `upstreamDigest`. The optional fallback is
 * for unit-testable callers that don't care to model docker inspect.
 */
export function computePatchedTag(opts: {
  upstreamImage: string;
  snapshotter: SnapshotterChoice;
  dockerfile: string;
  upstreamDigest?: string;
}): string {
  const version = extractUpstreamVersion(opts.upstreamImage);
  const digestPart = opts.upstreamDigest ?? "";
  const sha = crypto
    .createHash("sha256")
    .update(
      `${opts.upstreamImage}\n${digestPart}\n${opts.snapshotter}\n${opts.dockerfile}`,
    )
    .digest("hex")
    .slice(0, 8);
  return `${TAG_PREFIX}:${version}-${opts.snapshotter}-${sha}`;
}

/**
 * Idempotently produce a locally-built patched cluster image and return its
 * tag. Subsequent calls with the same inputs no-op via the local Docker cache.
 *
 * Resolution order, with fast-fail on unreachable hosts:
 *
 *   1. `docker image inspect <upstream>` — if the upstream image is already
 *      local, capture its digest and skip the network entirely. This is the
 *      common path on warm hosts and the only path that works air-gapped
 *      with a pre-staged image.
 *   2. Otherwise, `docker manifest inspect <upstream>` with a 30 s budget
 *      to verify reachability *before* committing to the long pull. This
 *      keeps the air-gapped failure mode under 30 s + the inspect timeout
 *      instead of the full 10 min pull timeout.
 *   3. `docker pull <upstream>` (long timeout), then `docker image inspect`
 *      to capture the now-local digest.
 *
 * The captured digest is folded into the patched-image tag's SHA, so a
 * registry-side re-push of the same upstream tag invalidates the local
 * patched-image cache.
 *
 * Throws on build failure with a structured error so callers can fall back
 * to the upstream image (and the upstream's eventual k3s crash) or surface
 * the documented manual workaround.
 */
export function ensurePatchedClusterImage(opts: EnsurePatchedClusterImageOpts): string {
  const snapshotter = opts.snapshotter ?? DEFAULT_SNAPSHOTTER;
  const log = opts.logger ?? ((msg: string) => console.error(msg));
  const runCaptureImpl = opts.runCaptureImpl ?? defaultRunCapture;
  const runImpl = opts.runImpl ?? defaultRun;
  const fsApi: PatchFsApi = opts.fsImpl ?? {
    mkdtempSync: (prefix: string) => fs.mkdtempSync(prefix),
    writeFileSync: (filePath: string, data: string, encoding: BufferEncoding) =>
      fs.writeFileSync(filePath, data, encoding),
    rmSync: (filePath: string, options) => fs.rmSync(filePath, options),
  };
  const tmpdirImpl = opts.tmpdirImpl ?? os.tmpdir;
  const pullTimeoutMs = opts.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
  const buildTimeoutMs = opts.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const inspectTimeoutMs = opts.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;

  const dockerfile = buildPatchDockerfile(snapshotter);

  // Phase 1: resolve the upstream digest. Prefer the local cache (works
  // air-gapped with pre-staged images, and is sub-second when warm).
  let upstreamDigest = inspectImageDigest(
    opts.upstreamImage,
    runCaptureImpl,
    inspectTimeoutMs,
  );

  if (!upstreamDigest) {
    // Upstream is not local. Probe network reachability with a short
    // budget BEFORE committing to the multi-minute pull, so air-gapped
    // and restricted-network hosts fail in seconds instead of minutes.
    const probeResult = runImpl(["docker", "manifest", "inspect", opts.upstreamImage], {
      ignoreError: true,
      suppressOutput: true,
      timeoutMs: inspectTimeoutMs,
    });
    if (probeResult.status !== 0) {
      throw new ClusterImagePatchError(
        `cannot reach upstream registry for ${opts.upstreamImage} ` +
          `(docker manifest inspect exit ${probeResult.status} within ${inspectTimeoutMs} ms). ` +
          "See docs/reference/troubleshooting.md for the manual daemon.json workaround.",
      );
    }

    log(`  Pulling upstream cluster image: ${opts.upstreamImage}`);
    const pullResult = runImpl(["docker", "pull", opts.upstreamImage], {
      ignoreError: true,
      timeoutMs: pullTimeoutMs,
    });
    if (pullResult.status !== 0) {
      throw new ClusterImagePatchError(
        `failed to pull upstream cluster image ${opts.upstreamImage} ` +
          `(docker pull exit ${pullResult.status}; timeout ${pullTimeoutMs} ms)`,
      );
    }

    upstreamDigest = inspectImageDigest(
      opts.upstreamImage,
      runCaptureImpl,
      inspectTimeoutMs,
    );
    if (!upstreamDigest) {
      throw new ClusterImagePatchError(
        `failed to resolve digest for ${opts.upstreamImage} after successful pull`,
      );
    }
  }

  // Phase 2: digest-bound tag. A re-pushed upstream produces a different
  // digest, hence a different SHA, hence a different patched tag — and
  // the next onboard rebuilds rather than reusing stale layers.
  const tag = computePatchedTag({
    upstreamImage: opts.upstreamImage,
    snapshotter,
    dockerfile,
    upstreamDigest,
  });

  if (imageExists(tag, runCaptureImpl, inspectTimeoutMs)) {
    return tag;
  }

  log(`  Building patched cluster image (one-time) → ${tag}`);
  log(`  Source: ${opts.upstreamImage} (${upstreamDigest})`);
  log(`  Snapshotter: ${snapshotter}`);

  const tmpDir = fsApi.mkdtempSync(path.join(tmpdirImpl(), "nemoclaw-cluster-patch-"));
  try {
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fsApi.writeFileSync(dockerfilePath, dockerfile, "utf-8");

    const buildResult = runImpl(
      [
        "docker",
        "build",
        "--quiet",
        "--build-arg",
        `UPSTREAM=${opts.upstreamImage}`,
        "-t",
        tag,
        tmpDir,
      ],
      { ignoreError: true, suppressOutput: true, timeoutMs: buildTimeoutMs },
    );

    if (buildResult.status !== 0) {
      throw new ClusterImagePatchError(
        `failed to build patched cluster image ` +
          `(docker build exit ${buildResult.status}; timeout ${buildTimeoutMs} ms)`,
      );
    }
  } finally {
    try {
      fsApi.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; don't mask the build outcome with a tmp-cleanup error.
    }
  }

  log(`  Patched image ready: ${tag}`);
  return tag;
}

function imageExists(
  tag: string,
  runCaptureImpl: (cmd: readonly string[], opts?: RunOpts) => string,
  inspectTimeoutMs: number,
): boolean {
  const out = runCaptureImpl(["docker", "image", "inspect", "--format", "{{.Id}}", tag], {
    ignoreError: true,
    timeoutMs: inspectTimeoutMs,
  });
  return Boolean(out && out.trim());
}

/**
 * Returns the local content digest of `imageRef` (e.g. `sha256:abc…`), or
 * an empty string if the image is not present locally. The probe is
 * bounded by `inspectTimeoutMs` so a stuck Docker daemon can't hang the
 * whole flow at this step.
 */
function inspectImageDigest(
  imageRef: string,
  runCaptureImpl: (cmd: readonly string[], opts?: RunOpts) => string,
  inspectTimeoutMs: number,
): string {
  const out = runCaptureImpl(
    ["docker", "image", "inspect", "--format", "{{.Id}}", imageRef],
    { ignoreError: true, timeoutMs: inspectTimeoutMs },
  );
  return (out || "").trim();
}

export class ClusterImagePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterImagePatchError";
  }
}

const runner: typeof import("./runner") = require("./runner");

function defaultRunCapture(cmd: readonly string[], opts: RunOpts = {}): string {
  return runner.runCapture(cmd, {
    ignoreError: opts.ignoreError,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
}

function defaultRun(cmd: readonly string[], opts: RunOpts = {}): { status: number | null } {
  const result = runner.run(cmd, {
    ignoreError: opts.ignoreError,
    suppressOutput: opts.suppressOutput,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
  return { status: result.status ?? null };
}
