// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import { dockerBuild, dockerRmi } from "../../adapters/docker";
import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import type { AgentDefinition } from "../../agent/defs";
import { createAgentSandbox } from "../../agent/onboard";
import { GATEWAY_PORT } from "../../core/ports";
import type { WebSearchConfig } from "../../inference/web-search";
import { stageCreateSandboxBuildContext } from "../../onboard/build-context-stage";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import { prepareSandboxDockerfilePatch } from "../../onboard/sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { ROOT, redact } from "../../runner";
import {
  formatBuildFailureDiagnostics,
  OPENCLAW_SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
} from "../../sandbox-base-image";
import type { ToolDisclosure } from "../../tool-disclosure";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";
import {
  createBuildContextVerifier,
  createIdempotentBuildContextCleanup,
  disposePreparedBuildContext,
  type FingerprintedPreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";

export type ManagedDcodeRebuildImageInput = {
  agent: AgentDefinition;
  model: string;
  provider: string;
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: "true" | "false" | null;
  webSearchConfig: WebSearchConfig | null;
  toolDisclosure: ToolDisclosure;
  dcodeAutoApprovalMode: DcodeAutoApprovalMode;
  sandboxGpuConfig: SandboxGpuConfig;
  gatewayPort?: number;
};

export type ManagedDcodeRebuildImageDeps = {
  stageBuildContext?: typeof stageCreateSandboxBuildContext;
  prepareDockerfilePatch?: typeof prepareSandboxDockerfilePatch;
  buildImage?: typeof dockerBuild;
  removeImage?: typeof dockerRmi;
  createImageTag?: () => string;
};

export type PreparedDcodeRebuildImage = FingerprintedPreparedBuildContext & {
  dcodeAutoApprovalMode: DcodeAutoApprovalMode;
  dockerGpuPatchNetwork: string | null;
};

export type ManagedDcodeRebuildImageResult =
  | { ok: true; prepared: PreparedDcodeRebuildImage }
  | { ok: false; detail: string };

function errorDetail(error: unknown): string {
  if (error === null || error === undefined) return "";
  return redact(error instanceof Error ? error.message : String(error)).trim();
}

function buildResultDetail(result: {
  error?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  status?: unknown;
}): string {
  const detail = [errorDetail(result.error), formatBuildFailureDiagnostics(result)]
    .filter(Boolean)
    .join("; ");
  return detail || `docker build exited with status ${String(result.status ?? "unknown")}`;
}

function defaultImageTag(): string {
  return `nemoclaw-rebuild-preflight:${String(process.pid)}-${crypto.randomUUID()}`;
}

/** Confirm that the retained, private build context still matches the prebuilt input. */
export function verifyPreparedDcodeRebuildImage(prepared: PreparedDcodeRebuildImage): boolean {
  return verifyPreparedBuildContext(prepared);
}

/** Dispose the retained context after onboard consumes it or rebuild aborts. */
export function disposePreparedDcodeRebuildImage(prepared: PreparedDcodeRebuildImage): boolean {
  return disposePreparedBuildContext(prepared);
}

/**
 * Stage, patch, and successfully build the managed DCode replacement inputs
 * while the current sandbox is still intact. OpenShell performs the final build,
 * so the pinned base and fingerprinted context are retained and revalidated.
 */
export async function prepareManagedDcodeRebuildImage(
  input: ManagedDcodeRebuildImageInput,
  deps: ManagedDcodeRebuildImageDeps = {},
): Promise<ManagedDcodeRebuildImageResult> {
  if (input.agent.name !== DCODE_AGENT_NAME) {
    return { ok: false, detail: `managed DCode image expected agent '${DCODE_AGENT_NAME}'` };
  }

  const stage = deps.stageBuildContext ?? stageCreateSandboxBuildContext;
  const preparePatch = deps.prepareDockerfilePatch ?? prepareSandboxDockerfilePatch;
  const buildImage = deps.buildImage ?? dockerBuild;
  const removeImage = deps.removeImage ?? dockerRmi;
  const imageTag = (deps.createImageTag ?? defaultImageTag)();
  const previousDockerGpuPatchNetwork = process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
  const previousReasoning = process.env.NEMOCLAW_REASONING;
  let cleanupBuildContext: (() => boolean) | null = null;
  let imageBuilt = false;
  let retainBuildContext = false;

  try {
    // Recompute the patch decision from the recorded target rather than a
    // caller's unrelated ambient rebuild environment.
    delete process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
    if (input.provider === "compatible-endpoint") {
      process.env.NEMOCLAW_REASONING = input.compatibleEndpointReasoning ?? "false";
    } else {
      delete process.env.NEMOCLAW_REASONING;
    }

    const staged = stage({
      root: ROOT,
      fromDockerfile: null,
      agent: input.agent,
      createAgentSandbox,
      log: () => {},
      warn: () => {},
      error: () => {},
      exit: (code): never => {
        throw new Error(`managed build-context staging exited with code ${String(code ?? 1)}`);
      },
    });
    cleanupBuildContext = createIdempotentBuildContextCleanup(staged.cleanupBuildCtx);

    const { buildId } = await preparePatch({
      agent: input.agent,
      fromDockerfile: null,
      sandboxBaseImage: OPENCLAW_SANDBOX_BASE_IMAGE,
      sandboxBaseTag: SANDBOX_BASE_TAG,
      stagedDockerfile: staged.stagedDockerfile,
      model: input.model,
      chatUiUrl: "",
      provider: input.provider,
      preferredInferenceApi: input.preferredInferenceApi,
      webSearchConfig: input.webSearchConfig,
      toolDisclosure: input.toolDisclosure,
      dcodeAutoApprovalMode: input.dcodeAutoApprovalMode,
      hermesToolGateways: [],
      sandboxGpuConfig: input.sandboxGpuConfig,
      gatewayPort: input.gatewayPort ?? GATEWAY_PORT,
      log: () => {},
      warn: () => {},
    });

    const contextFingerprint = fingerprintBuildContext(staged.buildCtx);
    const result = buildImage(staged.stagedDockerfile, imageTag, staged.buildCtx, {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return { ok: false, detail: buildResultDetail(result) };
    imageBuilt = true;
    if (fingerprintBuildContext(staged.buildCtx) !== contextFingerprint) {
      return { ok: false, detail: "managed DCode build context changed during preflight" };
    }

    retainBuildContext = true;
    return {
      ok: true,
      prepared: {
        ...staged,
        cleanupBuildCtx: cleanupBuildContext,
        buildId,
        contextFingerprint,
        dcodeAutoApprovalMode: input.dcodeAutoApprovalMode,
        verifyBuildCtx: createBuildContextVerifier(staged.buildCtx, contextFingerprint),
        dockerGpuPatchNetwork: process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK || null,
      },
    };
  } catch (error) {
    return { ok: false, detail: errorDetail(error) || "managed DCode image preflight failed" };
  } finally {
    let imageRemoved = false;
    try {
      imageRemoved =
        removeImage(imageTag, { ignoreError: true, suppressOutput: true }).status === 0;
    } catch {
      // Best effort; build-context and environment cleanup must still run.
    }
    if (imageBuilt && !imageRemoved) {
      console.warn(`  Warning: failed to remove temporary DCode preflight image '${imageTag}'.`);
      process.once("exit", () => {
        try {
          removeImage(imageTag, { ignoreError: true, suppressOutput: true });
        } catch {
          // Best effort process-exit retry.
        }
      });
    }
    if (!retainBuildContext && cleanupBuildContext) {
      try {
        cleanupBuildContext();
      } catch {
        // Preserve the original preflight error.
      }
    }
    if (previousDockerGpuPatchNetwork === undefined) {
      delete process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK;
    } else {
      process.env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK = previousDockerGpuPatchNetwork;
    }
    if (previousReasoning === undefined) delete process.env.NEMOCLAW_REASONING;
    else process.env.NEMOCLAW_REASONING = previousReasoning;
  }
}
