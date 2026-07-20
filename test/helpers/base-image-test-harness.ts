// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { vi } from "vitest";

import type { AgentDefinition } from "../../src/lib/agent/defs";

type AgentOnboardModule = typeof import("../../src/lib/agent/onboard");
type DockerRunModule = typeof import("../../src/lib/adapters/docker/run");
type DockerImageModule = typeof import("../../src/lib/adapters/docker/image");
type DockerInfoModule = typeof import("../../src/lib/adapters/docker/info");
type DockerInspectModule = typeof import("../../src/lib/adapters/docker/inspect");
type SandboxBaseImageModule = typeof import("../../src/lib/sandbox-base-image");
type SourceIdentityModule = typeof import("../../src/lib/sandbox-base-image/source-identity");

const requireSource = createRequire(
  new URL("../../src/lib/agent/base-image.test.ts", import.meta.url),
);

/** Build a minimal Hermes manifest for base-image provisioning tests. */
export function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "hermes",
    displayName: "Hermes Agent",
    healthProbe: { url: "http://127.0.0.1:8642/health", port: 8642, timeout_seconds: 90 },
    forwardPort: 8642,
    dashboard: {
      kind: "api",
      label: "OpenAI-compatible API",
      path: "/v1",
      healthPath: "/health",
      auth: "none",
    },
    webAuth: { method: "bearer_token", env: "API_SERVER_KEY" },
    configPaths: {
      dir: "/sandbox/.hermes",
      configFile: "config.yaml",
      envFile: ".env",
      format: "yaml",
    },
    inferenceProviderOptions: [],
    mcpCapability: {
      support: "disabled",
      reason: "test fixture",
    },
    stateDirs: [],
    runtimeAuthStateDirs: [],
    stateFiles: [],
    userManagedFiles: [],
    versionCommand: "hermes --version",
    expectedVersion: "2026.4.30",
    hasDevicePairing: false,
    phoneHomeHosts: [],
    dockerfileBasePath: "/test/root/agents/hermes/Dockerfile.base",
    dockerfilePath: path.resolve(import.meta.dirname, "../../agents/hermes/Dockerfile"),
    startScriptPath: null,
    policyAdditionsPath: null,
    policyPermissivePath: null,
    pluginDir: null,
    legacyPaths: null,
    agentDir: "/repo/root/agents/hermes",
    manifestPath: "/repo/root/agents/hermes/manifest.yaml",
    ...overrides,
  };
}

/** Load agent onboarding with source-backed Docker helpers replaced by mocks. */
export function withMockedDocker<T>(
  run: (deps: {
    ensureAgentBaseImage: AgentOnboardModule["ensureAgentBaseImage"];
    bindLocalAgentBaseImageToPinnedProvenance: AgentOnboardModule["bindLocalAgentBaseImageToPinnedProvenance"];
    pinAgentSandboxBaseImageRef: AgentOnboardModule["pinAgentSandboxBaseImageRef"];
    dockerBuildMock: ReturnType<typeof vi.fn>;
    dockerCaptureMock: ReturnType<typeof vi.fn>;
    dockerImageInspectMock: ReturnType<typeof vi.fn>;
    dockerImageInspectFormatMock: ReturnType<typeof vi.fn>;
    dockerRmiMock: ReturnType<typeof vi.fn>;
    dockerTagMock: ReturnType<typeof vi.fn>;
    resolveSandboxBaseImageMock: ReturnType<typeof vi.fn>;
    SandboxBaseImageResolutionError: SandboxBaseImageModule["SandboxBaseImageResolutionError"];
    root: string;
  }) => T,
): T {
  const dockerRunModule = requireSource("../adapters/docker/run.js") as DockerRunModule;
  const originalDockerCapture = dockerRunModule.dockerCapture;
  const dockerCaptureMock = vi.fn().mockReturnValue("nemoclaw-hermes-mcp-runtime-ok");
  dockerRunModule.dockerCapture = dockerCaptureMock as DockerRunModule["dockerCapture"];

  const dockerImageModule = requireSource("../adapters/docker/image.js") as DockerImageModule;
  const dockerInfoModule = requireSource("../adapters/docker/info.js") as DockerInfoModule;
  const dockerInspectModule = requireSource("../adapters/docker/inspect.js") as DockerInspectModule;
  const sandboxBaseImageModule = requireSource(
    "../sandbox-base-image.js",
  ) as SandboxBaseImageModule;
  const sourceIdentityModule = requireSource(
    "../sandbox-base-image/source-identity.js",
  ) as SourceIdentityModule;
  const runnerModule = requireSource("../runner.js") as { ROOT: string };
  const originalDockerBuild = dockerImageModule.dockerBuild;
  const originalDockerRmi = dockerImageModule.dockerRmi;
  const originalDockerTag = dockerImageModule.dockerTag;
  const originalDockerImageInspect = dockerInspectModule.dockerImageInspect;
  const originalDockerImageInspectFormat = dockerInspectModule.dockerImageInspectFormat;
  const originalDockerInfoFormat = dockerInfoModule.dockerInfoFormat;
  const originalResolveSandboxBaseImage = sandboxBaseImageModule.resolveSandboxBaseImage;
  const originalGetVersionedBaseImageTags = sourceIdentityModule.getVersionedBaseImageTags;
  const originalGetNearestVersionedBaseImageTags =
    sourceIdentityModule.getNearestVersionedBaseImageTags;
  const originalGetSourceShortShaTags = sourceIdentityModule.getSourceShortShaTags;
  const agentOnboardModulePath = requireSource.resolve("./onboard.js");
  delete require.cache[agentOnboardModulePath];

  const dockerBuildMock = vi.fn().mockReturnValue({ status: 0 });
  const dockerRmiMock = vi.fn().mockReturnValue({ status: 0 });
  const dockerTagMock = vi.fn().mockReturnValue({ status: 0 });
  const dockerImageInspectMock = vi.fn();
  const dockerImageInspectFormatMock = vi.fn().mockReturnValue(`sha256:${"a".repeat(64)}`);
  const dockerInfoFormatMock = vi.fn().mockReturnValue("linux/amd64\n");
  const resolveSandboxBaseImageMock = vi.fn().mockImplementation((options) => {
    const override = options.env?.[options.envVar];
    return {
      ref: override ?? "nemoclaw-hermes-sandbox-base-local:compatible",
      digest: null,
      source: override ? "override" : "local",
      glibcVersion: process.platform === "linux" ? "2.41" : null,
    };
  });
  dockerImageModule.dockerBuild = dockerBuildMock as DockerImageModule["dockerBuild"];
  dockerImageModule.dockerRmi = dockerRmiMock as DockerImageModule["dockerRmi"];
  dockerImageModule.dockerTag = dockerTagMock as DockerImageModule["dockerTag"];
  dockerInspectModule.dockerImageInspect =
    dockerImageInspectMock as DockerInspectModule["dockerImageInspect"];
  dockerInspectModule.dockerImageInspectFormat =
    dockerImageInspectFormatMock as DockerInspectModule["dockerImageInspectFormat"];
  dockerInfoModule.dockerInfoFormat = dockerInfoFormatMock as DockerInfoModule["dockerInfoFormat"];
  sandboxBaseImageModule.resolveSandboxBaseImage =
    resolveSandboxBaseImageMock as SandboxBaseImageModule["resolveSandboxBaseImage"];
  sourceIdentityModule.getVersionedBaseImageTags = () => [];
  sourceIdentityModule.getNearestVersionedBaseImageTags = () => [];
  sourceIdentityModule.getSourceShortShaTags = () => [];

  try {
    const agentOnboardModule = requireSource("./onboard.js") as AgentOnboardModule;
    return run({
      ensureAgentBaseImage: agentOnboardModule.ensureAgentBaseImage,
      bindLocalAgentBaseImageToPinnedProvenance:
        agentOnboardModule.bindLocalAgentBaseImageToPinnedProvenance,
      pinAgentSandboxBaseImageRef: agentOnboardModule.pinAgentSandboxBaseImageRef,
      dockerBuildMock,
      dockerCaptureMock,
      dockerImageInspectMock,
      dockerImageInspectFormatMock,
      dockerRmiMock,
      dockerTagMock,
      resolveSandboxBaseImageMock,
      SandboxBaseImageResolutionError: sandboxBaseImageModule.SandboxBaseImageResolutionError,
      root: runnerModule.ROOT,
    });
  } finally {
    dockerRunModule.dockerCapture = originalDockerCapture;
    dockerImageModule.dockerBuild = originalDockerBuild;
    dockerImageModule.dockerRmi = originalDockerRmi;
    dockerImageModule.dockerTag = originalDockerTag;
    dockerInspectModule.dockerImageInspect = originalDockerImageInspect;
    dockerInspectModule.dockerImageInspectFormat = originalDockerImageInspectFormat;
    dockerInfoModule.dockerInfoFormat = originalDockerInfoFormat;
    sandboxBaseImageModule.resolveSandboxBaseImage = originalResolveSandboxBaseImage;
    sourceIdentityModule.getVersionedBaseImageTags = originalGetVersionedBaseImageTags;
    sourceIdentityModule.getNearestVersionedBaseImageTags =
      originalGetNearestVersionedBaseImageTags;
    sourceIdentityModule.getSourceShortShaTags = originalGetSourceShortShaTags;
    delete require.cache[agentOnboardModulePath];
  }
}
