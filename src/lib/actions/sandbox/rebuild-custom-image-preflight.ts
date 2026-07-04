// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerBuild, dockerRmi } from "../../adapters/docker";
import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import type { AgentDefinition } from "../../agent/defs";
import { createAgentSandbox } from "../../agent/onboard";
import type { WebSearchConfig } from "../../inference/web-search";
import { stageCreateSandboxBuildContext } from "../../onboard/build-context-stage";
import { prepareSandboxDockerfilePatch } from "../../onboard/sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { ROOT } from "../../runner";
import { OPENCLAW_SANDBOX_BASE_IMAGE, SANDBOX_BASE_TAG } from "../../sandbox-base-image";
import type { ToolDisclosure } from "../../tool-disclosure";
import {
  createBuildContextVerifier,
  createIdempotentBuildContextCleanup,
  type FingerprintedPreparedBuildContext,
} from "./rebuild-prepared-image-context";

type PreflightInput = {
  agent: AgentDefinition | null;
  fromDockerfile: string | null;
  model: string;
  provider: string | null;
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: "true" | "false" | null;
  webSearchConfig: WebSearchConfig | null;
  toolDisclosure: ToolDisclosure;
  hermesToolGateways: string[];
  sandboxGpuConfig: SandboxGpuConfig;
  gatewayPort: number;
  chatUiUrl: string;
};

type PreflightDeps = {
  stageBuildContext?: typeof stageCreateSandboxBuildContext;
  prepareDockerfilePatch?: typeof prepareSandboxDockerfilePatch;
  buildImage?: typeof dockerBuild;
  removeImage?: typeof dockerRmi;
};

export type PreparedRebuildImage = FingerprintedPreparedBuildContext & {
  rebuildTarget: {
    agentName: string | null;
    fromDockerfile: string | null;
  };
};

export type RebuildImagePreflightResult =
  | { ok: true; imageTag: string; prepared: PreparedRebuildImage }
  | { ok: false; detail: string };

function resultDetail(result: { stderr?: unknown; stdout?: unknown; status?: unknown }): string {
  return (
    [result.stderr, result.stdout]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("; ") || `docker build exited with status ${String(result.status ?? "unknown")}`
  );
}

export async function preflightRebuildImage(
  input: PreflightInput,
  deps: PreflightDeps = {},
): Promise<RebuildImagePreflightResult> {
  const stage = deps.stageBuildContext ?? stageCreateSandboxBuildContext;
  const preparePatch = deps.prepareDockerfilePatch ?? prepareSandboxDockerfilePatch;
  const buildImage = deps.buildImage ?? dockerBuild;
  const removeImage = deps.removeImage ?? dockerRmi;
  let cleanup: (() => boolean) | null = null;
  let imageTag: string | null = null;
  let imageBuilt = false;
  let retainBuildContext = false;
  const previousReasoning = process.env.NEMOCLAW_REASONING;
  try {
    if (input.provider === "compatible-endpoint") {
      process.env.NEMOCLAW_REASONING = input.compatibleEndpointReasoning ?? "false";
    } else {
      delete process.env.NEMOCLAW_REASONING;
    }
    const staged = stage({
      root: ROOT,
      fromDockerfile: input.fromDockerfile,
      agent: input.agent,
      createAgentSandbox,
      log: () => {},
      warn: () => {},
      error: () => {},
      exit: (code): never => {
        throw new Error(`custom build-context staging exited with code ${String(code ?? 1)}`);
      },
    });
    cleanup = createIdempotentBuildContextCleanup(staged.cleanupBuildCtx);
    const { buildId } = await preparePatch({
      agent: input.agent,
      fromDockerfile: input.fromDockerfile,
      sandboxBaseImage: OPENCLAW_SANDBOX_BASE_IMAGE,
      sandboxBaseTag: SANDBOX_BASE_TAG,
      stagedDockerfile: staged.stagedDockerfile,
      model: input.model,
      chatUiUrl: input.chatUiUrl,
      provider: input.provider,
      preferredInferenceApi: input.preferredInferenceApi,
      webSearchConfig: input.webSearchConfig,
      toolDisclosure: input.toolDisclosure,
      hermesToolGateways: input.hermesToolGateways,
      sandboxGpuConfig: input.sandboxGpuConfig,
      gatewayPort: input.gatewayPort,
      log: () => {},
      warn: () => {},
    });
    const contextFingerprint = fingerprintBuildContext(staged.buildCtx);
    imageTag = `nemoclaw-rebuild-preflight:${String(process.pid)}-${String(Date.now())}`;
    const result = buildImage(staged.stagedDockerfile, imageTag, staged.buildCtx, {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return { ok: false, detail: resultDetail(result) };
    imageBuilt = true;
    if (fingerprintBuildContext(staged.buildCtx) !== contextFingerprint) {
      return { ok: false, detail: "replacement build context changed during preflight" };
    }
    retainBuildContext = true;
    return {
      ok: true,
      imageTag,
      prepared: {
        ...staged,
        cleanupBuildCtx: cleanup,
        buildId,
        contextFingerprint,
        verifyBuildCtx: createBuildContextVerifier(staged.buildCtx, contextFingerprint),
        rebuildTarget: {
          agentName: input.agent?.name ?? null,
          fromDockerfile: input.fromDockerfile ? path.resolve(input.fromDockerfile) : null,
        },
      },
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    let imageRemoved = false;
    try {
      imageRemoved =
        imageTag !== null &&
        removeImage(imageTag, { ignoreError: true, suppressOutput: true }).status === 0;
    } catch {
      // Best effort; retained-context ownership and environment restoration must continue.
    }
    if (imageBuilt && imageTag && !imageRemoved) {
      const retainedImageTag = imageTag;
      console.warn(
        `  Warning: failed to remove temporary rebuild preflight image '${retainedImageTag}'.`,
      );
      process.once("exit", () => {
        try {
          removeImage(retainedImageTag, { ignoreError: true, suppressOutput: true });
        } catch {
          // Best effort process-exit retry.
        }
      });
    }
    if (!retainBuildContext) {
      try {
        cleanup?.();
      } catch {
        // Preserve the original preflight result.
      }
    }
    if (previousReasoning === undefined) delete process.env.NEMOCLAW_REASONING;
    else process.env.NEMOCLAW_REASONING = previousReasoning;
  }
}
