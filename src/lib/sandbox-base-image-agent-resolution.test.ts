// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  build: vi.fn(),
  capture: vi.fn(),
  imageInspect: vi.fn(),
  imageInspectFormat: vi.fn(),
  infoFormat: vi.fn(),
  pull: vi.fn(),
}));
const sourceMocks = vi.hoisted(() => ({
  inputsDirty: vi.fn(),
  inputsChanged: vi.fn(),
}));

vi.mock("./adapters/docker", () => ({
  dockerBuild: dockerMocks.build,
  dockerCapture: dockerMocks.capture,
  dockerImageInspect: dockerMocks.imageInspect,
  dockerImageInspectFormat: dockerMocks.imageInspectFormat,
  dockerInfoFormat: dockerMocks.infoFormat,
  dockerPull: dockerMocks.pull,
}));

vi.mock("./trace", () => ({
  addTraceEvent: vi.fn(),
}));

vi.mock("./sandbox-base-image/source-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-base-image/source-identity")>()),
  baseImageInputsDirty: sourceMocks.inputsDirty,
  baseImageInputsChangedSinceMain: sourceMocks.inputsChanged,
}));

import { resolveSandboxBaseImage } from "./sandbox-base-image";

const IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/sandbox-base";

function resolutionOptions() {
  return {
    imageName: IMAGE_NAME,
    dockerfilePath: path.join(process.cwd(), "Dockerfile.base"),
    localTag: "nemoclaw-sandbox-base-local:test",
    rootDir: process.cwd(),
    env: {
      ...process.env,
      GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
    },
    requireOpenshellSandboxAbi: false,
  };
}

describe("agent-specific sandbox base-image resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.infoFormat.mockReturnValue("linux/amd64\n");
    sourceMocks.inputsDirty.mockReturnValue(false);
    sourceMocks.inputsChanged.mockReturnValue(false);
  });

  it("tracks agent dependency locks in dirty and main-divergence checks (#6456)", () => {
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });
    const options = resolutionOptions();
    const lockfile = path.join(
      process.cwd(),
      "agents",
      "langchain-deepagents-code",
      "requirements.lock",
    );

    expect(
      resolveSandboxBaseImage({
        ...options,
        inputPaths: [lockfile],
        env: {
          ...options.env,
          NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
        },
      }),
    ).toBeNull();
    expect(sourceMocks.inputsDirty).toHaveBeenCalledWith(process.cwd(), expect.any(Object), [
      options.dockerfilePath,
      lockfile,
    ]);
    expect(sourceMocks.inputsChanged).toHaveBeenCalledWith(process.cwd(), expect.any(Object), [
      options.dockerfilePath,
      lockfile,
    ]);
  });

  it("rejects a pulled base when custom runtime validation fails (#6456)", () => {
    const options = resolutionOptions();
    const staleRef = `${IMAGE_NAME}:stale-dcode`;
    const validateImage = vi.fn(() => false);
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      resolveSandboxBaseImage({
        ...options,
        envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
        env: {
          ...options.env,
          NEMOCLAW_SANDBOX_BASE_IMAGE_REF: staleRef,
          NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
        },
        validateImage,
        validationDescription: "deepagents-code==0.1.34",
      }),
    ).toBeNull();
    expect(dockerMocks.pull).toHaveBeenCalledWith(staleRef, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(validateImage).toHaveBeenCalledWith(staleRef);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deepagents-code==0.1.34"));
    expect(dockerMocks.build).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
