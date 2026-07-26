// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
  parseTemporarySandboxBaseImageId,
  readSandboxBaseImageResolutionMetadata,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";

type StagedAgentBuild = {
  buildCtx: string;
  stagedDockerfile: string;
  baseImageResolutionMetadata: SandboxBaseImageResolutionMetadata | null;
};

type CreateAgentSandbox = (
  agent: AgentDefinition,
  options: {
    resolutionHint?: SandboxBaseImageResolutionMetadata | null;
    forceBaseImageRefresh?: boolean;
  },
) => StagedAgentBuild;

export type BaseImageResolutionContext = {
  resolutionHint: SandboxBaseImageResolutionMetadata | null;
  preResolvedMetadata: SandboxBaseImageResolutionMetadata | null;
  forceRefresh: boolean;
};

export function isSandboxBaseImageRefreshRequested(env: NodeJS.ProcessEnv): boolean {
  const value = String(env.NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

export function createBaseImageResolutionContext(options: {
  fresh: boolean;
  initialHint?: SandboxBaseImageResolutionMetadata | null;
  initialPreResolvedMetadata?: SandboxBaseImageResolutionMetadata | null;
  env?: NodeJS.ProcessEnv;
}): BaseImageResolutionContext {
  return {
    resolutionHint: options.initialHint ?? null,
    preResolvedMetadata: options.initialPreResolvedMetadata ?? null,
    forceRefresh: options.fresh || isSandboxBaseImageRefreshRequested(options.env ?? process.env),
  };
}

export function captureBaseResolution(
  context: BaseImageResolutionContext,
  sandboxImageRef: string | null | undefined,
): void {
  if (!context.forceRefresh && !context.resolutionHint && sandboxImageRef) {
    context.resolutionHint = readSandboxBaseImageResolutionMetadata(sandboxImageRef);
  }
}

function isDisposableLocalRebuildMetadata(
  agentName: string,
  metadata: SandboxBaseImageResolutionMetadata,
): boolean {
  if (metadata.source !== "local" || metadata.digest !== null) return false;
  const imageId = metadata.imageId.match(/^sha256:([0-9a-f]{64})$/i)?.[0]?.toLowerCase();
  return (
    imageId !== undefined &&
    parseTemporarySandboxBaseImageId(`nemoclaw-${agentName}-sandbox-base-local`, metadata.ref) ===
      imageId
  );
}

function isStableMetadataForDisposableHandoff(
  agentName: string,
  stable: SandboxBaseImageResolutionMetadata | null,
  staged: SandboxBaseImageResolutionMetadata | null,
): boolean {
  if (
    !stable ||
    !staged ||
    stable.source !== "local" ||
    stable.digest !== null ||
    isDisposableLocalRebuildMetadata(agentName, stable) ||
    !isDisposableLocalRebuildMetadata(agentName, staged)
  ) {
    return false;
  }
  return (
    stable.schema === staged.schema &&
    stable.key === staged.key &&
    stable.imageName === staged.imageName &&
    stable.imageId === staged.imageId &&
    stable.os === staged.os &&
    stable.architecture === staged.architecture &&
    stable.glibcVersion === staged.glibcVersion &&
    stable.requireOpenshellSandboxAbi === staged.requireOpenshellSandboxAbi &&
    stable.minGlibcVersion === staged.minGlibcVersion
  );
}

export function createAgentSandboxWithResolution(
  context: BaseImageResolutionContext,
  agent: AgentDefinition,
  createAgentSandbox: CreateAgentSandbox,
): StagedAgentBuild {
  const staged = createAgentSandbox(agent, {
    resolutionHint: context.resolutionHint,
    forceBaseImageRefresh: context.forceRefresh,
  });
  if (staged.baseImageResolutionMetadata) {
    if (isDisposableLocalRebuildMetadata(agent.name, staged.baseImageResolutionMetadata)) {
      if (
        !isStableMetadataForDisposableHandoff(
          agent.name,
          context.preResolvedMetadata,
          staged.baseImageResolutionMetadata,
        )
      ) {
        throw new Error(
          "Temporary rebuild base-image metadata did not match the stable outer resolution",
        );
      }
    } else {
      context.preResolvedMetadata = staged.baseImageResolutionMetadata;
    }
  }
  return staged;
}

export function getBaseImageResolutionPatchOptions(context: BaseImageResolutionContext): {
  resolutionHint: SandboxBaseImageResolutionMetadata | null;
  preResolvedBaseImageMetadata: SandboxBaseImageResolutionMetadata | null;
  forceBaseImageRefresh: boolean;
} {
  return {
    resolutionHint: context.resolutionHint,
    preResolvedBaseImageMetadata: context.preResolvedMetadata,
    forceBaseImageRefresh: context.forceRefresh,
  };
}
