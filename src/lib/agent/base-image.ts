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
import {
  buildLocalBaseTag,
  resolveSandboxBaseImage,
  SANDBOX_BASE_TAG,
} from "../sandbox-base-image";
import type { AgentDefinition } from "./defs";

const HERMES_MCP_RUNTIME_PROBE_OK = "nemoclaw-hermes-mcp-runtime-ok";

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

function hermesFinalDockerfileAcceptsBase(agent: AgentDefinition, imageRef: string): boolean {
  if (agent.name !== "hermes") return true;
  if (
    imageRef === "nemoclaw-hermes-base-local" ||
    /^nemoclaw-hermes-(?:root-entrypoint-base|sandbox-base-local|secret-boundary-base|stale-openclaw-dir-base|stale-openclaw-link-base):[^\s]+$/.test(
      imageRef,
    )
  ) {
    return true;
  }
  if (!imageRef.startsWith("ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:")) return false;
  const finalDockerfile = agent.dockerfilePath;
  if (!finalDockerfile) return false;
  let dockerfile: string;
  try {
    dockerfile = fs.readFileSync(finalDockerfile, "utf8");
  } catch {
    return false;
  }
  const declarations = [...dockerfile.matchAll(/^ARG BASE_IMAGE=(\S+)$/gm)].map(
    (match) => match[1],
  );
  return (
    declarations.length === 1 &&
    /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/.test(
      declarations[0] ?? "",
    ) &&
    imageRef === declarations[0]
  );
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

/**
 * Ensure the agent-specific sandbox base image exists locally.
 * Rebuild callers can force this so local Dockerfile.base edits are applied.
 */
export function ensureAgentBaseImage(
  agent: AgentDefinition,
  opts: { forceBaseImageRebuild?: boolean } = {},
): {
  imageTag: string | null;
  built: boolean;
} {
  const baseDockerfile = agent.dockerfileBasePath;

  if (!baseDockerfile) {
    return { imageTag: null, built: false };
  }

  const baseImageName = `ghcr.io/nvidia/nemoclaw/${agent.name}-sandbox-base`;
  const baseImageTag = `${baseImageName}:${SANDBOX_BASE_TAG}`;
  const localBaseImageTag = buildLocalBaseTag(`nemoclaw-${agent.name}-sandbox-base-local`, ROOT);
  const overrideEnvVar = getAgentSandboxBaseImageEnvVar(agent.name);
  const validateImage = agent.name === "hermes" ? hermesBaseImageSupportsMcp : undefined;
  const validationDescription =
    agent.name === "hermes" ? "the required MCP Streamable HTTP runtime" : undefined;
  const resolutionOptions = {
    imageName: baseImageName,
    dockerfilePath: baseDockerfile,
    localTag: localBaseImageTag,
    envVar: overrideEnvVar,
    label: `${agent.displayName} sandbox base image`,
    requireOpenshellSandboxAbi: process.platform === "linux",
    rootDir: ROOT,
    validateImage,
    validationDescription,
  };
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
  const forceBaseImageRebuild = opts.forceBaseImageRebuild === true;
  if (forceBaseImageRebuild) {
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
      return { imageTag: pinnedBaseImageTag, built: true };
    } finally {
      dockerRmi(forceBuildTag, { ignoreError: true, suppressOutput: true });
    }
  }

  const explicitOverride = process.env[overrideEnvVar]?.trim();
  const resolved = explicitOverride
    ? resolveExactImage(explicitOverride)
    : resolveSandboxBaseImage(resolutionOptions);
  if (resolved && !forceBaseImageRebuild) {
    if (!hermesFinalDockerfileAcceptsBase(agent, resolved.ref)) {
      throw new Error(
        `Hermes final image does not accept base image ref '${resolved.ref}'; use the tracked official digest or a repository-built local base`,
      );
    }
    console.log(`  Using ${agent.displayName} base image: ${resolved.ref}`);
    return { imageTag: resolved.ref, built: false };
  }
  if (!resolved && (process.platform === "linux" || validateImage) && !forceBaseImageRebuild) {
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
    return { imageTag: baseImageTag, built: true };
  }

  console.log(`  Base image exists: ${baseImageTag}`);
  return { imageTag: baseImageTag, built: false };
}

/** Stage build context for an agent-specific sandbox image. */
export function createAgentSandbox(
  agent: AgentDefinition,
  opts: { forceBaseImageRebuild?: boolean } = {},
): {
  buildCtx: string;
  stagedDockerfile: string;
} {
  const agentDockerfile = agent.dockerfilePath;

  if (!agentDockerfile) {
    throw new Error(`${agent.displayName} is missing a sandbox Dockerfile`);
  }

  const { imageTag: baseImageRef } = ensureAgentBaseImage(agent, opts);
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
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

  return { buildCtx, stagedDockerfile };
}
