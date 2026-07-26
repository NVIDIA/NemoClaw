// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  nearestTags: vi.fn(),
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
  getNearestVersionedBaseImageTags: sourceMocks.nearestTags,
}));

import { resolveSandboxBaseImage } from "./sandbox-base-image";

const IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const DIGEST = `sha256:${"a".repeat(64)}`;
const REF = `${IMAGE_NAME}@${DIGEST}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const LOCAL_TAG = "nemoclaw-sandbox-base-local:test";
const RELEASE_REF = `${IMAGE_NAME}:v0.0.76`;
const NEAREST_RELEASE_REF = `${IMAGE_NAME}:v0.0.78`;

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

type DockerStateOptions = {
  allowBuild?: boolean;
  compatible?: string[];
  glibcVersion?: string;
  present?: string[];
  pullCompatible?: string[];
  pullable?: string[];
};

function installDockerState(options: DockerStateOptions = {}) {
  const present = new Set(options.present ?? []);
  const pullable = new Set(options.pullable ?? []);
  const compatible = new Set(options.compatible ?? []);
  const pullCompatible = new Set(options.pullCompatible ?? []);
  const latestRef = `${IMAGE_NAME}:latest`;

  const assertNotLatest = (ref: string) =>
    expect(ref, "release resolution must not fall back to latest").not.toBe(latestRef);

  dockerMocks.imageInspect.mockImplementation((ref: string) => {
    assertNotLatest(ref);
    return { status: present.has(ref) ? 0 : 1 };
  });
  dockerMocks.pull.mockImplementation((ref: string) => {
    assertNotLatest(ref);
    const status = pullable.has(ref) ? 0 : 1;
    status === 0 && present.add(ref);
    status === 0 && pullCompatible.has(ref) && compatible.add(ref);
    return { status };
  });
  dockerMocks.build.mockImplementation((_dockerfile: string, tag: string) => {
    expect(options.allowBuild, "local build must not run").toBe(true);
    present.add(tag);
    compatible.add(tag);
    return { status: 0 };
  });
  dockerMocks.capture.mockReturnValue(`ldd (GNU libc) ${options.glibcVersion ?? "2.41"}`);

  return {
    validateImage: vi.fn((ref: string) => compatible.has(ref)),
  };
}

describe("sandbox base-image release resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dockerMocks.infoFormat.mockReturnValue("linux/amd64\n");
    sourceMocks.inputsDirty.mockReturnValue(false);
    sourceMocks.inputsChanged.mockReturnValue(false);
    sourceMocks.nearestTags.mockReturnValue([]);
    dockerMocks.imageInspectFormat.mockReturnValue(
      JSON.stringify({
        Id: IMAGE_ID,
        RepoDigests: [REF],
        Os: "linux",
        Architecture: "amd64",
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes a stale local release-tag image before accepting the versioned base (#6456)", () => {
    const state = installDockerState({
      present: [RELEASE_REF],
      pullable: [RELEASE_REF],
      pullCompatible: [RELEASE_REF],
    });

    const resolved = resolveSandboxBaseImage({
      ...versionedResolutionOptions(),
      validateImage: state.validateImage,
    });

    expect(resolved).toMatchObject({
      ref: RELEASE_REF,
      source: "version-tag",
    });
  });

  it("builds locally instead of falling back to latest when a release-tag base is unavailable (#6456)", () => {
    const options = versionedResolutionOptions("1");
    installDockerState({ allowBuild: true });

    const resolved = resolveSandboxBaseImage(options);

    expect(resolved).toMatchObject({
      ref: LOCAL_TAG,
      source: "local",
    });
  });

  it("builds locally when a refreshed release-tag base still fails runtime validation (#6456)", () => {
    const state = installDockerState({
      allowBuild: true,
      present: [RELEASE_REF],
      pullable: [RELEASE_REF],
    });
    const options = {
      ...versionedResolutionOptions("1"),
      validateImage: state.validateImage,
    };

    const resolved = resolveSandboxBaseImage(options);

    expect(resolved).toMatchObject({
      ref: LOCAL_TAG,
      source: "local",
    });
  });

  it("fails closed when a release-tag base is unavailable and local builds are disabled (#6456)", () => {
    installDockerState();

    expect(() => resolveSandboxBaseImage(versionedResolutionOptions("0"))).toThrow(
      "versioned base image",
    );
  });

  it("fails closed when a refreshed release-tag base still fails runtime validation and local builds are disabled (#6456)", () => {
    const state = installDockerState({
      present: [RELEASE_REF],
      pullable: [RELEASE_REF],
    });

    expect(() =>
      resolveSandboxBaseImage({
        ...versionedResolutionOptions("0"),
        validateImage: state.validateImage,
      }),
    ).toThrow("versioned base image");
  });

  it("tries the nearest release-tag base before latest for source checkouts (#6456)", () => {
    sourceMocks.nearestTags.mockReturnValue(["v0.0.78"]);
    const sourceShaRef = `${IMAGE_NAME}:12345678`;
    installDockerState({ present: [NEAREST_RELEASE_REF, sourceShaRef] });

    const resolved = resolveSandboxBaseImage(resolutionOptions());

    expect(resolved).toMatchObject({
      ref: NEAREST_RELEASE_REF,
      source: "version-tag",
    });
    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(NEAREST_RELEASE_REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.imageInspect).not.toHaveBeenCalledWith(sourceShaRef, expect.anything());
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("builds locally instead of falling back to latest when the nearest release-tag base is unavailable (#6456)", () => {
    sourceMocks.nearestTags.mockReturnValue(["v0.0.78"]);
    installDockerState({ allowBuild: true });
    const options = resolutionOptions();

    const resolved = resolveSandboxBaseImage({
      ...options,
      env: {
        ...options.env,
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "1",
      },
    });

    expect(resolved).toMatchObject({
      ref: LOCAL_TAG,
      source: "local",
    });
  });

  it("fails closed instead of falling back when an explicit override fails ABI validation (#4680)", () => {
    installDockerState({
      glibcVersion: "2.36",
      present: [`${IMAGE_NAME}:published`],
    });

    expect(() => resolveSandboxBaseImage(abiRequiredOverrideOptions())).toThrow(
      "override 'ghcr.io/nvidia/nemoclaw/sandbox-base:published' could not be resolved",
    );
  });

  it("fails closed when an explicit override cannot be pulled (#4680)", () => {
    installDockerState();

    expect(() => resolveSandboxBaseImage(abiRequiredOverrideOptions())).toThrow(
      "override 'ghcr.io/nvidia/nemoclaw/sandbox-base:published' could not be resolved",
    );
  });
});
