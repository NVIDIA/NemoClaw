// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import { prepareSandboxDockerfilePatch } from "./sandbox-dockerfile-patch-flow";

const sandboxGpuConfig: SandboxGpuConfig = {
  mode: "auto",
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};

describe("prepareSandboxDockerfilePatch", () => {
  it("pins a resolved base image and patches the staged Dockerfile with the build id", async () => {
    const log = vi.fn();
    const patchStagedDockerfile = vi.fn();
    const enforceDockerGpuPatchPreserveNetwork = vi.fn(async () => false);
    const result = await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: "nvidia-prod",
      preferredInferenceApi: "chat",
      webSearchConfig: { fetchEnabled: true },
      hermesToolGateways: ["github"],
      sandboxGpuConfig,
      log,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
        pullAndResolveBaseImageDigest: vi.fn(() => ({
          digest: "sha256:abcdef0123456789",
          ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abcdef0123456789",
        })),
        enforceDockerGpuPatchPreserveNetwork,
        patchStagedDockerfile,
        now: () => 12345,
      },
    });

    expect(result).toEqual({
      buildId: "12345",
      resolvedBaseImage: {
        digest: "sha256:abcdef0123456789",
        ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abcdef0123456789",
      },
    });
    expect(log).toHaveBeenCalledWith("  Pinning base image to sha256:abcdef012345...");
    expect(enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledWith(
      "nvidia-prod",
      sandboxGpuConfig,
      {
        dockerDriverGateway: true,
        log,
      },
    );
    expect(patchStagedDockerfile).toHaveBeenCalledWith(
      "/tmp/Dockerfile",
      "model-a",
      "http://127.0.0.1:7000",
      "12345",
      "nvidia-prod",
      "chat",
      { fetchEnabled: true },
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abcdef0123456789",
      false,
      null,
      ["github"],
    );
  });

  it("skips base-image resolution for agent default Dockerfiles", async () => {
    const pullAndResolveBaseImageDigest = vi.fn();
    const dockerImageInspect = vi.fn();
    const result = await prepareSandboxDockerfilePatch({
      agent: { name: "hermes" } as any,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        pullAndResolveBaseImageDigest,
        dockerImageInspect,
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile: vi.fn(),
        now: () => 1,
      },
    });

    expect(result.resolvedBaseImage).toBeNull();
    expect(pullAndResolveBaseImageDigest).not.toHaveBeenCalled();
    expect(dockerImageInspect).not.toHaveBeenCalled();
  });

  it("resolves the base image when an agent uses a custom Dockerfile", async () => {
    const pullAndResolveBaseImageDigest = vi.fn(() => ({
      digest: "sha256:customagent",
      ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:customagent",
    }));
    const patchStagedDockerfile = vi.fn();

    const result = await prepareSandboxDockerfilePatch({
      agent: { name: "hermes" } as any,
      fromDockerfile: "/repo/Containerfile",
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      log: vi.fn(),
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        pullAndResolveBaseImageDigest,
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(result.resolvedBaseImage).toEqual({
      digest: "sha256:customagent",
      ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:customagent",
    });
    expect(pullAndResolveBaseImageDigest).toHaveBeenCalledWith({
      requireOpenshellSandboxAbi: false,
    });
    expect(patchStagedDockerfile.mock.calls[0]?.[7]).toBe(
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:customagent",
    );
  });

  it("warns when the base image cannot be resolved but cached latest exists", async () => {
    const warn = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      warn,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        pullAndResolveBaseImageDigest: vi.fn(() => null),
        dockerImageInspect: vi.fn(() => ({ status: 0 })),
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile: vi.fn(),
        now: () => 1,
      },
    });

    expect(warn).toHaveBeenCalledWith(
      "  Warning: could not pull base image from registry; using cached :latest.",
    );
  });

  it("warns with a recovery command when the base image is unavailable", async () => {
    const warn = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      warn,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        pullAndResolveBaseImageDigest: vi.fn(() => null),
        dockerImageInspect: vi.fn(() => ({ status: 1 })),
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile: vi.fn(),
        now: () => 1,
      },
    });

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "  Warning: base image ghcr.io/nvidia/nemoclaw/sandbox-base:latest is not available locally.",
      "  The build will fail unless Docker can pull the image during build.",
      "  If offline, pull the image manually first:",
      "    docker pull ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
    ]);
  });
});
