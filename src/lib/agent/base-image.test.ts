// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "./defs";

type AgentOnboardModule = typeof import("./onboard");
type DockerRunModule = typeof import("../adapters/docker/run");
type DockerImageModule = typeof import("../adapters/docker/image");
type DockerInspectModule = typeof import("../adapters/docker/inspect");
type SandboxBaseImageModule = typeof import("../sandbox-base-image");

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
    mcpCapability: {
      support: "disabled",
      reason: "test fixture",
    },
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
 * Load `agent-onboard` with Docker helpers replaced by Vitest mocks.
 */
function withMockedDocker<T>(
  run: (deps: {
    ensureAgentBaseImage: AgentOnboardModule["ensureAgentBaseImage"];
    pinAgentSandboxBaseImageRef: AgentOnboardModule["pinAgentSandboxBaseImageRef"];
    dockerBuildMock: ReturnType<typeof vi.fn>;
    dockerCaptureMock: ReturnType<typeof vi.fn>;
    dockerImageInspectMock: ReturnType<typeof vi.fn>;
    dockerImageInspectFormatMock: ReturnType<typeof vi.fn>;
    dockerRmiMock: ReturnType<typeof vi.fn>;
    dockerTagMock: ReturnType<typeof vi.fn>;
    resolveSandboxBaseImageMock: ReturnType<typeof vi.fn>;
    root: string;
  }) => T,
): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerRunModule = require("../adapters/docker/run") as DockerRunModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerImageModule = require("../adapters/docker/image") as DockerImageModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dockerInspectModule = require("../adapters/docker/inspect") as DockerInspectModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sandboxBaseImageModule = require("../sandbox-base-image") as SandboxBaseImageModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runnerModule = require("../runner") as { ROOT: string };
  const originalDockerCapture = dockerRunModule.dockerCapture;
  const originalDockerBuild = dockerImageModule.dockerBuild;
  const originalDockerRmi = dockerImageModule.dockerRmi;
  const originalDockerTag = dockerImageModule.dockerTag;
  const originalDockerImageInspect = dockerInspectModule.dockerImageInspect;
  const originalDockerImageInspectFormat = dockerInspectModule.dockerImageInspectFormat;
  const originalResolveSandboxBaseImage = sandboxBaseImageModule.resolveSandboxBaseImage;
  const agentOnboardModulePath = require.resolve("./onboard");
  delete require.cache[agentOnboardModulePath];

  const dockerCaptureMock = vi.fn().mockReturnValue("nemoclaw-hermes-mcp-runtime-ok");
  const dockerBuildMock = vi.fn().mockReturnValue({ status: 0 });
  const dockerRmiMock = vi.fn().mockReturnValue({ status: 0 });
  const dockerTagMock = vi.fn().mockReturnValue({ status: 0 });
  const dockerImageInspectMock = vi.fn();
  const dockerImageInspectFormatMock = vi.fn().mockReturnValue(`sha256:${"a".repeat(64)}`);
  const resolveSandboxBaseImageMock = vi.fn().mockImplementation((options) => {
    const override = options.env?.[options.envVar];
    return {
      ref: override ?? "nemoclaw-hermes-sandbox-base-local:compatible",
      digest: null,
      source: override ? "override" : "local",
      glibcVersion: process.platform === "linux" ? "2.41" : null,
    };
  });
  dockerRunModule.dockerCapture = dockerCaptureMock as DockerRunModule["dockerCapture"];
  dockerImageModule.dockerBuild = dockerBuildMock as DockerImageModule["dockerBuild"];
  dockerImageModule.dockerRmi = dockerRmiMock as DockerImageModule["dockerRmi"];
  dockerImageModule.dockerTag = dockerTagMock as DockerImageModule["dockerTag"];
  dockerInspectModule.dockerImageInspect =
    dockerImageInspectMock as DockerInspectModule["dockerImageInspect"];
  dockerInspectModule.dockerImageInspectFormat =
    dockerImageInspectFormatMock as DockerInspectModule["dockerImageInspectFormat"];
  sandboxBaseImageModule.resolveSandboxBaseImage =
    resolveSandboxBaseImageMock as SandboxBaseImageModule["resolveSandboxBaseImage"];

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const agentOnboardModule = require("./onboard") as AgentOnboardModule;
    return run({
      ensureAgentBaseImage: agentOnboardModule.ensureAgentBaseImage,
      pinAgentSandboxBaseImageRef: agentOnboardModule.pinAgentSandboxBaseImageRef,
      dockerBuildMock,
      dockerCaptureMock,
      dockerImageInspectMock,
      dockerImageInspectFormatMock,
      dockerRmiMock,
      dockerTagMock,
      resolveSandboxBaseImageMock,
      root: runnerModule.ROOT,
    });
  } finally {
    dockerRunModule.dockerCapture = originalDockerCapture;
    dockerImageModule.dockerBuild = originalDockerBuild;
    dockerImageModule.dockerRmi = originalDockerRmi;
    dockerImageModule.dockerTag = originalDockerTag;
    dockerInspectModule.dockerImageInspect = originalDockerImageInspect;
    dockerInspectModule.dockerImageInspectFormat = originalDockerImageInspectFormat;
    sandboxBaseImageModule.resolveSandboxBaseImage = originalResolveSandboxBaseImage;
    delete require.cache[agentOnboardModulePath];
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
        const result = ensureAgentBaseImage(makeAgent());

        expect(result).toEqual({
          imageTag: "nemoclaw-hermes-sandbox-base-local:compatible",
          built: false,
        });
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
            dockerfilePath: "/test/root/agents/hermes/Dockerfile.base",
            envVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
            label: "Hermes Agent sandbox base image",
            requireOpenshellSandboxAbi: process.platform === "linux",
            rootDir: root,
            validateImage: expect.any(Function),
            validationDescription: "the required MCP Streamable HTTP runtime",
          }),
        );
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).not.toHaveBeenCalled();
      },
    );
  });

  it("probes resolved Hermes bases for the native MCP Streamable HTTP runtime", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
      ensureAgentBaseImage(makeAgent());
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: (imageRef: string) => boolean;
      };

      expect(options.validateImage?.("hermes-base:test")).toBe(true);
      expect(dockerCaptureMock).toHaveBeenCalledWith(
        [
          "run",
          "--rm",
          "--entrypoint",
          "/opt/hermes/.venv/bin/python",
          "hermes-base:test",
          "-c",
          expect.stringContaining("_MCP_HTTP_AVAILABLE"),
        ],
        { ignoreError: true, timeout: 20_000 },
      );

      dockerCaptureMock.mockReturnValue("");
      expect(options.validateImage?.("hermes-base:stale")).toBe(false);
    });
  });

  it("accepts only the tracked published Hermes base digest", () => {
    const trackedDigest = `sha256:${"1".repeat(64)}`;
    const trackedRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${trackedDigest}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-final-dockerfile-"));
    const dockerfilePath = path.join(tmp, "Dockerfile");
    fs.writeFileSync(dockerfilePath, `ARG NEMOCLAW_STALE_OPENCLAW_BASE_DIGEST=${trackedDigest}\n`);

    try {
      withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: trackedRef,
          digest: trackedDigest,
          source: "source-sha",
          glibcVersion: "2.41",
        });

        expect(ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toEqual({
          imageTag: trackedRef,
          built: false,
        });

        const differentRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"0".repeat(64)}`;
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: differentRef,
          digest: `sha256:${"0".repeat(64)}`,
          source: "source-sha",
          glibcVersion: "2.41",
        });
        expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
          "Hermes final image does not accept base image ref",
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rebuilds an agent base image when rebuild flow forces local Dockerfile.base refresh", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectFormatMock,
        dockerImageInspectMock,
        dockerRmiMock,
        dockerTagMock,
        resolveSandboxBaseImageMock,
        root,
      }) => {
        dockerImageInspectMock.mockReturnValue({ status: 0 });

        const result = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

        expect(result.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`);
        expect(result.built).toBe(true);
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            localTag: result.imageTag,
            env: expect.objectContaining({
              NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: result.imageTag,
              NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
            }),
          }),
        );
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
        expect(dockerBuildMock).toHaveBeenCalledWith(
          "/test/root/agents/hermes/Dockerfile.base",
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          root,
          { ignoreError: true, stdio: ["ignore", "inherit", "inherit"] },
        );
        expect(dockerImageInspectFormatMock).toHaveBeenCalledWith(
          "{{.Id}}",
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          { ignoreError: true },
        );
        expect(dockerTagMock).toHaveBeenCalledWith(
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          result.imageTag,
          { ignoreError: true },
        );
        expect(dockerRmiMock).toHaveBeenCalledWith(
          expect.stringMatching(/^nemoclaw-hermes-sandbox-base-local:build-\d+-[0-9a-f]{16}$/),
          { ignoreError: true, suppressOutput: true },
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

  it("fails a forced rebuild before deletion when the built base fails validation", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      resolveSandboxBaseImageMock.mockReturnValue(null);

      expect(() => ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true })).toThrow(
        "failed the required runtime compatibility checks",
      );
    });
  });

  it("pins different image IDs to different recreate refs at the same source revision", () => {
    withMockedDocker(
      ({ ensureAgentBaseImage, dockerImageInspectFormatMock, resolveSandboxBaseImageMock }) => {
        dockerImageInspectFormatMock
          .mockReturnValueOnce(`sha256:${"a".repeat(64)}`)
          .mockReturnValueOnce(`sha256:${"b".repeat(64)}`);
        resolveSandboxBaseImageMock.mockImplementation((options) => ({
          ref: options.env?.[options.envVar],
          digest: null,
          source: "override",
          glibcVersion: "2.41",
        }));

        const first = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });
        const second = ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true });

        expect(first.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`);
        expect(second.imageTag).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"b".repeat(64)}`);
      },
    );
  });

  it("canonicalizes a mutable local override to its full image-ID ref", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        dockerImageInspectFormatMock.mockReturnValue(`sha256:${"c".repeat(64)}`);

        const pinned = pinAgentSandboxBaseImageRef(
          "hermes",
          "nemoclaw-hermes-sandbox-base-local:caller",
        );

        expect(pinned).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"c".repeat(64)}`);
        expect(dockerTagMock).toHaveBeenCalledWith(
          "nemoclaw-hermes-sandbox-base-local:caller",
          pinned,
          { ignoreError: true },
        );
      },
    );
  });

  it("does not trust a moved image-ID-shaped tag without inspecting it", () => {
    withMockedDocker(
      ({ pinAgentSandboxBaseImageRef, dockerImageInspectFormatMock, dockerTagMock }) => {
        const claimed = `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`;
        dockerImageInspectFormatMock.mockReturnValue(`sha256:${"d".repeat(64)}`);

        const pinned = pinAgentSandboxBaseImageRef("hermes", claimed);

        expect(pinned).toBe(`nemoclaw-hermes-sandbox-base-local:image-${"d".repeat(64)}`);
        expect(dockerTagMock).toHaveBeenCalledWith(claimed, pinned, { ignoreError: true });
      },
    );
  });

  it("validates an explicit override strictly instead of falling back", () => {
    const envVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
    const prior = process.env[envVar];
    process.env[envVar] = "localhost:5000/custom/hermes:latest";
    try {
      withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: process.env[envVar],
          digest: null,
          source: "override",
          glibcVersion: "2.41",
        });

        expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
          "Hermes final image does not accept base image ref",
        );
        expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            localTag: "localhost:5000/custom/hermes:latest",
            env: expect.objectContaining({
              [envVar]: "localhost:5000/custom/hermes:latest",
              NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
            }),
          }),
        );
      });
    } finally {
      if (prior === undefined) delete process.env[envVar];
      else process.env[envVar] = prior;
    }
  });

  it("fails closed when no MCP-capable Hermes base image can be resolved", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectMock,
        resolveSandboxBaseImageMock,
      }) => {
        resolveSandboxBaseImageMock.mockReturnValue(null);
        dockerImageInspectMock.mockReturnValue({ status: 1 });

        expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
          "No compatible Hermes Agent sandbox base image found",
        );
        expect(dockerBuildMock).not.toHaveBeenCalled();
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
      },
    );
  });
});
