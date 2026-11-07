// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SandboxBaseImageResolutionMetadata } from "../sandbox-base-image";
import {
  captureBaseResolution,
  createBaseImageResolutionContext,
  getBaseImageResolutionPatchOptions,
} from "./base-image-resolution-flow";
import { prepareSandboxDockerfilePatch } from "./sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

const sandboxGpuConfig: SandboxGpuConfig = {
  mode: "auto",
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};

const resolutionMetadata: SandboxBaseImageResolutionMetadata = {
  schema: 1,
  key: "key",
  imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc",
  digest: "sha256:abc",
  source: "version-tag",
  imageId: "sha256:image",
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

describe("prepareSandboxDockerfilePatch", () => {
  it.each([
    [
      "a literal managed-image FROM",
      "FROM ghcr.io/nvidia/nemoclaw/sandbox-openclaw@sha256:abc\n",
      false,
    ],
    ["an unrelated BASE_IMAGE", "ARG BASE_IMAGE=ubuntu:24.04\nFROM ${BASE_IMAGE}\n", false],
    [
      "the NemoClaw sandbox-base ARG",
      "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest\nFROM ${BASE_IMAGE}\n",
      true,
    ],
  ])("resolves only a consumed default base for %s", async (_label, content, consumesBase) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-base-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const stagedDockerfile = path.join(root, "Dockerfile");
    fs.writeFileSync(stagedDockerfile, content);
    const pullAndResolveBaseImageDigest = vi.fn(() => ({
      digest: "sha256:customagent",
      ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:customagent",
    }));
    const patchStagedDockerfile = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: stagedDockerfile,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile,
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      log: vi.fn(),
      deps: {
        isLinuxDockerDriverGatewayEnabled: () => true,
        pullAndResolveBaseImageDigest,
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
      },
    });
    expect(pullAndResolveBaseImageDigest).toHaveBeenCalledTimes(consumesBase ? 1 : 0);
    expect(patchStagedDockerfile.mock.calls[0]?.[7]).toBe(
      consumesBase ? "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:customagent" : null,
    );
  });

  it("keeps rebuild hints isolated per flow and lets fresh bypass reuse (#4680)", () => {
    const warmContext = createBaseImageResolutionContext({
      fresh: false,
      initialHint: resolutionMetadata,
      env: {},
    });
    const freshContext = createBaseImageResolutionContext({
      fresh: true,
      initialHint: { ...resolutionMetadata, key: "other-sandbox" },
      env: {},
    });

    captureBaseResolution(warmContext, "unused-image");
    expect(getBaseImageResolutionPatchOptions(warmContext)).toMatchObject({
      resolutionHint: resolutionMetadata,
      forceBaseImageRefresh: false,
    });
    expect(getBaseImageResolutionPatchOptions(freshContext)).toMatchObject({
      resolutionHint: { ...resolutionMetadata, key: "other-sandbox" },
      forceBaseImageRefresh: true,
    });
  });

  it("propagates OpenClaw warm-cache metadata into the completed image labels (#4680)", async () => {
    const pullAndResolveBaseImageDigest = vi.fn(() => ({
      digest: resolutionMetadata.digest,
      ref: resolutionMetadata.ref,
      source: resolutionMetadata.source,
      glibcVersion: resolutionMetadata.glibcVersion,
      metadata: resolutionMetadata,
    }));
    const patchStagedDockerfile = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: null,
      sandboxBaseImage: resolutionMetadata.imageName,
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      resolutionHint: resolutionMetadata,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
        isWsl: vi.fn(() => false),
        pullAndResolveBaseImageDigest,
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(pullAndResolveBaseImageDigest).toHaveBeenCalledWith({
      requireOpenshellSandboxAbi: true,
      resolutionHint: resolutionMetadata,
    });
    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      agentName: "openclaw",
      buildIdPolicy: "preserve",
      toolDisclosure: "progressive",
      trustedManagedDockerfile: true,
      wslDashboardExposure: false,
      requireToolDisclosureContract: false,
      baseImageResolutionMetadata: resolutionMetadata,
    });
  });

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
      compatibleEndpointReasoning: "true",
      preferredInferenceApi: "chat",
      webSearchConfig: { fetchEnabled: true },
      hermesToolGateways: ["github"],
      sandboxGpuConfig,
      log,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
        isWsl: vi.fn(() => false),
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
      dashboardRemoteBindPrepared: false,
      resolvedBaseImage: {
        digest: "sha256:abcdef0123456789",
        ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abcdef0123456789",
      },
    });
    expect(log).toHaveBeenCalledWith("  Pinning base image to sha256:abcdef012345...");
    expect(enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledWith(
      "nvidia-prod",
      sandboxGpuConfig,
      expect.objectContaining({
        dockerDriverGateway: true,
        gatewayPort: undefined,
        log,
        reverifyBridgeReachability: expect.any(Function),
        selectedRoute: "none",
      }),
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
      {
        agentName: "openclaw",
        buildIdPolicy: "preserve",
        compatibleEndpointReasoning: "true",
        toolDisclosure: "progressive",
        trustedManagedDockerfile: true,
        wslDashboardExposure: false,
        requireToolDisclosureContract: false,
      },
    );
  });

  it("records WSL all-interface dashboard exposure for managed OpenClaw builds (#6024)", async () => {
    const patchStagedDockerfile = vi.fn();

    await prepareSandboxDockerfilePatch({
      agent: { name: "openclaw" } as any,
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
        isWsl: vi.fn(() => true),
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toMatchObject({
      trustedManagedDockerfile: true,
      wslDashboardExposure: true,
    });
  });

  it("skips base-image resolution for agent default Dockerfiles", async () => {
    const pullAndResolveBaseImageDigest = vi.fn();
    const dockerImageInspect = vi.fn();
    const patchStagedDockerfile = vi.fn();
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
        isWsl: vi.fn(() => false),
        pullAndResolveBaseImageDigest,
        dockerImageInspect,
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(result.resolvedBaseImage).toBeNull();
    expect(pullAndResolveBaseImageDigest).not.toHaveBeenCalled();
    expect(dockerImageInspect).not.toHaveBeenCalled();
    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      agentName: "hermes",
      buildIdPolicy: "preserve",
      toolDisclosure: "progressive",
      trustedManagedDockerfile: true,
      requireToolDisclosureContract: false,
    });
  });

  it("stamps pre-resolved provenance on managed agent Dockerfiles (#7144)", async () => {
    const patchStagedDockerfile = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: { name: "hermes" } as any,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      preResolvedBaseImageMetadata: resolutionMetadata,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
        isWsl: vi.fn(() => false),
        pullAndResolveBaseImageDigest: vi.fn(),
        dockerImageInspect: vi.fn(),
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      agentName: "hermes",
      buildIdPolicy: "preserve",
      toolDisclosure: "progressive",
      trustedManagedDockerfile: true,
      requireToolDisclosureContract: false,
      baseImageResolutionMetadata: resolutionMetadata,
    });
  });

  it("forwards the DCode auto-approval mode only as a Dockerfile patch option (#6478)", async () => {
    const patchStagedDockerfile = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: { name: "langchain-deepagents-code" } as any,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      dcodeAutoApprovalMode: "thread-opt-in",
      hermesToolGateways: [],
      sandboxGpuConfig,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        isWsl: vi.fn(() => false),
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toMatchObject({
      dcodeAutoApprovalMode: "thread-opt-in",
    });
  });

  it("resolves the base image when an agent uses a custom Dockerfile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-consumed-base-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const stagedDockerfile = path.join(root, "Dockerfile");
    const content =
      "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest\nFROM ${BASE_IMAGE}\n";
    fs.writeFileSync(stagedDockerfile, content);
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
      preResolvedBaseImageMetadata: resolutionMetadata,
      stagedDockerfile,
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
    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      sourceSnapshot: expect.objectContaining({ content }),
      agentName: "hermes",
      buildIdPolicy: "rewrite",
      toolDisclosure: "progressive",
      requireToolDisclosureContract: true,
    });
  });

  it("keeps the per-run rewrite for managed agents that consume the build id", async () => {
    const patchStagedDockerfile = vi.fn();

    await prepareSandboxDockerfilePatch({
      agent: { name: "langchain-deepagents-code" } as any,
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
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      agentName: "langchain-deepagents-code",
      buildIdPolicy: "rewrite",
      toolDisclosure: "progressive",
      trustedManagedDockerfile: true,
      requireToolDisclosureContract: false,
    });
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
