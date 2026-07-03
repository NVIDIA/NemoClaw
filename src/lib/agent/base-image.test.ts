// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxBaseImageResolutionMetadata } from "../sandbox-base-image";
import type { AgentDefinition } from "./defs";

type AgentBaseImageModule = typeof import("./base-image");
type DockerImageModule = typeof import("../adapters/docker/image");
type DockerInspectModule = typeof import("../adapters/docker/inspect");
type SandboxBaseImageModule = typeof import("../sandbox-base-image");
type ResolutionMetadataModule = typeof import("../sandbox-base-image/resolution-metadata");
type ResolutionKeyModule = typeof import("../sandbox-base-image/resolution-key");
type ImageCompatibilityModule = typeof import("../sandbox-base-image/image-compatibility");

/**
 * Build a minimal Hermes agent manifest for base-image provisioning tests.
 */
function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
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
    stateDirs: [],
    stateFiles: [],
    userManagedFiles: [],
    versionCommand: "hermes --version",
    expectedVersion: "2026.4.30",
    hasDevicePairing: false,
    phoneHomeHosts: [],
    dockerfileBasePath: "/test/root/agents/hermes/Dockerfile.base",
    dockerfilePath: "/test/root/agents/hermes/Dockerfile",
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

/**
 * Load the agent base-image helper with Docker dependencies replaced by Vitest mocks.
 */
function withMockedDocker<T>(
  run: (deps: {
    ensureAgentBaseImage: AgentBaseImageModule["ensureAgentBaseImage"];
    dockerBuildMock: ReturnType<typeof vi.fn>;
    dockerImageInspectMock: ReturnType<typeof vi.fn>;
    resolveSandboxBaseImageMock: ReturnType<typeof vi.fn>;
    createResolutionMetadataMock: ReturnType<typeof vi.fn>;
    root: string;
  }) => T,
): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerImageModule = require("../adapters/docker/image") as DockerImageModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerInspectModule = require("../adapters/docker/inspect") as DockerInspectModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sandboxBaseImageModule = require("../sandbox-base-image") as SandboxBaseImageModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const resolutionMetadataModule =
    require("../sandbox-base-image/resolution-metadata") as ResolutionMetadataModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const resolutionKeyModule =
    require("../sandbox-base-image/resolution-key") as ResolutionKeyModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const imageCompatibilityModule =
    require("../sandbox-base-image/image-compatibility") as ImageCompatibilityModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runnerModule = require("../runner") as { ROOT: string };
  const originalDockerBuild = dockerImageModule.dockerBuild;
  const originalDockerImageInspect = dockerInspectModule.dockerImageInspect;
  const originalResolveSandboxBaseImage = sandboxBaseImageModule.resolveSandboxBaseImage;
  const originalCreateResolutionMetadata =
    resolutionMetadataModule.createSandboxBaseImageResolutionMetadata;
  const originalCreateResolutionKey = resolutionKeyModule.createSandboxBaseImageResolutionKey;
  const originalGetImageGlibcVersion = imageCompatibilityModule.getImageGlibcVersion;
  const agentBaseImageModulePath = require.resolve("./base-image");
  delete require.cache[agentBaseImageModulePath];

  const dockerBuildMock = vi.fn().mockReturnValue({ status: 0 });
  const dockerImageInspectMock = vi.fn();
  const resolveSandboxBaseImageMock = vi.fn().mockReturnValue({
    ref: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:compatible",
    digest: null,
    source: "source-sha",
    glibcVersion: process.platform === "linux" ? "2.41" : null,
  });
  const createResolutionMetadataMock = vi.fn().mockReturnValue({
    schema: 1,
    key: "resolution-key",
    imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
    ref: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
    digest: null,
    source: "local",
    imageId: "sha256:local",
    os: "linux",
    architecture: "amd64",
    glibcVersion: "2.41",
    requireOpenshellSandboxAbi: process.platform === "linux",
    minGlibcVersion: "2.39",
  });
  dockerImageModule.dockerBuild = dockerBuildMock as DockerImageModule["dockerBuild"];
  dockerInspectModule.dockerImageInspect =
    dockerImageInspectMock as DockerInspectModule["dockerImageInspect"];
  sandboxBaseImageModule.resolveSandboxBaseImage =
    resolveSandboxBaseImageMock as SandboxBaseImageModule["resolveSandboxBaseImage"];
  resolutionMetadataModule.createSandboxBaseImageResolutionMetadata =
    createResolutionMetadataMock as ResolutionMetadataModule["createSandboxBaseImageResolutionMetadata"];
  resolutionKeyModule.createSandboxBaseImageResolutionKey = vi.fn(
    () => "resolution-key",
  ) as ResolutionKeyModule["createSandboxBaseImageResolutionKey"];
  imageCompatibilityModule.getImageGlibcVersion = vi.fn(
    () => "2.41",
  ) as ImageCompatibilityModule["getImageGlibcVersion"];

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const agentBaseImageModule = require("./base-image") as AgentBaseImageModule;
    return run({
      ensureAgentBaseImage: agentBaseImageModule.ensureAgentBaseImage,
      dockerBuildMock,
      dockerImageInspectMock,
      resolveSandboxBaseImageMock,
      createResolutionMetadataMock,
      root: runnerModule.ROOT,
    });
  } finally {
    dockerImageModule.dockerBuild = originalDockerBuild;
    dockerInspectModule.dockerImageInspect = originalDockerImageInspect;
    sandboxBaseImageModule.resolveSandboxBaseImage = originalResolveSandboxBaseImage;
    resolutionMetadataModule.createSandboxBaseImageResolutionMetadata =
      originalCreateResolutionMetadata;
    resolutionKeyModule.createSandboxBaseImageResolutionKey = originalCreateResolutionKey;
    imageCompatibilityModule.getImageGlibcVersion = originalGetImageGlibcVersion;
    delete require.cache[agentBaseImageModulePath];
  }
}

describe("agent base image provisioning", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses a compatible resolved agent base image during normal onboarding", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectMock,
        resolveSandboxBaseImageMock,
        root,
      }) => {
        const resolutionHint = {
          key: "cached-resolution-key",
        } as SandboxBaseImageResolutionMetadata;
        const result = ensureAgentBaseImage(makeAgent(), {
          resolutionHint,
          forceBaseImageRefresh: true,
        });

        expect(result).toEqual({
          imageTag: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:compatible",
          built: false,
        });
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
            dockerfilePath: "/test/root/agents/hermes/Dockerfile.base",
            envVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
            label: "Hermes Agent sandbox base image",
            requireOpenshellSandboxAbi: process.platform === "linux",
            resolutionHint,
            forceRefresh: true,
            rootDir: root,
          }),
        );
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).not.toHaveBeenCalled();
      },
    );
  });

  it("rebuilds an agent base image when rebuild flow forces local Dockerfile.base refresh", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectMock,
        resolveSandboxBaseImageMock,
        createResolutionMetadataMock,
        root,
      }) => {
        dockerImageInspectMock.mockReturnValue({ status: 0 });

        const result = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

        expect(result).toEqual({
          imageTag: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
          built: true,
          resolutionMetadata: expect.objectContaining({
            key: "resolution-key",
            source: "local",
          }),
        });
        expect(createResolutionMetadataMock).toHaveBeenCalledOnce();
        expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).toHaveBeenCalledWith(
          "/test/root/agents/hermes/Dockerfile.base",
          "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
          root,
          { ignoreError: true, stdio: ["ignore", "inherit", "inherit"] },
        );
      },
    );
  });

  it("throws when a forced agent base image rebuild fails", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, resolveSandboxBaseImageMock }) => {
      dockerBuildMock.mockReturnValue({ status: 23 });

      expect(() => ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true })).toThrow(
        "Failed to build Hermes Agent base image (exit 23)",
      );
      expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
    });
  });

  it("builds an agent base image when no resolved image or cached image exists on non-Linux hosts", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectMock,
        resolveSandboxBaseImageMock,
      }) => {
        resolveSandboxBaseImageMock.mockReturnValue(null);
        dockerImageInspectMock.mockReturnValue({ status: 1 });

        if (process.platform === "linux") {
          expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
            "No compatible Hermes Agent sandbox base image found",
          );
          expect(dockerBuildMock).not.toHaveBeenCalled();
          return;
        }

        const result = ensureAgentBaseImage(makeAgent());

        expect(result.built).toBe(true);
        expect(dockerBuildMock).toHaveBeenCalledOnce();
      },
    );
  });
});
