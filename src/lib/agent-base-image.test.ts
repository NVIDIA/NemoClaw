// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "./agent-defs";

type AgentOnboardModule = typeof import("../../dist/lib/agent-onboard");
type DockerImageModule = typeof import("../../dist/lib/docker/image");
type DockerInspectModule = typeof import("../../dist/lib/docker/inspect");

/**
 * Build a minimal Hermes agent manifest for base-image provisioning tests.
 */
function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "hermes",
    displayName: "Hermes Agent",
    healthProbe: { url: "http://127.0.0.1:8642/health", port: 8642, timeout_seconds: 90 },
    forwardPort: 8642,
    dashboard: { kind: "api", label: "OpenAI-compatible API", path: "/v1" },
    configPaths: {
      dir: "/sandbox/.hermes",
      configFile: "config.yaml",
      envFile: ".env",
      format: "yaml",
    },
    stateDirs: [],
    stateFiles: [],
    versionCommand: "hermes --version",
    expectedVersion: "2026.4.30",
    hasDevicePairing: false,
    phoneHomeHosts: [],
    messagingPlatforms: [],
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
 * Load `agent-onboard` with Docker helpers replaced by Vitest mocks.
 */
function withMockedDocker<T>(
  run: (deps: {
    ensureAgentBaseImage: AgentOnboardModule["ensureAgentBaseImage"];
    dockerBuildMock: ReturnType<typeof vi.fn>;
    dockerImageInspectMock: ReturnType<typeof vi.fn>;
    root: string;
  }) => T,
): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerImageModule = require("../../dist/lib/docker/image") as DockerImageModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerInspectModule = require("../../dist/lib/docker/inspect") as DockerInspectModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runnerModule = require("../../dist/lib/runner") as { ROOT: string };
  const originalDockerBuild = dockerImageModule.dockerBuild;
  const originalDockerImageInspect = dockerInspectModule.dockerImageInspect;
  const agentOnboardModulePath = require.resolve("../../dist/lib/agent-onboard");
  delete require.cache[agentOnboardModulePath];

  const dockerBuildMock = vi.fn().mockReturnValue({ status: 0 });
  const dockerImageInspectMock = vi.fn();
  dockerImageModule.dockerBuild = dockerBuildMock as DockerImageModule["dockerBuild"];
  dockerInspectModule.dockerImageInspect =
    dockerImageInspectMock as DockerInspectModule["dockerImageInspect"];

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const agentOnboardModule = require("../../dist/lib/agent-onboard") as AgentOnboardModule;
    return run({
      ensureAgentBaseImage: agentOnboardModule.ensureAgentBaseImage,
      dockerBuildMock,
      dockerImageInspectMock,
      root: runnerModule.ROOT,
    });
  } finally {
    dockerImageModule.dockerBuild = originalDockerBuild;
    dockerInspectModule.dockerImageInspect = originalDockerImageInspect;
    delete require.cache[agentOnboardModulePath];
  }
}

describe("agent base image provisioning", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses an existing agent base image during normal onboarding", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, dockerImageInspectMock }) => {
      dockerImageInspectMock.mockReturnValue({ status: 0 });

      const result = ensureAgentBaseImage(makeAgent());

      expect(result).toEqual({
        imageTag: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
        built: false,
      });
      expect(dockerImageInspectMock).toHaveBeenCalledWith(
        "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
        {
          ignoreError: true,
          suppressOutput: true,
        },
      );
      expect(dockerBuildMock).not.toHaveBeenCalled();
    });
  });

  it("rebuilds an agent base image when rebuild flow forces local Dockerfile.base refresh", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, dockerImageInspectMock, root }) => {
      dockerImageInspectMock.mockReturnValue({ status: 0 });

      const result = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

      expect(result).toEqual({
        imageTag: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
        built: true,
      });
      expect(dockerImageInspectMock).not.toHaveBeenCalled();
      expect(dockerBuildMock).toHaveBeenCalledWith(
        "/test/root/agents/hermes/Dockerfile.base",
        "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest",
        root,
        { ignoreError: true, stdio: ["ignore", "inherit", "inherit"] },
      );
    });
  });

  it("throws when a forced agent base image rebuild fails", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock }) => {
      dockerBuildMock.mockReturnValue({ status: 23 });

      expect(() => ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true })).toThrow(
        "Failed to build Hermes Agent base image (exit 23)",
      );
    });
  });

  it("builds an agent base image when no cached image exists", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerBuildMock, dockerImageInspectMock }) => {
      dockerImageInspectMock.mockReturnValue({ status: 1 });

      const result = ensureAgentBaseImage(makeAgent());

      expect(result.built).toBe(true);
      expect(dockerBuildMock).toHaveBeenCalledOnce();
    });
  });
});
