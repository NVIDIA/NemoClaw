// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerBuild,
  dockerImageInspect,
  dockerImageInspectFormat,
  dockerPull,
} from "./adapters/docker";
import { ROOT, redact } from "./runner";
import { imageMeetsMinimumGlibc } from "./sandbox-base-image/image-compatibility";
import { createSandboxBaseImageResolutionKey } from "./sandbox-base-image/resolution-key";
import {
  finalizeSandboxBaseImageResolution,
  reuseSandboxBaseImageResolutionHint,
} from "./sandbox-base-image/resolution-metadata";
import {
  baseImageInputsChangedSinceMain,
  baseImageInputsDirty,
  getSourceShortShaTags,
  getVersionedBaseImageTags,
} from "./sandbox-base-image/source-identity";
import {
  OPENSHELL_SANDBOX_MIN_GLIBC,
  type ResolveBaseImageOptions,
  SANDBOX_BASE_TAG,
  type SandboxBaseImageResolution,
} from "./sandbox-base-image/types";
import { addTraceEvent } from "./trace";

export * from "./sandbox-base-image/image-compatibility";
export * from "./sandbox-base-image/label-codec";
export * from "./sandbox-base-image/resolution-key";
export * from "./sandbox-base-image/resolution-metadata";
export * from "./sandbox-base-image/source-identity";
export * from "./sandbox-base-image/types";

/**
 * Combine stderr + stdout from a captured `dockerBuild` failure and pass them
 * through the runner's redaction so secrets in build output never reach the
 * terminal. BuildKit splits diagnostics across both streams depending on the
 * backend and progress mode, so taking only stderr can hide the actual reason
 * a build failed.
 */
export function formatBuildFailureDiagnostics(buildResult: {
  stderr?: unknown;
  stdout?: unknown;
}): string {
  const streams = [buildResult.stderr, buildResult.stdout]
    .map((stream) => {
      if (stream == null) return "";
      if (Buffer.isBuffer(stream)) return stream.toString("utf8");
      return String(stream);
    })
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  return streams.length > 0 ? redact(streams.join("\n")) : "";
}

function localBuildAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD || "auto")
    .trim()
    .toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return env.NODE_ENV !== "test" && env.VITEST !== "true";
}

function getRepoDigest(
  imageName: string,
  imageRef: string,
): { digest: string; ref: string } | null {
  const atIndex = imageRef.indexOf("@sha256:");
  const pinnedDigest =
    atIndex !== -1 ? { digest: imageRef.slice(atIndex + 1), ref: imageRef } : null;

  // Docker can normalize a pulled manifest-list digest to the platform manifest
  // digest in RepoDigests. Prefer that local proof when present, but keep the
  // caller's exact digest ref as the fallback for offline or sparse metadata.
  const inspectOutput = dockerImageInspectFormat("{{json .RepoDigests}}", imageRef, {
    ignoreError: true,
  });
  if (!inspectOutput) return pinnedDigest;

  let repoDigests: unknown;
  try {
    repoDigests = JSON.parse(inspectOutput || "[]");
  } catch {
    addTraceEvent("nemoclaw.sandbox_base_image.repodigest_parse_failed", {
      digest_pinned: pinnedDigest !== null,
    });
    return pinnedDigest;
  }
  const repoDigest = Array.isArray(repoDigests)
    ? repoDigests.find((entry) => String(entry).startsWith(`${imageName}@sha256:`))
    : null;
  if (!repoDigest) return pinnedDigest;
  const digest = String(repoDigest).slice(String(repoDigest).indexOf("@") + 1);
  return { digest, ref: `${imageName}@${digest}` };
}

function resolvePulledCandidate(
  imageName: string,
  imageRef: string,
  source: SandboxBaseImageResolution["source"],
  options: ResolveBaseImageOptions,
  pinnedRemoteRef?: string,
): SandboxBaseImageResolution | null {
  const inspectResult = dockerImageInspect(imageRef, {
    ignoreError: true,
    suppressOutput: true,
  });
  addTraceEvent("nemoclaw.sandbox_base_image.local_validation", {
    source,
    present: inspectResult.status === 0,
  });
  if (inspectResult.status !== 0) {
    addTraceEvent("nemoclaw.sandbox_base_image.remote_pull", { source });
    const pullResult = dockerPull(imageRef, { ignoreError: true, suppressOutput: true });
    if (pullResult.status !== 0) return null;
  }

  let glibcVersion: string | null = null;
  if (options.requireOpenshellSandboxAbi) {
    const check = imageMeetsMinimumGlibc(
      imageRef,
      options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
    );
    glibcVersion = check.version;
    if (!check.ok) {
      console.warn(
        `  Warning: ${options.label || "sandbox base image"} ${imageRef} has glibc ` +
          `${glibcVersion || "unknown"}; OpenShell sandbox supervisor requires ` +
          `glibc >= ${options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC}.`,
      );
      return null;
    }
  }

  if (options.validateImage && !options.validateImage(imageRef)) {
    console.warn(
      `  Warning: ${options.label || "sandbox base image"} ${imageRef} lacks ` +
        `${options.validationDescription || "a required runtime capability"}.`,
    );
    return null;
  }

  const repoDigest = getRepoDigest(imageName, imageRef);
  return {
    ref: repoDigest?.ref || imageRef,
    digest: repoDigest?.digest || null,
    source,
    ...(pinnedRemoteRef ? { pinnedRemoteRef } : {}),
    glibcVersion,
  };
}

function resolveLocalCandidate(
  options: ResolveBaseImageOptions,
  forceBuild = false,
): SandboxBaseImageResolution | null {
  const imageRef = options.localTag;
  if (!forceBuild) {
    const inspectResult = dockerImageInspect(imageRef, { ignoreError: true, suppressOutput: true });
    if (inspectResult.status === 0) {
      const check = options.requireOpenshellSandboxAbi
        ? imageMeetsMinimumGlibc(imageRef, options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC)
        : { ok: true, version: null };
      if (check.ok && (!options.validateImage || options.validateImage(imageRef))) {
        addTraceEvent("nemoclaw.sandbox_base_image.local_fallback_reuse");
        return { ref: imageRef, digest: null, source: "local", glibcVersion: check.version };
      }
    }
  }

  if (!localBuildAllowed(options.env)) return null;

  const label = options.label || "sandbox base image";
  console.warn(`  Building ${label} locally because no compatible published base image was found.`);
  addTraceEvent("nemoclaw.sandbox_base_image.local_fallback_build");
  console.warn("  This is a one-time step and can take several minutes.");
  // Suppress the full BuildKit log (apt-get output, layer hashes, debconf
  // warnings) on success — same approach as #3311 for the [2/8] gateway
  // setup leak. `--quiet` collapses normal output to just the image hash;
  // `suppressOutput` keeps captured stdio out of the user's terminal.
  // On failure, surface the captured stderr so the user still gets a
  // useful diagnostic.
  const buildResult = dockerBuild(options.dockerfilePath, imageRef, options.rootDir || ROOT, {
    quiet: true,
    ignoreError: true,
    suppressOutput: true,
  });
  if (buildResult.error || buildResult.status !== 0) {
    const diagnostics = formatBuildFailureDiagnostics(buildResult);
    if (diagnostics) console.error(diagnostics);
    const detail = buildResult.error
      ? `: ${buildResult.error.message}`
      : ` (exit ${buildResult.status ?? "unknown"})`;
    console.error(`  Failed to build ${label}${detail}`);
    return null;
  }

  const check = options.requireOpenshellSandboxAbi
    ? imageMeetsMinimumGlibc(imageRef, options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC)
    : { ok: true, version: null };
  if (!check.ok) {
    console.error(
      `  Local ${label} ${imageRef} has glibc ` +
        `${check.version || "unknown"}; expected >= ` +
        `${options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC}.`,
    );
    return null;
  }

  if (options.validateImage && !options.validateImage(imageRef)) {
    console.error(
      `  Local ${label} ${imageRef} lacks ` +
        `${options.validationDescription || "a required runtime capability"}.`,
    );
    return null;
  }

  return { ref: imageRef, digest: null, source: "local", glibcVersion: check.version };
}

export class SandboxBaseImageResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxBaseImageResolutionError";
  }
}

export function resolveSandboxBaseImage(
  options: ResolveBaseImageOptions,
): SandboxBaseImageResolution | null {
  const env = options.env || process.env;
  const resolutionKey = createSandboxBaseImageResolutionKey(options);
  const override = options.envVar ? String(env[options.envVar] || "").trim() : "";

  if (!options.forceRefresh) {
    const reused = reuseSandboxBaseImageResolutionHint(options, resolutionKey);
    if (reused) return reused;
  } else {
    addTraceEvent("nemoclaw.sandbox_base_image.force_refresh");
  }
  addTraceEvent("nemoclaw.sandbox_base_image.cache_miss", {
    has_hint: options.resolutionHint != null,
  });

  const finish = (resolution: SandboxBaseImageResolution): SandboxBaseImageResolution =>
    finalizeSandboxBaseImageResolution(options, resolutionKey, resolution);
  const resolveChangedInputs = (): SandboxBaseImageResolution => {
    const local = resolveLocalCandidate(options, true);
    if (local) return finish(local);
    throw new SandboxBaseImageResolutionError(
      `${options.label || "Sandbox base image"} inputs differ from main, but no image built ` +
        `from the current inputs could be validated. Resolve the local build failure or enable ` +
        "NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD, then retry.",
    );
  };

  if (override) {
    const resolved = resolvePulledCandidate(options.imageName, override, "override", options);
    if (resolved) return finish(resolved);
    if (!options.requireOpenshellSandboxAbi && !options.validateImage) return null;
  } else {
    const rootDir = options.rootDir || ROOT;
    const inputPaths = [options.dockerfilePath, ...(options.inputPaths ?? [])];
    const preferPinnedRemoteRef = options.preferPinnedRemoteRef === true;
    if (baseImageInputsDirty(rootDir, env, inputPaths)) return resolveChangedInputs();

    if (preferPinnedRemoteRef && options.pinnedRemoteRef) {
      const resolved = resolvePulledCandidate(
        options.imageName,
        options.pinnedRemoteRef,
        "pinned",
        options,
        options.pinnedRemoteRef,
      );
      if (resolved) return finish(resolved);
    }

    for (const tag of getVersionedBaseImageTags(options.rootDir || ROOT, env)) {
      const imageRef = `${options.imageName}:${tag}`;
      const resolved = resolvePulledCandidate(options.imageName, imageRef, "version-tag", options);
      if (resolved) return finish(resolved);
    }

    for (const tag of getSourceShortShaTags(options.rootDir || ROOT, env)) {
      const imageRef = `${options.imageName}:${tag}`;
      const resolved = resolvePulledCandidate(options.imageName, imageRef, "source-sha", options);
      if (resolved) return finish(resolved);
    }

    if (baseImageInputsChangedSinceMain(rootDir, env, inputPaths)) return resolveChangedInputs();

    if (!preferPinnedRemoteRef && options.pinnedRemoteRef) {
      const resolved = resolvePulledCandidate(
        options.imageName,
        options.pinnedRemoteRef,
        "pinned",
        options,
        options.pinnedRemoteRef,
      );
      if (resolved) return finish(resolved);
    }

    const latestRef = `${options.imageName}:${SANDBOX_BASE_TAG}`;
    const resolved = resolvePulledCandidate(options.imageName, latestRef, "latest", options);
    if (resolved) return finish(resolved);
  }

  if (options.requireOpenshellSandboxAbi || options.validateImage) {
    const local = resolveLocalCandidate(options);
    return local ? finish(local) : null;
  }
  return null;
}
