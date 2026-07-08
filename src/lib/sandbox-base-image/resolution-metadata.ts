// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerImageInspectFormat } from "../adapters/docker";
import { addTraceEvent } from "../trace";
import { versionGte } from "./image-compatibility";
import {
  type BaseImageResolutionValidation,
  type LocalImageMetadata,
  OPENSHELL_SANDBOX_MIN_GLIBC,
  type ResolveBaseImageOptions,
  SANDBOX_BASE_RESOLUTION_SCHEMA,
  type SandboxBaseImageResolution,
  type SandboxBaseImageResolutionMetadata,
} from "./types";

export function inspectLocalImageMetadata(imageRef: string): LocalImageMetadata | null {
  const output = dockerImageInspectFormat("{{json .}}", imageRef, { ignoreError: true });
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as LocalImageMetadata) : null;
  } catch {
    return null;
  }
}

export function validateSandboxBaseImageResolutionMetadata(input: {
  metadata: SandboxBaseImageResolutionMetadata;
  expectedKey: string;
  imageName: string;
  pinnedRemoteRef?: string;
  requireOpenshellSandboxAbi: boolean;
  minGlibcVersion: string;
  inspected: LocalImageMetadata | null;
}): BaseImageResolutionValidation {
  const { metadata, inspected } = input;
  if (metadata.key !== input.expectedKey || metadata.imageName !== input.imageName) {
    return { ok: false, reason: "key_mismatch" };
  }
  if (metadata.source === "pinned" && metadata.pinnedRemoteRef !== input.pinnedRemoteRef) {
    return { ok: false, reason: "pinned_ref_mismatch" };
  }
  if (
    metadata.requireOpenshellSandboxAbi !== input.requireOpenshellSandboxAbi ||
    metadata.minGlibcVersion !== input.minGlibcVersion
  ) {
    return { ok: false, reason: "requirements_changed" };
  }
  if (
    input.requireOpenshellSandboxAbi &&
    (!metadata.glibcVersion || !versionGte(metadata.glibcVersion, input.minGlibcVersion))
  ) {
    return { ok: false, reason: "abi_incompatible" };
  }
  if (metadata.digest === null && metadata.source !== "local") {
    return { ok: false, reason: "repo_digest_missing" };
  }
  if (
    !inspected ||
    inspected.Id !== metadata.imageId ||
    inspected.Os !== metadata.os ||
    inspected.Architecture !== metadata.architecture
  ) {
    return { ok: false, reason: "local_image_changed" };
  }
  if (metadata.digest) {
    const expectedRepoDigest = `${input.imageName}@${metadata.digest}`;
    const repoDigests = Array.isArray(inspected.RepoDigests) ? inspected.RepoDigests : [];
    if (!repoDigests.some((entry) => String(entry) === expectedRepoDigest)) {
      return { ok: false, reason: "repo_digest_missing" };
    }
  }
  return { ok: true };
}

export function createSandboxBaseImageResolutionMetadata(
  options: ResolveBaseImageOptions,
  key: string,
  resolution: SandboxBaseImageResolution,
): SandboxBaseImageResolutionMetadata | null {
  if (!resolution.digest && resolution.source !== "local") return null;
  const inspected = inspectLocalImageMetadata(resolution.ref);
  const imageId = typeof inspected?.Id === "string" ? inspected.Id : "";
  const osName = typeof inspected?.Os === "string" ? inspected.Os : "";
  const architecture = typeof inspected?.Architecture === "string" ? inspected.Architecture : "";
  if (!imageId || !osName || !architecture) return null;

  if (resolution.digest) {
    const expectedRepoDigest = `${options.imageName}@${resolution.digest}`;
    const repoDigests = Array.isArray(inspected?.RepoDigests) ? inspected.RepoDigests : [];
    if (!repoDigests.some((entry) => String(entry) === expectedRepoDigest)) return null;
  }

  return {
    schema: SANDBOX_BASE_RESOLUTION_SCHEMA,
    key,
    imageName: options.imageName,
    ref: resolution.ref,
    digest: resolution.digest,
    source: resolution.source,
    ...(resolution.pinnedRemoteRef ? { pinnedRemoteRef: resolution.pinnedRemoteRef } : {}),
    imageId,
    os: osName,
    architecture,
    glibcVersion: resolution.glibcVersion,
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    minGlibcVersion: options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
  };
}

export function finalizeSandboxBaseImageResolution(
  options: ResolveBaseImageOptions,
  key: string,
  resolution: SandboxBaseImageResolution,
): SandboxBaseImageResolution {
  const metadata = createSandboxBaseImageResolutionMetadata(options, key, resolution);
  return metadata ? { ...resolution, metadata } : resolution;
}

export function reuseSandboxBaseImageResolutionHint(
  options: ResolveBaseImageOptions,
  key: string,
): SandboxBaseImageResolution | null {
  const hint = options.resolutionHint;
  if (!hint) return null;
  const validation = validateSandboxBaseImageResolutionMetadata({
    metadata: hint,
    expectedKey: key,
    imageName: options.imageName,
    pinnedRemoteRef: options.pinnedRemoteRef,
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    minGlibcVersion: options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
    inspected: inspectLocalImageMetadata(hint.ref),
  });
  if (!validation.ok) {
    addTraceEvent("nemoclaw.sandbox_base_image.cache_stale", { reason: validation.reason });
    return null;
  }
  if (options.validateImage && !options.validateImage(hint.ref)) {
    addTraceEvent("nemoclaw.sandbox_base_image.cache_stale", {
      reason: "custom_validation_failed",
    });
    return null;
  }

  addTraceEvent("nemoclaw.sandbox_base_image.cache_hit", {
    source: hint.source,
    digest_pinned: hint.digest !== null,
  });
  console.log(`  Reusing locally validated ${options.label || "sandbox base image"}: ${hint.ref}`);
  return {
    ref: hint.ref,
    digest: hint.digest,
    source: hint.source,
    ...(hint.pinnedRemoteRef ? { pinnedRemoteRef: hint.pinnedRemoteRef } : {}),
    glibcVersion: hint.glibcVersion,
    metadata: hint,
  };
}
