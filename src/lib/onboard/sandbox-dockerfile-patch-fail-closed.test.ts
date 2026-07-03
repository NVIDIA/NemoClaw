// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { SandboxBaseImageResolutionError } from "../sandbox-base-image";
import {
  type PrepareSandboxDockerfilePatchInput,
  prepareSandboxDockerfilePatch,
} from "./sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

const sandboxGpuConfig: SandboxGpuConfig = {
  mode: "auto",
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};

const baseInput: Omit<PrepareSandboxDockerfilePatchInput, "deps"> = {
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
};

describe("prepareSandboxDockerfilePatch fail-closed base-image resolution", () => {
  it("propagates changed-input resolution errors without cached-latest fallback (#4680)", async () => {
    const resolutionError = new SandboxBaseImageResolutionError("changed inputs not rebuilt");
    const dockerImageInspect = vi.fn();
    const patchStagedDockerfile = vi.fn();

    await expect(
      prepareSandboxDockerfilePatch({
        ...baseInput,
        deps: {
          isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
          pullAndResolveBaseImageDigest: vi.fn(() => {
            throw resolutionError;
          }),
          dockerImageInspect,
          enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
          patchStagedDockerfile,
        },
      }),
    ).rejects.toBe(resolutionError);

    expect(dockerImageInspect).not.toHaveBeenCalled();
    expect(patchStagedDockerfile).not.toHaveBeenCalled();
  });

  it("rejects an unproven cached latest image when the OpenShell ABI is required (#4680)", async () => {
    const dockerImageInspect = vi.fn(() => ({ status: 0 }));
    const patchStagedDockerfile = vi.fn();

    await expect(
      prepareSandboxDockerfilePatch({
        ...baseInput,
        deps: {
          isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
          pullAndResolveBaseImageDigest: vi.fn(() => null),
          dockerImageInspect,
          enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
          patchStagedDockerfile,
        },
      }),
    ).rejects.toThrow(
      "No OpenShell ABI-compatible sandbox base image could be resolved. " +
        "Refusing to fall back to an unvalidated cached :latest image.",
    );

    expect(dockerImageInspect).not.toHaveBeenCalled();
    expect(patchStagedDockerfile).not.toHaveBeenCalled();
  });
});
