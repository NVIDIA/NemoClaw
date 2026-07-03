// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import { dockerBuild, dockerRmi } from "../../adapters/docker";
import type { AgentDefinition } from "../../agent/defs";
import { createAgentSandbox } from "../../agent/onboard";
import type { WebSearchConfig } from "../../inference/web-search";
import {
  type CreateSandboxBuildContextResult,
  type PreparedSandboxBuildContext,
  stageCreateSandboxBuildContext,
} from "../../onboard/build-context-stage";
import { prepareSandboxDockerfilePatch } from "../../onboard/sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { ROOT, redact } from "../../runner";
import {
  formatBuildFailureDiagnostics,
  OPENCLAW_SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
} from "../../sandbox-base-image";

export type RebuildImagePreflightInput = {
  agent: AgentDefinition | null;
  fromDockerfile: string | null;
  model: string;
  provider: string | null;
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: "true" | "false" | null;
  webSearchConfig: WebSearchConfig | null;
  hermesToolGateways: string[];
  sandboxGpuConfig: SandboxGpuConfig;
  gatewayPort: number;
  chatUiUrl: string;
};

export type RebuildImagePreflightDeps = {
  stageBuildContext?: typeof stageCreateSandboxBuildContext;
  prepareDockerfilePatch?: typeof prepareSandboxDockerfilePatch;
  buildImage?: typeof dockerBuild;
  removeImage?: typeof dockerRmi;
  createImageTag?: () => string;
};

export type PreparedRebuildBuildContext = PreparedSandboxBuildContext & {
  dockerGpuPatchNetwork: string | null;
};

export type RebuildImagePreflightResult =
  | { ok: true; preparedBuildContext: PreparedRebuildBuildContext }
  | { ok: false; detail: string };

function errorDetail(error: unknown): string {
  if (error === null || error === undefined) return "";
  return redact(error instanceof Error ? error.message : String(error)).trim();
}

function resultDetail(result: {
  error?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  status?: unknown;
}): string {
  const details = [errorDetail(result.error), formatBuildFailureDiagnostics(result)]
    .filter(Boolean)
    .join("; ");
  return details || `docker build exited with status ${String(result.status ?? "unknown")}`;
}

function defaultImageTag(): string {
  return `nemoclaw-rebuild-preflight:${String(process.pid)}-${crypto.randomUUID()}`;
}

function cleanupBuildContextWithExitFallback(cleanupBuildCtx: () => boolean): boolean {
  const cleaned = cleanupBuildCtx();
  if (cleaned) process.removeListener("exit", cleanupBuildCtx);
  return cleaned;
}

function installBuildContextCleanupFallback(
  cleanupBuildCtx: () => boolean,
  cleanupSignalResources: () => void,
): () => boolean {
  let armed = true;
  const remove = () => {
    if (!armed) return;
    armed = false;
    process.removeListener("exit", cleanup);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
  const cleanup = () => {
    const cleaned = cleanupBuildCtx();
    if (cleaned) remove();
    return cleaned;
  };
  const handle = (signal: "SIGINT" | "SIGTERM") => {
    try {
      cleanup();
    } finally {
      try {
        cleanupSignalResources();
      } finally {
        process.kill(process.pid, signal);
      }
    }
  };
  const onSigint = () => handle("SIGINT");
  const onSigterm = () => handle("SIGTERM");
  process.on("exit", cleanup);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return cleanup;
}

/** Release a successful preflight context after onboard consumed it or rebuild aborted. */
export function cleanupPreparedRebuildBuildContext(prepared: PreparedRebuildBuildContext): boolean {
  return cleanupBuildContextWithExitFallback(prepared.cleanupBuildCtx);
}

/**
 * Stage, patch, and build the replacement image while the current sandbox is
 * still intact. The throwaway tag and staged context are always cleaned up;
 * Docker's layer cache remains available to the real recreate.
 */
export async function preflightRebuildImage(
  input: RebuildImagePreflightInput,
  deps: RebuildImagePreflightDeps = {},
): Promise<RebuildImagePreflightResult> {
  const stage = deps.stageBuildContext ?? stageCreateSandboxBuildContext;
  const preparePatch = deps.prepareDockerfilePatch ?? prepareSandboxDockerfilePatch;
  const buildImage = deps.buildImage ?? dockerBuild;
  const removeImage = deps.removeImage ?? dockerRmi;
  const imageTag = (deps.createImageTag ?? defaultImageTag)();
  let cleanupBuildContext: (() => boolean) | null = null;
  let retainBuildContext = false;
  const previousReasoning = process.env.NEMOCLAW_REASONING;
  const previousDockerGpuPatchNetwork = process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;

  try {
    delete process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
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
    cleanupBuildContext = installBuildContextCleanupFallback(staged.cleanupBuildCtx, () => {
      try {
        removeImage(imageTag, { ignoreError: true, suppressOutput: true });
      } catch {
        // Best effort before re-raising the signal.
      }
    });

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
      hermesToolGateways: input.hermesToolGateways,
      sandboxGpuConfig: input.sandboxGpuConfig,
      gatewayPort: input.gatewayPort,
      exitOnFailure: false,
      log: () => {},
      warn: () => {},
    });

    const result = buildImage(staged.stagedDockerfile, imageTag, staged.buildCtx, {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return { ok: false, detail: resultDetail(result) };

    // Transfer the exact patched context to the destructive recreate. dcode
    // rewrites NEMOCLAW_BUILD_ID on every patch, so restaging after deletion
    // would not recreate the image that passed this preflight.
    retainBuildContext = true;
    return {
      ok: true,
      preparedBuildContext: {
        ...staged,
        cleanupBuildCtx: cleanupBuildContext,
        buildId,
        dockerGpuPatchNetwork: process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK || null,
      },
    };
  } catch (error) {
    return { ok: false, detail: errorDetail(error) || "replacement image preflight failed" };
  } finally {
    try {
      removeImage(imageTag, { ignoreError: true, suppressOutput: true });
    } catch {
      // Best effort: cleanup errors must not prevent build-context/env cleanup.
    }
    if (!retainBuildContext && cleanupBuildContext) {
      // installBuildContextCleanupFallback already armed an exit safety net.
      // Leave that single listener in place if inline cleanup fails because a
      // staged context may contain copied source or secret-bearing inputs.
      try {
        cleanupBuildContextWithExitFallback(cleanupBuildContext);
      } catch {
        // Best effort: preserve the original preflight result.
      }
    }
    if (previousReasoning === undefined) delete process.env.NEMOCLAW_REASONING;
    else process.env.NEMOCLAW_REASONING = previousReasoning;
    if (previousDockerGpuPatchNetwork === undefined) {
      delete process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
    } else {
      process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK = previousDockerGpuPatchNetwork;
    }
  }
}
