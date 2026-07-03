// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerBuild, dockerRmi } from "../../adapters/docker";
import type { AgentDefinition } from "../../agent/defs";
import { createAgentSandbox } from "../../agent/onboard";
import type { WebSearchConfig } from "../../inference/web-search";
import { stageCreateSandboxBuildContext } from "../../onboard/build-context-stage";
import { prepareSandboxDockerfilePatch } from "../../onboard/sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "../../onboard/sandbox-gpu-mode";
import { ROOT } from "../../runner";
import { OPENCLAW_SANDBOX_BASE_IMAGE, SANDBOX_BASE_TAG } from "../../sandbox-base-image";

type PreflightInput = {
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

type PreflightDeps = {
  stageBuildContext?: typeof stageCreateSandboxBuildContext;
  prepareDockerfilePatch?: typeof prepareSandboxDockerfilePatch;
  buildImage?: typeof dockerBuild;
  removeImage?: typeof dockerRmi;
};

export type RebuildImagePreflightResult =
  | { ok: true; imageTag: string | null }
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
    cleanup = staged.cleanupBuildCtx;
    await preparePatch({
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
      log: () => {},
      warn: () => {},
    });
    imageTag = `nemoclaw-rebuild-preflight:${String(process.pid)}-${String(Date.now())}`;
    const result = buildImage(staged.stagedDockerfile, imageTag, staged.buildCtx, {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0
      ? { ok: true, imageTag }
      : { ok: false, detail: resultDetail(result) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (imageTag) removeImage(imageTag, { ignoreError: true, suppressOutput: true });
    cleanup?.();
    if (previousReasoning === undefined) delete process.env.NEMOCLAW_REASONING;
    else process.env.NEMOCLAW_REASONING = previousReasoning;
  }
}
