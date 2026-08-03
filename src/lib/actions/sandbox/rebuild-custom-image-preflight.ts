// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  dockerBuild,
  dockerRmi,
  type DockerBuildOptions,
  type DockerRunOptions,
  type DockerRunResult,
} from "../../adapters/docker";
import { dockerSpawnSync } from "../../adapters/docker/exec";
import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import type { AgentDefinition } from "../../agent/defs";
import { createAgentSandbox } from "../../agent/onboard";
import type { WebSearchConfig } from "../../inference/web-search";
import type { SandboxMessagingPlan } from "../../messaging";
import { stageCreateSandboxBuildContext } from "../../onboard/build-context-stage";
import { patchStagedDockerfileMessagingPlan } from "../../onboard/dockerfile-patch";
import {
  applyReasoningEffortEnv,
  REASONING_EFFORT_ENV,
  type ReasoningEffort,
} from "../../onboard/reasoning-mode";
import { prepareSandboxDockerfilePatch } from "../../onboard/sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { dockerBuildSubprocessEnv, sandboxLocalImageRef } from "../../onboard/sandbox-prebuild";
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
  captureOpenClawLegacyDockerBinding,
  createPreparedOpenClawLegacyImage,
  disposeOpenClawLegacyDockerImage,
  inspectOpenClawLegacyImageId,
  type OpenClawLegacyDockerBinding,
} from "./rebuild/openclaw-legacy-image";
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
  sandboxName: string;
  /** Whether recreation can consume an image built by the host Docker engine. */
  localPrebuildEnabled: boolean;
  gatewayPort: number;
  chatUiUrl: string;
  preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata | null;
};

type PreflightDeps = {
  stageBuildContext?: typeof stageCreateSandboxBuildContext;
  prepareDockerfilePatch?: typeof prepareSandboxDockerfilePatch;
  buildImage?: BuildImage;
  removeImage?: RemoveImage;
  buildxAvailable?: (process: DockerProofProcess) => boolean;
  buildDockerEnv?: () => Record<string, string>;
  captureLegacyDockerBinding?: typeof captureOpenClawLegacyDockerBinding;
  inspectLegacyImageId?: typeof inspectOpenClawLegacyImageId;
  createLegacyImage?: typeof createPreparedOpenClawLegacyImage;
  disposeLegacyImage?: typeof disposeOpenClawLegacyDockerImage;
  registerExitHandler?: (listener: () => void) => void;
};

type BuildImage = (
  dockerfilePath: string,
  tag: string,
  contextDir: string,
  options: DockerBuildOptions,
) => DockerRunResult;

type RemoveImage = (imageRef: string, options: NonNullable<DockerRunOptions>) => DockerRunResult;

type DockerProofProcess = {
  cwd: string;
  env: NodeJS.ProcessEnv;
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

type FinalizePreparedImageDeps = {
  patchMessagingPlan?: typeof patchStagedDockerfileMessagingPlan;
  buildImage?: typeof dockerBuild;
  removeImage?: typeof dockerRmi;
  registerExitHandler?: (listener: () => void) => void;
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

const BUILDX_UNAVAILABLE_DIAGNOSTIC =
  "BuildKit is enabled but the buildx component is missing or broken";

function hasBuildxUnavailableDiagnostic(result: {
  error?: unknown;
  stderr?: unknown;
  stdout?: unknown;
}): boolean {
  return [result.error, result.stderr, result.stdout].some((stream) => {
    if (stream == null) return false;
    const text = Buffer.isBuffer(stream) ? stream.toString("utf8") : String(stream);
    return text.includes(BUILDX_UNAVAILABLE_DIAGNOSTIC);
  });
}

function legacyRetryFailureDetail(
  buildKitResult: Parameters<typeof resultDetail>[0],
  legacyResult: Parameters<typeof resultDetail>[0],
): string {
  return formatBuildFailureDiagnostics({
    stderr:
      `Legacy-builder retry failed:\n${resultDetail(legacyResult)}\n` +
      `Initial BuildKit attempt failed:\n${resultDetail(buildKitResult)}`,
  });
}

function exactDockerBuild(
  dockerfilePath: string,
  tag: string,
  contextDir: string,
  options: DockerBuildOptions,
): DockerRunResult {
  const {
    env,
    ignoreError: _ignoreError,
    quiet,
    stdio,
    suppressOutput: _suppressOutput,
    ...spawnOptions
  } = options;
  return dockerSpawnSync(
    ["build", ...(quiet ? ["--quiet"] : []), "-f", dockerfilePath, "-t", tag, contextDir],
    {
      ...spawnOptions,
      cwd: ROOT,
      env: { ...env, DOCKER_BUILDKIT: env?.DOCKER_BUILDKIT ?? "1" },
      shell: false,
      stdio: stdio ?? ["ignore", "pipe", "pipe"],
    },
  );
}

function exactDockerRemoveImage(
  imageRef: string,
  options: NonNullable<DockerRunOptions>,
): DockerRunResult {
  const {
    env,
    ignoreError: _ignoreError,
    stdio,
    suppressOutput: _suppressOutput,
    ...spawnOptions
  } = options;
  return dockerSpawnSync(["rmi", imageRef], {
    ...spawnOptions,
    cwd: ROOT,
    env,
    shell: false,
    stdio: stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function defaultBuildxAvailable(process: DockerProofProcess): boolean {
  try {
    return (
      dockerSpawnSync(["buildx", "version"], {
        cwd: process.cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }).status === 0
    );
  } catch {
    return false;
  }
}

function removeTemporaryRebuildImage(
  imageTag: string | null,
  imageBuilt: boolean,
  label: "finalization",
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
  const buildImage = deps.buildImage ?? exactDockerBuild;
  const removeImage = deps.removeImage ?? exactDockerRemoveImage;
  const buildxAvailable = deps.buildxAvailable ?? defaultBuildxAvailable;
  const buildDockerEnv = deps.buildDockerEnv ?? dockerBuildSubprocessEnv;
  const captureLegacyDockerBinding =
    deps.captureLegacyDockerBinding ?? captureOpenClawLegacyDockerBinding;
  const inspectLegacyImageId = deps.inspectLegacyImageId ?? inspectOpenClawLegacyImageId;
  const createLegacyImage = deps.createLegacyImage ?? createPreparedOpenClawLegacyImage;
  const disposeLegacyImage = deps.disposeLegacyImage ?? disposeOpenClawLegacyDockerImage;
  const registerExitHandler =
    deps.registerExitHandler ?? ((listener: () => void) => process.once("exit", listener));
  let cleanup: (() => boolean) | null = null;
  let imageTag: string | null = null;
  let imageBuilt = false;
  let retainBuildContext = false;
  let dockerEnv: Readonly<Record<string, string>> | null = null;
  let legacyBinding: OpenClawLegacyDockerBinding | null = null;
  let legacyImageId: string | null = null;
  let preparedLegacyImage: ReturnType<typeof createPreparedOpenClawLegacyImage> | null = null;
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
    const legacyFallbackEligible =
      staged.origin === "generated" &&
      input.agent === null &&
      input.fromDockerfile === null &&
      input.localPrebuildEnabled;
    if (legacyFallbackEligible) {
      legacyBinding = captureLegacyDockerBinding({ buildDockerEnv, cwd: ROOT });
      dockerEnv = legacyBinding.dockerEnv;
    } else {
      dockerEnv = Object.freeze({ ...buildDockerEnv() });
    }
    imageTag = sandboxLocalImageRef(
      input.sandboxName,
      `rebuild-preflight-${buildId}-${String(process.pid)}-${String(Date.now())}`,
    );
    const buildOptions: DockerBuildOptions = {
      cwd: ROOT,
      env: dockerEnv,
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const buildKitResult = buildImage(
      staged.stagedDockerfile,
      imageTag,
      staged.buildCtx,
      buildOptions,
    );
    let result = buildKitResult;
    let usedLegacyFallback = false;
    if (
      result.status !== 0 &&
      legacyFallbackEligible &&
      legacyBinding !== null &&
      hasBuildxUnavailableDiagnostic(result) &&
      !buildxAvailable({ cwd: ROOT, env: legacyBinding.dockerEnv })
    ) {
      // SOURCE_OF_TRUTH_REVIEW (#7111): the generated OpenClaw final-image
      // Dockerfile does not use BuildKit-only instructions. Retry its exact
      // fingerprinted bytes once with Docker's compatibility builder only
      // after an independent Buildx probe confirms the host CLI lacks it.
      // Dockerfile.base, other agents, and custom --from contexts never enter
      // this fallback. Remove it when the supported Docker floor no longer
      // provides the legacy builder.
      if (fingerprintBuildContext(staged.buildCtx) !== contextFingerprint) {
        return { ok: false, detail: "replacement build context changed during preflight" };
      }
      console.warn(
        "  Warning: Docker Buildx is unavailable; retrying the generated OpenClaw rebuild image with Docker's legacy builder.",
      );
      usedLegacyFallback = true;
      result = buildImage(staged.stagedDockerfile, imageTag, staged.buildCtx, {
        ...buildOptions,
        env: { ...legacyBinding.dockerEnv, DOCKER_BUILDKIT: "0" },
      });
    }
    if (result.status !== 0 && usedLegacyFallback) {
      return { ok: false, detail: legacyRetryFailureDetail(buildKitResult, result) };
    }
    if (result.status !== 0) return { ok: false, detail: resultDetail(result) };
    imageBuilt = true;
    if (fingerprintBuildContext(staged.buildCtx) !== contextFingerprint) {
      return { ok: false, detail: "replacement build context changed during preflight" };
    }
    if (legacyBinding) {
      legacyImageId = inspectLegacyImageId(legacyBinding, imageTag);
    }
    if (usedLegacyFallback && legacyBinding && legacyImageId) {
      preparedLegacyImage = createLegacyImage(legacyBinding, imageTag, legacyImageId);
    }
    retainBuildContext = true;
    const verifyFingerprint = createBuildContextVerifier(staged.buildCtx, contextFingerprint);
    const prepared: PreparedRebuildImage = {
      ...staged,
      cleanupBuildCtx: cleanup,
      buildId,
      dashboardRemoteBindPrepared,
      preparedOpenClawLegacyImage: preparedLegacyImage ?? undefined,
      contextFingerprint,
      verifyBuildCtx(this: PreparedRebuildImage) {
        return (
          this === prepared &&
          this.preparedOpenClawLegacyImage === (preparedLegacyImage ?? undefined) &&
          verifyFingerprint()
        );
      },
      rebuildTarget: {
        agentName: input.agent?.name ?? null,
        fromDockerfile: input.fromDockerfile ? path.resolve(input.fromDockerfile) : null,
      },
    };
    return {
      ok: true,
      imageTag,
      prepared,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    let imageRemoved = false;
    if (preparedLegacyImage === null && imageTag !== null) {
      try {
        imageRemoved = legacyBinding
          ? legacyImageId !== null && disposeLegacyImage(legacyBinding, imageTag, legacyImageId)
          : removeImage(imageTag, {
              cwd: ROOT,
              env: dockerEnv ?? undefined,
              ignoreError: true,
              suppressOutput: true,
            }).status === 0;
      } catch {
        // Best effort; retained-context ownership and environment restoration must continue.
      }
    }
    if (
      preparedLegacyImage === null &&
      imageTag !== null &&
      legacyBinding !== null &&
      legacyImageId === null
    ) {
      console.warn(
        `  Warning: temporary rebuild preflight image '${imageTag}' has no verified immutable cleanup identity; leaving its unique tag for maintenance cleanup.`,
      );
    }
    if (
      imageBuilt &&
      preparedLegacyImage === null &&
      imageTag &&
      !imageRemoved &&
      (legacyBinding === null || legacyImageId !== null)
    ) {
      const retainedImageTag = imageTag;
      const retainedDockerEnv = dockerEnv;
      const retainedLegacyBinding = legacyBinding;
      const retainedLegacyImageId = legacyImageId;
      console.warn(
        `  Warning: failed to remove temporary rebuild preflight image '${retainedImageTag}'.`,
      );
      registerExitHandler(() => {
        try {
          if (retainedLegacyBinding) {
            if (retainedLegacyImageId !== null) {
              disposeLegacyImage(retainedLegacyBinding, retainedImageTag, retainedLegacyImageId);
            }
          } else {
            removeImage(retainedImageTag, {
              cwd: ROOT,
              env: retainedDockerEnv ?? undefined,
              ignoreError: true,
              suppressOutput: true,
            });
          }
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
    const result = buildImage(prepared.stagedDockerfile, imageTag, prepared.buildCtx, {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
