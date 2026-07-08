// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  dockerBuild,
  dockerCapture,
  dockerImageInspect,
  dockerImageInspectFormat,
  dockerRmi,
  dockerTag,
} from "../adapters/docker";
import { ROOT } from "../runner";
import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../sandbox/build-context";
import {
  buildLocalBaseTag,
  createSandboxBaseImageResolutionKey,
  createSandboxBaseImageResolutionMetadata,
  getImageGlibcVersion,
  type ResolveBaseImageOptions,
  resolveSandboxBaseImage,
  SANDBOX_BASE_TAG,
  type SandboxBaseImageResolution,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import { createDeepAgentsCodeBaseImageResolutionOptions } from "./deep-agents-code-base-image";
import type { AgentDefinition } from "./defs";

const HERMES_MCP_RUNTIME_PROBE_OK = "nemoclaw-hermes-mcp-runtime-ok";
// Matches the official Hermes base repository for both Dockerfile manifest-list
// pins and Docker-normalized platform manifest digests.
const HERMES_OFFICIAL_BASE_DIGEST_REF =
  /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/;

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

export interface CreateAgentSandboxResult {
  buildCtx: string;
  stagedDockerfile: string;
  baseImageResolutionMetadata: SandboxBaseImageResolutionMetadata | null;
}

export function getAgentSandboxBaseImageEnvVar(agentName: string): string {
  return `NEMOCLAW_${agentName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_SANDBOX_BASE_IMAGE_REF`;
}

function immutableLocalBaseImageTag(agentName: string, imageId: string): string {
  const match = imageId.trim().match(/^sha256:([0-9a-f]{64})$/i);
  if (!match) {
    throw new Error(`Docker returned an invalid image ID for ${agentName} base image`);
  }
  return `nemoclaw-${agentName}-sandbox-base-local:image-${match[1].toLowerCase()}`;
}

export function pinAgentSandboxBaseImageRef(agentName: string, imageRef: string): string {
  if (imageRef.includes("@sha256:")) return imageRef;
  const imageId = dockerImageInspectFormat("{{.Id}}", imageRef, { ignoreError: true });
  const pinnedRef = immutableLocalBaseImageTag(agentName, imageId);
  if (imageRef === pinnedRef) return pinnedRef;
  const tagResult = dockerTag(imageRef, pinnedRef, { ignoreError: true });
  if (tagResult.error || tagResult.status !== 0) {
    const detail = tagResult.error
      ? `: ${tagResult.error.message}`
      : ` (exit ${tagResult.status ?? "unknown"})`;
    throw new Error(`Failed to pin ${agentName} base image${detail}`);
  }
  return pinnedRef;
}

function getHermesPinnedRemoteBaseRef(agent: AgentDefinition): string | null {
  if (agent.name !== "hermes") return null;
  const finalDockerfile = agent.dockerfilePath;
  if (!finalDockerfile) {
    throw new Error("Hermes is missing its final sandbox Dockerfile");
  }
  let dockerfile: string;
  try {
    dockerfile = fs.readFileSync(finalDockerfile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read Hermes final Dockerfile: ${finalDockerfile}`, {
      cause: error,
    });
  }
  const declarations = [...dockerfile.matchAll(/^ARG BASE_IMAGE=(\S+)$/gm)].map(
    (match) => match[1],
  );
  const pinnedRef = declarations.length === 1 ? declarations[0] : null;
  if (!pinnedRef || !HERMES_OFFICIAL_BASE_DIGEST_REF.test(pinnedRef)) {
    throw new Error(
      "Hermes final Dockerfile must declare exactly one immutable official sandbox base image",
    );
  }
  return pinnedRef;
}

/**
 * Accept only trusted resolver output here. Pinned platform digests are valid
 * only when the resolver records the current Dockerfile-pinned ref as their
 * provenance; string callers and explicit overrides stay exact-match only.
 */
function hermesFinalDockerfileAcceptsBase(
  agent: AgentDefinition,
  image: string | SandboxBaseImageResolution,
): boolean {
  if (agent.name !== "hermes") return true;
  const imageRef = typeof image === "string" ? image : image.ref;
  if (
    imageRef === "nemoclaw-hermes-base-local" ||
    /^nemoclaw-hermes-(?:root-entrypoint-base|sandbox-base-local|secret-boundary-base|stale-openclaw-dir-base|stale-openclaw-link-base):[^\s]+$/.test(
      imageRef,
    )
  ) {
    return true;
  }
  if (
    typeof image !== "string" &&
    image.source === "pinned" &&
    image.pinnedRemoteRef === getHermesPinnedRemoteBaseRef(agent) &&
    HERMES_OFFICIAL_BASE_DIGEST_REF.test(imageRef)
  ) {
    return true;
  }
  return imageRef === getHermesPinnedRemoteBaseRef(agent);
}

/**
 * Verify that a Hermes base contains both the MCP SDK and Hermes' native
 * Streamable HTTP integration. Version output alone is insufficient because
 * these dependencies are installed through an optional upstream extra.
 */
export function hermesBaseImageSupportsMcp(imageRef: string): boolean {
  const output = dockerCapture(
    [
      "run",
      "--rm",
      "--entrypoint",
      "/opt/hermes/.venv/bin/python",
      imageRef,
      "-c",
      `import mcp; from tools import mcp_tool; assert getattr(mcp_tool, "_MCP_AVAILABLE", False); assert getattr(mcp_tool, "_MCP_HTTP_AVAILABLE", False); print("${HERMES_MCP_RUNTIME_PROBE_OK}")`,
    ],
    { ignoreError: true, timeout: 20_000 },
  );
  return output.trim() === HERMES_MCP_RUNTIME_PROBE_OK;
}

function createAgentBaseImageResolutionOptions(
  agent: AgentDefinition,
  dockerfilePath: string,
  options: EnsureAgentBaseImageOptions,
): ResolveBaseImageOptions {
  const imageName = `ghcr.io/nvidia/nemoclaw/${agent.name}-sandbox-base`;
  const validationOptions =
    agent.name === "hermes"
      ? {
          validateImage: hermesBaseImageSupportsMcp,
          validationDescription: "the required MCP Streamable HTTP runtime",
        }
      : createDeepAgentsCodeBaseImageResolutionOptions(agent, dockerfilePath);
  const pinnedRemoteRef = getHermesPinnedRemoteBaseRef(agent) ?? undefined;
  return {
    imageName,
    dockerfilePath,
    localTag: buildLocalBaseTag(`nemoclaw-${agent.name}-sandbox-base-local`, ROOT),
    envVar: getAgentSandboxBaseImageEnvVar(agent.name),
    label: `${agent.displayName} sandbox base image`,
    requireOpenshellSandboxAbi: process.platform === "linux",
    resolutionHint: options.resolutionHint,
    forceRefresh: options.forceBaseImageRefresh,
    rootDir: ROOT,
    pinnedRemoteRef,
    preferPinnedRemoteRef: agent.name === "hermes" && pinnedRemoteRef !== undefined,
    ...validationOptions,
  };
}

function createLocalResolutionMetadata(
  options: ResolveBaseImageOptions,
  imageTag: string,
  glibcVersion?: string | null,
): SandboxBaseImageResolutionMetadata | null {
  return createSandboxBaseImageResolutionMetadata(
    options,
    createSandboxBaseImageResolutionKey(options),
    {
      ref: imageTag,
      digest: null,
      source: "local",
      glibcVersion:
        glibcVersion === undefined
          ? process.platform === "linux"
            ? getImageGlibcVersion(imageTag)
            : null
          : glibcVersion,
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

  if (!baseDockerfile) {
    return { imageTag: null, built: false };
  }

  const resolutionOptions = createAgentBaseImageResolutionOptions(agent, baseDockerfile, options);
  const baseImageName = resolutionOptions.imageName;
  const baseImageTag = `${baseImageName}:${SANDBOX_BASE_TAG}`;
  const overrideEnvVar = getAgentSandboxBaseImageEnvVar(agent.name);
  const resolveExactImage = (imageRef: string) =>
    resolveSandboxBaseImage({
      ...resolutionOptions,
      localTag: imageRef,
      env: {
        ...process.env,
        [overrideEnvVar]: imageRef,
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
      },
    });

  if (options.forceBaseImageRebuild === true) {
    const forceBuildTag = `nemoclaw-${agent.name}-sandbox-base-local:build-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    console.log(`  Rebuilding ${agent.displayName} base image...`);
    const buildResult = dockerBuild(baseDockerfile, forceBuildTag, ROOT, {
      ignoreError: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (buildResult.error || buildResult.status !== 0) {
      dockerRmi(forceBuildTag, { ignoreError: true, suppressOutput: true });
      const detail = buildResult.error
        ? `: ${buildResult.error.message}`
        : ` (exit ${buildResult.status ?? "unknown"})`;
      throw new Error(`Failed to build ${agent.displayName} base image${detail}`);
    }
    try {
      const pinnedBaseImageTag = pinAgentSandboxBaseImageRef(agent.name, forceBuildTag);
      const resolved = resolveExactImage(pinnedBaseImageTag);
      if (!resolved) {
        throw new Error(
          `Built ${agent.displayName} base image failed the required runtime compatibility checks`,
        );
      }
      if (!hermesFinalDockerfileAcceptsBase(agent, pinnedBaseImageTag)) {
        throw new Error(
          `Hermes final image does not accept base image ref '${pinnedBaseImageTag}'; use the tracked official digest or a repository-built local base`,
        );
      }
      console.log(`  \u2713 Base image built: ${pinnedBaseImageTag}`);
      const resolutionMetadata = createLocalResolutionMetadata(
        resolutionOptions,
        pinnedBaseImageTag,
        resolved.glibcVersion,
      );
      return {
        imageTag: pinnedBaseImageTag,
        built: true,
        ...(resolutionMetadata ? { resolutionMetadata } : {}),
      };
    } finally {
      dockerRmi(forceBuildTag, { ignoreError: true, suppressOutput: true });
    }
  }

  const explicitOverride = process.env[overrideEnvVar]?.trim();
  const resolved = explicitOverride
    ? resolveExactImage(explicitOverride)
    : resolveSandboxBaseImage(resolutionOptions);
  if (resolved) {
    if (!hermesFinalDockerfileAcceptsBase(agent, resolved)) {
      throw new Error(
        `Hermes final image does not accept base image ref '${resolved.ref}'; use the tracked official digest or a repository-built local base`,
      );
    }
    console.log(`  Using ${agent.displayName} base image: ${resolved.ref}`);
    return {
      imageTag: resolved.ref,
      built: false,
      ...(resolved.metadata ? { resolutionMetadata: resolved.metadata } : {}),
    };
  }
  if (process.platform === "linux" || resolutionOptions.validateImage) {
    throw new Error(
      `No compatible ${agent.displayName} sandbox base image found for ${baseImageName}`,
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
    const resolutionMetadata = createLocalResolutionMetadata(resolutionOptions, baseImageTag);
    return {
      imageTag: baseImageTag,
      built: true,
      ...(resolutionMetadata ? { resolutionMetadata } : {}),
    };
  }

  console.log(`  Base image exists: ${baseImageTag}`);
  const resolutionMetadata = createLocalResolutionMetadata(resolutionOptions, baseImageTag);
  return {
    imageTag: baseImageTag,
    built: false,
    ...(resolutionMetadata ? { resolutionMetadata } : {}),
  };
}

/** Stage build context for an agent-specific sandbox image. */
export function createAgentSandbox(
  agent: AgentDefinition,
  options: EnsureAgentBaseImageOptions = {},
): CreateAgentSandboxResult {
  const agentDockerfile = agent.dockerfilePath;

  if (!agentDockerfile) {
    throw new Error(`${agent.displayName} is missing a sandbox Dockerfile`);
  }

  const { imageTag: baseImageRef, resolutionMetadata } = ensureAgentBaseImage(agent, options);
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
  fs.cpSync(ROOT, buildCtx, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return !["node_modules", ".git", ".venv", "__pycache__", ".claude"].includes(base);
    },
  });
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.copyFileSync(agentDockerfile, stagedDockerfile);
  if (baseImageRef) {
    const dockerfile = fs.readFileSync(stagedDockerfile, "utf8");
    fs.writeFileSync(
      stagedDockerfile,
      dockerfile.replace(/^ARG BASE_IMAGE(?:=.*)?$/m, `ARG BASE_IMAGE=${baseImageRef}`),
    );
  }
  console.log(`  Using ${agent.displayName} Dockerfile: ${agentDockerfile}`);

  return {
    buildCtx,
    stagedDockerfile,
    baseImageResolutionMetadata: resolutionMetadata ?? null,
  };
}
