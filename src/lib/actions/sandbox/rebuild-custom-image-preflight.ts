// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerBuild, dockerRmi } from "../../adapters/docker";
import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import type { AgentDefinition } from "../../agent/defs";
import { createAgentSandbox } from "../../agent/onboard";
import type { WebSearchConfig } from "../../inference/web-search";
import type { SandboxMessagingPlan } from "../../messaging";
import { stageCreateSandboxBuildContext } from "../../onboard/build-context-stage";
import { patchStagedDockerfileMessagingPlan } from "../../onboard/dockerfile-patch";
import {
  prepareDockerBuildEnvironment,
  type DockerBuildEnvironmentInput,
} from "../../onboard/sandbox-prebuild";
import {
  applyReasoningEffortEnv,
  REASONING_EFFORT_ENV,
  type ReasoningEffort,
} from "../../onboard/reasoning-mode";
import { prepareSandboxDockerfilePatch } from "../../onboard/sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { ROOT } from "../../runner";
import {
  formatBuildFailureDiagnostics,
  OPENCLAW_SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
  type SandboxBaseImageResolutionMetadata,
} from "../../sandbox-base-image";
import type { PreservedEnvFile } from "../../state/preserved-env";
import type { ToolDisclosure } from "../../tool-disclosure";
import {
  createBuildContextVerifier,
  createIdempotentBuildContextCleanup,
  type FingerprintedPreparedBuildContext,
  verifyPreparedBuildContext,
} from "./rebuild-prepared-image-context";

type PreflightInput = {
  agent: AgentDefinition | null;
  fromDockerfile: string | null;
  model: string;
  provider: string | null;
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: "true" | "false" | null;
  compatibleEndpointReasoningEffort: ReasoningEffort | null;
  webSearchConfig: WebSearchConfig | null;
  toolDisclosure: ToolDisclosure;
  hermesToolGateways: string[];
  sandboxGpuConfig: SandboxGpuConfig;
  gatewayPort: number;
  chatUiUrl: string;
  preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata | null;
};

type PreflightDeps = {
  stageBuildContext?: typeof stageCreateSandboxBuildContext;
  prepareDockerfilePatch?: typeof prepareSandboxDockerfilePatch;
  buildImage?: typeof dockerBuild;
  removeImage?: typeof dockerRmi;
  registerExitHandler?: (listener: () => void) => void;
} & RebuildImageBuildEnvironmentDeps;

export type PreparedRebuildImage = FingerprintedPreparedBuildContext & {
  rebuildTarget: {
    agentName: string | null;
    fromDockerfile: string | null;
  };
};

export type RebuildImagePreflightResult =
  | { ok: true; imageTag: string; prepared: PreparedRebuildImage }
  | { ok: false; detail: string };

type FinalizePreparedImageDeps = {
  patchMessagingPlan?: typeof patchStagedDockerfileMessagingPlan;
  buildImage?: typeof dockerBuild;
  removeImage?: typeof dockerRmi;
  registerExitHandler?: (listener: () => void) => void;
} & RebuildImageBuildEnvironmentDeps;

type RebuildImageBuildEnvironmentDeps = DockerBuildEnvironmentInput & {
  prepareBuildEnvironment?: typeof prepareDockerBuildEnvironment;
};

function resultDetail(result: {
  error?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  status?: unknown;
}): string {
  return (
    formatBuildFailureDiagnostics(result) ||
    `docker build exited with status ${String(result.status ?? "unknown")}`
  );
}

function buildReplacementImage(
  dockerfile: string,
  imageTag: string,
  buildContext: string,
  origin: PreparedRebuildImage["origin"],
  buildImage: typeof dockerBuild,
  deps: RebuildImageBuildEnvironmentDeps,
) {
  const preparedEnvironment = (deps.prepareBuildEnvironment ?? prepareDockerBuildEnvironment)({
    env: deps.env,
    credentialHelperResponds: deps.credentialHelperResponds,
    isWslHost: deps.isWslHost,
    allowCredentialIsolation: origin === "generated",
  });
  try {
    return buildImage(dockerfile, imageTag, buildContext, {
      env: preparedEnvironment.env,
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    preparedEnvironment.cleanup();
  }
}

function removeTemporaryRebuildImage(
  imageTag: string | null,
  imageBuilt: boolean,
  label: "preflight" | "finalization",
  removeImage: typeof dockerRmi,
  registerExitHandler: (listener: () => void) => void,
): void {
  let imageRemoved = false;
  try {
    imageRemoved =
      imageTag !== null &&
      removeImage(imageTag, { ignoreError: true, suppressOutput: true }).status === 0;
  } catch {
    // Best effort; retained-context ownership and environment restoration must continue.
  }
  if (!imageBuilt || !imageTag || imageRemoved) return;
  const retainedImageTag = imageTag;
  console.warn(
    `  Warning: failed to remove temporary rebuild ${label} image '${retainedImageTag}'.`,
  );
  registerExitHandler(() => {
    try {
      removeImage(retainedImageTag, { ignoreError: true, suppressOutput: true });
    } catch {
      // Best effort process-exit retry.
    }
  });
}

export async function preflightRebuildImage(
  input: PreflightInput,
  deps: PreflightDeps = {},
): Promise<RebuildImagePreflightResult> {
  const stage = deps.stageBuildContext ?? stageCreateSandboxBuildContext;
  const preparePatch = deps.prepareDockerfilePatch ?? prepareSandboxDockerfilePatch;
  const buildImage = deps.buildImage ?? dockerBuild;
  const removeImage = deps.removeImage ?? dockerRmi;
  const registerExitHandler =
    deps.registerExitHandler ?? ((listener: () => void) => process.once("exit", listener));
  let cleanup: (() => boolean) | null = null;
  let imageTag: string | null = null;
  let imageBuilt = false;
  let retainBuildContext = false;
  const previousReasoning = process.env.NEMOCLAW_REASONING;
  const previousReasoningEffort = process.env[REASONING_EFFORT_ENV];
  try {
    if (input.provider === "compatible-endpoint") {
      process.env.NEMOCLAW_REASONING = input.compatibleEndpointReasoning ?? "false";
      applyReasoningEffortEnv(input.compatibleEndpointReasoningEffort);
    } else {
      delete process.env.NEMOCLAW_REASONING;
      delete process.env[REASONING_EFFORT_ENV];
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
    const { buildId, dashboardRemoteBindPrepared } = await preparePatch({
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
      preResolvedBaseImageMetadata: input.preResolvedBaseImageMetadata ?? null,
      gatewayPort: input.gatewayPort,
      log: () => {},
      warn: () => {},
    });
    const contextFingerprint = fingerprintBuildContext(staged.buildCtx);
    imageTag = `nemoclaw-rebuild-preflight:${String(process.pid)}-${String(Date.now())}`;
    const result = buildReplacementImage(
      staged.stagedDockerfile,
      imageTag,
      staged.buildCtx,
      staged.origin,
      buildImage,
      deps,
    );
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
        dashboardRemoteBindPrepared,
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
    removeTemporaryRebuildImage(
      imageTag,
      imageBuilt,
      "preflight",
      removeImage,
      registerExitHandler,
    );
    if (!retainBuildContext) {
      try {
        cleanup?.();
      } catch {
        // Preserve the original preflight result.
      }
    }
    if (previousReasoning === undefined) delete process.env.NEMOCLAW_REASONING;
    else process.env.NEMOCLAW_REASONING = previousReasoning;
    if (previousReasoningEffort === undefined) delete process.env[REASONING_EFFORT_ENV];
    else process.env[REASONING_EFFORT_ENV] = previousReasoningEffort;
  }
}

export function finalizePreparedRebuildImageMessagingPlan(
  prepared: PreparedRebuildImage,
  messagingPlan: SandboxMessagingPlan,
  preservedEnv: readonly PreservedEnvFile[],
  deps: FinalizePreparedImageDeps = {},
): RebuildImagePreflightResult {
  if (!verifyPreparedBuildContext(prepared)) {
    return { ok: false, detail: "replacement build context changed before backup finalization" };
  }
  const patchMessagingPlan = deps.patchMessagingPlan ?? patchStagedDockerfileMessagingPlan;
  const buildImage = deps.buildImage ?? dockerBuild;
  const removeImage = deps.removeImage ?? dockerRmi;
  const registerExitHandler =
    deps.registerExitHandler ?? ((listener: () => void) => process.once("exit", listener));
  const imageTag = `nemoclaw-rebuild-finalize:${String(process.pid)}-${String(Date.now())}`;
  let imageBuilt = false;
  try {
    patchMessagingPlan(prepared.stagedDockerfile, messagingPlan, preservedEnv);
    const contextFingerprint = fingerprintBuildContext(prepared.buildCtx);
    const result = buildReplacementImage(
      prepared.stagedDockerfile,
      imageTag,
      prepared.buildCtx,
      prepared.origin,
      buildImage,
      deps,
    );
    if (result.status !== 0) return { ok: false, detail: resultDetail(result) };
    imageBuilt = true;
    if (fingerprintBuildContext(prepared.buildCtx) !== contextFingerprint) {
      return { ok: false, detail: "replacement build context changed during backup finalization" };
    }
    return {
      ok: true,
      imageTag,
      prepared: {
        ...prepared,
        contextFingerprint,
        verifyBuildCtx: createBuildContextVerifier(prepared.buildCtx, contextFingerprint),
      },
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    removeTemporaryRebuildImage(
      imageTag,
      imageBuilt,
      "finalization",
      removeImage,
      registerExitHandler,
    );
  }
}
