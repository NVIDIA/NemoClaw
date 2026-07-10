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
const traceMocks = vi.hoisted(() => ({
  add: vi.fn(),
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
  addTraceEvent: traceMocks.add,
}));

vi.mock("./sandbox-base-image/source-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-base-image/source-identity")>()),
  baseImageInputsDirty: sourceMocks.inputsDirty,
  baseImageInputsChangedSinceMain: sourceMocks.inputsChanged,
}));

import { resolveSandboxBaseImage } from "./sandbox-base-image";

const IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const DIGEST = `sha256:${"a".repeat(64)}`;
const REF = `${IMAGE_NAME}@${DIGEST}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const LOCAL_TAG = "nemoclaw-sandbox-base-local:test";
const RELEASE_REF = `${IMAGE_NAME}:v0.0.76`;

function resolutionOptions() {
  return {
    imageName: IMAGE_NAME,
    dockerfilePath: path.join(process.cwd(), "Dockerfile.base"),
    localTag: LOCAL_TAG,
    rootDir: process.cwd(),
    env: {
      ...process.env,
      GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
    },
    requireOpenshellSandboxAbi: false,
  };
}

function versionedResolutionOptions(localBuild: "0" | "1" | undefined = undefined) {
  const options = resolutionOptions();
  return {
    ...options,
    env: {
      ...options.env,
      NEMOCLAW_INSTALL_REF: "v0.0.76",
      ...(localBuild === undefined ? {} : { NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: localBuild }),
    },
    validationDescription: "deepagents-code==0.1.34",
  };
}

function abiRequiredOverrideOptions() {
  const options = resolutionOptions();
  return {
    ...options,
    envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
    env: {
      ...options.env,
      NEMOCLAW_SANDBOX_BASE_IMAGE_REF: `${IMAGE_NAME}:published`,
      NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
    },
    requireOpenshellSandboxAbi: true,
  };
}

function mockPublishedGlibc(version: string): void {
  dockerMocks.imageInspect.mockReturnValue({ status: 0 });
  dockerMocks.capture.mockReturnValue(`ldd (GNU libc) ${version}`);
}

describe("sandbox base-image release resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.infoFormat.mockReturnValue("linux/amd64\n");
    sourceMocks.inputsDirty.mockReturnValue(false);
    sourceMocks.inputsChanged.mockReturnValue(false);
    dockerMocks.imageInspectFormat.mockReturnValue(
      JSON.stringify({
        Id: IMAGE_ID,
        RepoDigests: [REF],
        Os: "linux",
        Architecture: "amd64",
      }),
    );
  });

  it("refreshes a stale local release-tag image before accepting the versioned base (#6456)", () => {
    const validateImage = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });
    dockerMocks.pull.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage({
      ...versionedResolutionOptions(),
      validateImage,
    });

    expect(resolved).toMatchObject({
      ref: RELEASE_REF,
      source: "version-tag",
    });
    expect(validateImage).toHaveBeenCalledTimes(2);
    expect(validateImage).toHaveBeenNthCalledWith(1, RELEASE_REF);
    expect(validateImage).toHaveBeenNthCalledWith(2, RELEASE_REF);
    expect(dockerMocks.pull).toHaveBeenCalledWith(RELEASE_REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(traceMocks.add).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.remote_refresh", {
      source: "version-tag",
    });
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("builds locally instead of falling back to latest when a release-tag base is unavailable (#6456)", () => {
    const options = versionedResolutionOptions("1");
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === RELEASE_REF || ref === LOCAL_TAG ? 1 : 0,
    }));
    dockerMocks.pull.mockReturnValue({ status: 1 });
    dockerMocks.build.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage(options);

    expect(resolved).toMatchObject({
      ref: LOCAL_TAG,
      source: "local",
    });
    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(RELEASE_REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.imageInspect).not.toHaveBeenCalledWith(LOCAL_TAG, expect.anything());
    expect(dockerMocks.imageInspect).not.toHaveBeenCalledWith(
      `${IMAGE_NAME}:latest`,
      expect.anything(),
    );
    expect(dockerMocks.build).toHaveBeenCalledWith(
      options.dockerfilePath,
      LOCAL_TAG,
      options.rootDir,
      {
        ignoreError: true,
        quiet: true,
        suppressOutput: true,
      },
    );
  });

  it("builds locally when a refreshed release-tag base still fails runtime validation (#6456)", () => {
    const validateImage = vi.fn((ref: string) => ref === LOCAL_TAG);
    const options = {
      ...versionedResolutionOptions("1"),
      validateImage,
    };
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === RELEASE_REF ? 0 : 1,
    }));
    dockerMocks.pull.mockReturnValue({ status: 0 });
    dockerMocks.build.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage(options);

    expect(resolved).toMatchObject({
      ref: LOCAL_TAG,
      source: "local",
    });
    expect(validateImage).toHaveBeenCalledTimes(3);
    expect(validateImage).toHaveBeenNthCalledWith(1, RELEASE_REF);
    expect(validateImage).toHaveBeenNthCalledWith(2, RELEASE_REF);
    expect(validateImage).toHaveBeenNthCalledWith(3, LOCAL_TAG);
    expect(dockerMocks.pull).toHaveBeenCalledWith(RELEASE_REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.imageInspect).not.toHaveBeenCalledWith(
      `${IMAGE_NAME}:latest`,
      expect.anything(),
    );
    expect(dockerMocks.build).toHaveBeenCalledWith(
      options.dockerfilePath,
      LOCAL_TAG,
      options.rootDir,
      {
        ignoreError: true,
        quiet: true,
        suppressOutput: true,
      },
    );
  });

  it("fails closed when a release-tag base is unavailable and local builds are disabled (#6456)", () => {
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });

    expect(() => resolveSandboxBaseImage(versionedResolutionOptions("0"))).toThrow(
      "versioned base image",
    );

    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(RELEASE_REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.imageInspect).not.toHaveBeenCalledWith(
      `${IMAGE_NAME}:latest`,
      expect.anything(),
    );
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("fails closed when a refreshed release-tag base still fails runtime validation and local builds are disabled (#6456)", () => {
    const validateImage = vi.fn(() => false);
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === RELEASE_REF ? 0 : 1,
    }));
    dockerMocks.pull.mockReturnValue({ status: 0 });

    expect(() =>
      resolveSandboxBaseImage({
        ...versionedResolutionOptions("0"),
        validateImage,
      }),
    ).toThrow("versioned base image");

    expect(validateImage).toHaveBeenCalledTimes(2);
    expect(validateImage).toHaveBeenNthCalledWith(1, RELEASE_REF);
    expect(validateImage).toHaveBeenNthCalledWith(2, RELEASE_REF);
    expect(dockerMocks.pull).toHaveBeenCalledWith(RELEASE_REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.imageInspect).not.toHaveBeenCalledWith(
      `${IMAGE_NAME}:latest`,
      expect.anything(),
    );
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("fails closed instead of falling back when an explicit override fails ABI validation (#4680)", () => {
    mockPublishedGlibc("2.36");

    expect(() => resolveSandboxBaseImage(abiRequiredOverrideOptions())).toThrow(
      "override 'ghcr.io/nvidia/nemoclaw/sandbox-base:published' could not be resolved",
    );

    expect(dockerMocks.capture).toHaveBeenCalledTimes(1);
    expect(dockerMocks.build).not.toHaveBeenCalled();
    expect(traceMocks.add).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.local_validation", {
      source: "override",
      present: true,
    });
    expect(traceMocks.add).not.toHaveBeenCalledWith(
      "nemoclaw.sandbox_base_image.local_fallback_reuse",
    );
  });

  it("fails closed when an explicit override cannot be pulled (#4680)", () => {
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });

    expect(() => resolveSandboxBaseImage(abiRequiredOverrideOptions())).toThrow(
      "override 'ghcr.io/nvidia/nemoclaw/sandbox-base:published' could not be resolved",
    );

    expect(dockerMocks.capture).not.toHaveBeenCalled();
    expect(dockerMocks.pull).toHaveBeenCalledWith(`${IMAGE_NAME}:published`, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });
});
