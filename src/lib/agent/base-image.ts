// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerBuild, dockerImageInspect } from "../adapters/docker";
import { ROOT } from "../runner";
import {
  buildLocalBaseTag,
  createSandboxBaseImageResolutionKey,
  createSandboxBaseImageResolutionMetadata,
  getImageGlibcVersion,
  type ResolveBaseImageOptions,
  resolveSandboxBaseImage,
  SANDBOX_BASE_TAG,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import type { AgentDefinition } from "./defs";

export interface EnsureAgentBaseImageOptions {
  forceBaseImageRebuild?: boolean;
  resolutionHint?: SandboxBaseImageResolutionMetadata | null;
  forceBaseImageRefresh?: boolean;
}

export interface EnsureAgentBaseImageResult {
  imageTag: string | null;
  built: boolean;
  resolutionMetadata?: SandboxBaseImageResolutionMetadata;
}

function createAgentBaseImageResolutionOptions(
  agent: AgentDefinition,
  dockerfilePath: string,
  options: EnsureAgentBaseImageOptions,
): ResolveBaseImageOptions {
  const imageName = `ghcr.io/nvidia/nemoclaw/${agent.name}-sandbox-base`;
  return {
    imageName,
    dockerfilePath,
    localTag: buildLocalBaseTag(`nemoclaw-${agent.name}-sandbox-base-local`, ROOT),
    envVar: `NEMOCLAW_${agent.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_SANDBOX_BASE_IMAGE_REF`,
    label: `${agent.displayName} sandbox base image`,
    requireOpenshellSandboxAbi: process.platform === "linux",
    resolutionHint: options.resolutionHint,
    forceRefresh: options.forceBaseImageRefresh,
    rootDir: ROOT,
  };
}

function createLocalResolutionMetadata(
  options: ResolveBaseImageOptions,
  imageTag: string,
): SandboxBaseImageResolutionMetadata | null {
  return createSandboxBaseImageResolutionMetadata(
    options,
    createSandboxBaseImageResolutionKey(options),
    {
      ref: imageTag,
      digest: null,
      source: "local",
      glibcVersion: process.platform === "linux" ? getImageGlibcVersion(imageTag) : null,
    },
  );
}

/**
 * Ensure the agent-specific sandbox base image exists locally.
 * Rebuild callers can force this so local Dockerfile.base edits are applied.
 */
export function ensureAgentBaseImage(
  agent: AgentDefinition,
  options: EnsureAgentBaseImageOptions = {},
): EnsureAgentBaseImageResult {
  const baseDockerfile = agent.dockerfileBasePath;
  if (!baseDockerfile) return { imageTag: null, built: false };

  const resolutionOptions = createAgentBaseImageResolutionOptions(agent, baseDockerfile, options);
  const baseImageTag = `${resolutionOptions.imageName}:${SANDBOX_BASE_TAG}`;
  if (options.forceBaseImageRebuild === true) {
    console.log(`  Rebuilding ${agent.displayName} base image...`);
    const buildResult = dockerBuild(baseDockerfile, baseImageTag, ROOT, {
      ignoreError: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (buildResult.error || buildResult.status !== 0) {
      const detail = buildResult.error
        ? `: ${buildResult.error.message}`
        : ` (exit ${buildResult.status ?? "unknown"})`;
      throw new Error(`Failed to build ${agent.displayName} base image${detail}`);
    }
    console.log(`  \u2713 Base image built: ${baseImageTag}`);
    const resolutionMetadata = createLocalResolutionMetadata(resolutionOptions, baseImageTag);
    return {
      imageTag: baseImageTag,
      built: true,
      ...(resolutionMetadata ? { resolutionMetadata } : {}),
    };
  }

  const resolved = resolveSandboxBaseImage(resolutionOptions);
  if (resolved) {
    console.log(`  Using ${agent.displayName} base image: ${resolved.ref}`);
    return {
      imageTag: resolved.ref,
      built: false,
      ...(resolved.metadata ? { resolutionMetadata: resolved.metadata } : {}),
    };
  }
  if (process.platform === "linux") {
    throw new Error(
      `No compatible ${agent.displayName} sandbox base image found for ${resolutionOptions.imageName}`,
    );
  }

  const inspectResult = dockerImageInspect(baseImageTag, {
    ignoreError: true,
    suppressOutput: true,
  });
  if (inspectResult?.status !== 0) {
    console.log(`  Building ${agent.displayName} base image (first time only)...`);
    const buildResult = dockerBuild(baseDockerfile, baseImageTag, ROOT, {
      ignoreError: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (buildResult.error || buildResult.status !== 0) {
      const detail = buildResult.error
        ? `: ${buildResult.error.message}`
        : ` (exit ${buildResult.status ?? "unknown"})`;
      throw new Error(`Failed to build ${agent.displayName} base image${detail}`);
    }
    console.log(`  \u2713 Base image built: ${baseImageTag}`);
    return { imageTag: baseImageTag, built: true };
  }

  console.log(`  Base image exists: ${baseImageTag}`);
  return { imageTag: baseImageTag, built: false };
}
