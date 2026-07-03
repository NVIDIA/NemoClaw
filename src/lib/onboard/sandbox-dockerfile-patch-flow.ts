// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { WebSearchConfig } from "../inference/web-search";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

type DockerRunResult = { status: number | null };
type PullAndResolveBaseImageDigest = typeof import("./base-image").pullAndResolveBaseImageDigest;
type ResolvedSandboxBaseImage = NonNullable<ReturnType<PullAndResolveBaseImageDigest>>;
type EnforceDockerGpuPatchPreserveNetwork =
  typeof import("./docker-gpu-local-inference").enforceDockerGpuPatchPreserveNetwork;
type PatchStagedDockerfile = typeof import("./dockerfile-patch").patchStagedDockerfile;

const STABLE_MANAGED_BUILD_ID_AGENTS = new Set(["openclaw", "hermes"]);

export type SandboxDockerfilePatchDeps = {
  pullAndResolveBaseImageDigest?: PullAndResolveBaseImageDigest;
  dockerImageInspect?: (target: string, opts?: Record<string, unknown>) => DockerRunResult;
  isLinuxDockerDriverGatewayEnabled?: () => boolean;
  enforceDockerGpuPatchPreserveNetwork?: EnforceDockerGpuPatchPreserveNetwork;
  patchStagedDockerfile?: PatchStagedDockerfile;
  now?: () => number;
};

export type PrepareSandboxDockerfilePatchInput = {
  agent: AgentDefinition | null | undefined;
  fromDockerfile: string | null;
  sandboxBaseImage: string;
  sandboxBaseTag: string;
  stagedDockerfile: string;
  model: string;
  chatUiUrl: string;
  provider: string | null;
  preferredInferenceApi: string | null;
  webSearchConfig: WebSearchConfig | null;
  hermesToolGateways: string[];
  sandboxGpuConfig: SandboxGpuConfig;
  gatewayPort?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  deps?: SandboxDockerfilePatchDeps;
};

export type SandboxDockerfilePatchResult = {
  buildId: string;
  resolvedBaseImage: ResolvedSandboxBaseImage | null;
};

function pullAndResolveBaseImageDigest(
  options: Parameters<PullAndResolveBaseImageDigest>[0],
): ReturnType<PullAndResolveBaseImageDigest> {
  const { pullAndResolveBaseImageDigest: impl } =
    require("./base-image") as typeof import("./base-image");
  return impl(options);
}

function inspectDockerImage(target: string, opts?: Record<string, unknown>): DockerRunResult {
  const { dockerImageInspect } =
    require("../adapters/docker") as typeof import("../adapters/docker");
  return dockerImageInspect(target, opts as Parameters<typeof dockerImageInspect>[1]);
}

function linuxDockerDriverGatewayEnabled(): boolean {
  const { isLinuxDockerDriverGatewayEnabled } =
    require("./docker-driver-platform") as typeof import("./docker-driver-platform");
  return isLinuxDockerDriverGatewayEnabled();
}

function enforceDockerGpuPatchPreserveNetwork(
  ...args: Parameters<EnforceDockerGpuPatchPreserveNetwork>
): ReturnType<EnforceDockerGpuPatchPreserveNetwork> {
  const { enforceDockerGpuPatchPreserveNetwork: impl } =
    require("./docker-gpu-local-inference") as typeof import("./docker-gpu-local-inference");
  return impl(...args);
}

function patchStagedDockerfile(
  ...args: Parameters<PatchStagedDockerfile>
): ReturnType<PatchStagedDockerfile> {
  const { patchStagedDockerfile: impl } =
    require("./dockerfile-patch") as typeof import("./dockerfile-patch");
  return impl(...args);
}

export async function prepareSandboxDockerfilePatch({
  agent,
  fromDockerfile,
  sandboxBaseImage,
  sandboxBaseTag,
  stagedDockerfile,
  model,
  chatUiUrl,
  provider,
  preferredInferenceApi,
  webSearchConfig,
  hermesToolGateways,
  sandboxGpuConfig,
  gatewayPort,
  log = console.log,
  warn = console.warn,
  deps = {},
}: PrepareSandboxDockerfilePatchInput): Promise<SandboxDockerfilePatchResult> {
  const shouldResolveBaseImage = !(agent && !fromDockerfile);
  const getDockerDriverGateway =
    deps.isLinuxDockerDriverGatewayEnabled ?? linuxDockerDriverGatewayEnabled;
  const resolved = shouldResolveBaseImage
    ? (deps.pullAndResolveBaseImageDigest ?? pullAndResolveBaseImageDigest)({
        requireOpenshellSandboxAbi: getDockerDriverGateway(),
      })
    : null;
  if (resolved?.digest) {
    log(`  Pinning base image to ${resolved.digest.slice(0, 19)}...`);
  } else if (resolved) {
    log(`  Using sandbox base image ${resolved.ref}`);
  } else if (shouldResolveBaseImage) {
    const localCheck = (deps.dockerImageInspect ?? inspectDockerImage)(
      `${sandboxBaseImage}:${sandboxBaseTag}`,
      {
        ignoreError: true,
        suppressOutput: true,
      },
    );
    if (localCheck.status === 0) {
      warn("  Warning: could not pull base image from registry; using cached :latest.");
    } else {
      warn(`  Warning: base image ${sandboxBaseImage}:${sandboxBaseTag} is not available locally.`);
      warn("  The build will fail unless Docker can pull the image during build.");
      warn("  If offline, pull the image manually first:");
      warn(`    docker pull ${sandboxBaseImage}:${sandboxBaseTag}`);
    }
  }

  const buildId = String((deps.now ?? Date.now)());
  await (deps.enforceDockerGpuPatchPreserveNetwork ?? enforceDockerGpuPatchPreserveNetwork)(
    provider,
    sandboxGpuConfig,
    {
      dockerDriverGateway: getDockerDriverGateway(),
      gatewayPort,
      log,
    },
  );
  const darwinVmCompat = false;
  // Preserve the compatibility ARG only for managed Dockerfiles that are
  // checked in here and known not to consume it. Custom --from Dockerfiles
  // and other managed agents retain the historical per-run rewrite.
  const managedAgentName = agent?.name ?? "openclaw";
  const buildIdPolicy =
    !fromDockerfile && STABLE_MANAGED_BUILD_ID_AGENTS.has(managedAgentName)
      ? "preserve"
      : "rewrite";
  (deps.patchStagedDockerfile ?? patchStagedDockerfile)(
    stagedDockerfile,
    model,
    chatUiUrl,
    buildId,
    provider,
    preferredInferenceApi,
    webSearchConfig,
    resolved ? resolved.ref : null,
    darwinVmCompat,
    null,
    hermesToolGateways,
    { buildIdPolicy },
  );

  return { buildId, resolvedBaseImage: resolved };
}
