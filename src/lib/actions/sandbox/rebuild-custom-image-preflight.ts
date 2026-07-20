// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { DockerBuildOptions, DockerRunOptions, DockerRunResult } from "../../adapters/docker";
import { dockerSpawnSync } from "../../adapters/docker/exec";
import { fingerprintBuildContext } from "../../adapters/fs/build-context-fingerprint";
import type { AgentDefinition } from "../../agent/defs";
import { createAgentSandbox } from "../../agent/onboard";
import type { WebSearchConfig } from "../../inference/web-search";
import { stageCreateSandboxBuildContext } from "../../onboard/build-context-stage";
import { prepareSandboxDockerfilePatch } from "../../onboard/sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { dockerBuildSubprocessEnv } from "../../onboard/sandbox-prebuild";
import { ROOT } from "../../runner";
import {
  formatBuildFailureDiagnostics,
  OPENCLAW_SANDBOX_BASE_IMAGE,
  SANDBOX_BASE_TAG,
} from "../../sandbox-base-image";
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
  /** Whether recreation can consume an image built by the same host Docker daemon. */
  localPrebuildEnabled: boolean;
  gatewayPort: number;
  chatUiUrl: string;
};

type PreflightDeps = {
  stageBuildContext?: typeof stageCreateSandboxBuildContext;
  prepareDockerfilePatch?: typeof prepareSandboxDockerfilePatch;
  buildImage?: BuildImage;
  removeImage?: RemoveImage;
  buildxAvailable?: (process: DockerProofProcess) => boolean;
  buildDockerEnv?: () => Record<string, string>;
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
  let cleanup: (() => boolean) | null = null;
  let imageTag: string | null = null;
  let imageBuilt = false;
  let retainBuildContext = false;
  let dockerEnv: Readonly<Record<string, string>> | null = null;
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
      gatewayPort: input.gatewayPort,
      log: () => {},
      warn: () => {},
    });
    const contextFingerprint = fingerprintBuildContext(staged.buildCtx);
    dockerEnv = Object.freeze({ ...buildDockerEnv() });
    imageTag = `nemoclaw-rebuild-preflight:${String(process.pid)}-${String(Date.now())}`;
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
      staged.origin === "generated" &&
      input.agent === null &&
      input.localPrebuildEnabled &&
      hasBuildxUnavailableDiagnostic(result) &&
      !buildxAvailable({ cwd: ROOT, env: dockerEnv })
    ) {
      // SOURCE_OF_TRUTH_REVIEW (#7111): the generated OpenClaw final-image
      // Dockerfile does not use BuildKit-only instructions. Retry its exact
      // fingerprinted bytes once with Docker's compatibility builder only
      // after an independent buildx probe confirms the host CLI lacks it.
      // Dockerfile.base, other agents, and custom --from contexts never enter
      // this fallback. Remove it when the supported Docker floor no longer
      // provides the legacy builder.
      if (fingerprintBuildContext(staged.buildCtx) !== contextFingerprint) {
        return { ok: false, detail: "replacement build context changed during preflight" };
      }
      console.warn(
        "  Warning: Docker Buildx is unavailable; retrying the generated rebuild image with Docker's legacy builder.",
      );
      usedLegacyFallback = true;
      result = buildImage(staged.stagedDockerfile, imageTag, staged.buildCtx, {
        ...buildOptions,
        env: { ...dockerEnv, DOCKER_BUILDKIT: "0" },
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
    retainBuildContext = true;
    const prebuildBuilder = usedLegacyFallback ? "legacy" : undefined;
    const prebuildDockerEnv = usedLegacyFallback ? dockerEnv : undefined;
    const verifyFingerprint = createBuildContextVerifier(staged.buildCtx, contextFingerprint);
    const prepared: PreparedRebuildImage = {
      ...staged,
      cleanupBuildCtx: cleanup,
      buildId,
      dashboardRemoteBindPrepared,
      contextFingerprint,
      prebuildBuilder,
      prebuildDockerEnv,
      verifyBuildCtx(this: PreparedRebuildImage) {
        return (
          this === prepared &&
          this.prebuildBuilder === prebuildBuilder &&
          this.prebuildDockerEnv === prebuildDockerEnv &&
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
    try {
      imageRemoved =
        imageTag !== null &&
        removeImage(imageTag, {
          cwd: ROOT,
          env: dockerEnv ?? undefined,
          ignoreError: true,
          suppressOutput: true,
        }).status === 0;
    } catch {
      // Best effort; retained-context ownership and environment restoration must continue.
    }
    if (imageBuilt && imageTag && !imageRemoved) {
      const retainedImageTag = imageTag;
      const retainedDockerEnv = dockerEnv;
      console.warn(
        `  Warning: failed to remove temporary rebuild preflight image '${retainedImageTag}'.`,
      );
      process.once("exit", () => {
        try {
          removeImage(retainedImageTag, {
            cwd: ROOT,
            env: retainedDockerEnv ?? undefined,
            ignoreError: true,
            suppressOutput: true,
          });
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
