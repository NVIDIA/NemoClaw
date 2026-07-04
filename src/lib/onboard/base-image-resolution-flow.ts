// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
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
  env?: NodeJS.ProcessEnv;
}): BaseImageResolutionContext {
  return {
    resolutionHint: options.initialHint ?? null,
    preResolvedMetadata: null,
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

export function createAgentSandboxWithResolution(
  context: BaseImageResolutionContext,
  agent: AgentDefinition,
  createAgentSandbox: CreateAgentSandbox,
): StagedAgentBuild {
  const staged = createAgentSandbox(agent, {
    resolutionHint: context.resolutionHint,
    forceBaseImageRefresh: context.forceRefresh,
  });
  context.preResolvedMetadata = staged.baseImageResolutionMetadata;
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
