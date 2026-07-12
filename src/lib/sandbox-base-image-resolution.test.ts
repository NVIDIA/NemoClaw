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

import {
  createSandboxBaseImageResolutionKey,
  OPENSHELL_SANDBOX_MIN_GLIBC,
  resolveSandboxBaseImage,
  SandboxBaseImageResolutionError,
  type SandboxBaseImageResolutionMetadata,
} from "./sandbox-base-image";

const IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const DIGEST = `sha256:${"a".repeat(64)}`;
const REF = `${IMAGE_NAME}@${DIGEST}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

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

describe("sandbox base-image warm resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("reuses locally proven RepoDigests metadata without inspecting candidates or pulling (#4680)", () => {
    dockerMocks.pull.mockImplementation(() => {
      throw new Error("network unavailable");
    });
    const options = resolutionOptions();
    const metadata: SandboxBaseImageResolutionMetadata = {
      schema: 1,
      key: createSandboxBaseImageResolutionKey(options),
      imageName: IMAGE_NAME,
      ref: REF,
      digest: DIGEST,
      source: "version-tag",
      imageId: IMAGE_ID,
      os: "linux",
      architecture: "amd64",
      glibcVersion: null,
      requireOpenshellSandboxAbi: false,
      minGlibcVersion: OPENSHELL_SANDBOX_MIN_GLIBC,
    };

    const resolved = resolveSandboxBaseImage({ ...options, resolutionHint: metadata });

    expect(resolved).toEqual({
      ref: REF,
      digest: DIGEST,
      source: "version-tag",
      glibcVersion: null,
      metadata,
    });
    expect(dockerMocks.imageInspectFormat).toHaveBeenCalledTimes(1);
    expect(dockerMocks.imageInspect).not.toHaveBeenCalled();
    expect(dockerMocks.pull).not.toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
    expect(dockerMocks.capture).not.toHaveBeenCalled();
    expect(traceMocks.add).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.cache_hit", {
      source: "version-tag",
      digest_pinned: true,
    });
    expect(traceMocks.add).not.toHaveBeenCalledWith(
      "nemoclaw.sandbox_base_image.cache_miss",
      expect.anything(),
    );
  });

  it("lets force refresh bypass a valid rebuild hint (#4680)", () => {
    const options = resolutionOptions();
    const metadata: SandboxBaseImageResolutionMetadata = {
      schema: 1,
      key: createSandboxBaseImageResolutionKey(options),
      imageName: IMAGE_NAME,
      ref: REF,
      digest: DIGEST,
      source: "version-tag",
      imageId: IMAGE_ID,
      os: "linux",
      architecture: "amd64",
      glibcVersion: null,
      requireOpenshellSandboxAbi: false,
      minGlibcVersion: OPENSHELL_SANDBOX_MIN_GLIBC,
    };
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });

    expect(
      resolveSandboxBaseImage({ ...options, resolutionHint: metadata, forceRefresh: true }),
    ).toBeNull();
    expect(dockerMocks.imageInspect).toHaveBeenCalled();
    expect(dockerMocks.pull).toHaveBeenCalled();
    expect(traceMocks.add).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.cache_miss", {
      has_hint: true,
    });
  });

  it("resolves an explicit override instead of reusing a stale default hint (#4680)", () => {
    const options = {
      ...resolutionOptions(),
      envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
      env: {
        ...resolutionOptions().env,
        NEMOCLAW_SANDBOX_BASE_IMAGE_REF: REF,
      },
    };
    const staleHint: SandboxBaseImageResolutionMetadata = {
      schema: 1,
      key: "stale-default-key",
      imageName: IMAGE_NAME,
      ref: REF,
      digest: DIGEST,
      source: "latest",
      imageId: IMAGE_ID,
      os: "linux",
      architecture: "amd64",
      glibcVersion: null,
      requireOpenshellSandboxAbi: false,
      minGlibcVersion: OPENSHELL_SANDBOX_MIN_GLIBC,
    };
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage({ ...options, resolutionHint: staleHint });

    expect(resolved).toMatchObject({ ref: REF, digest: DIGEST, source: "override" });
    expect(dockerMocks.pull).not.toHaveBeenCalled();
  });

  it("fails closed when offline and no cached image can be validated (#4680)", () => {
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      env: {
        ...resolutionOptions().env,
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
      },
    });

    expect(resolved).toBeNull();
    expect(dockerMocks.pull).toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
    expect(traceMocks.add).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.local_validation", {
      source: "source-sha",
      present: false,
    });
    expect(traceMocks.add).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.remote_pull", {
      source: "source-sha",
    });
  });

  it("fails closed instead of trusting an existing local tag when base inputs are dirty (#4680)", () => {
    sourceMocks.inputsDirty.mockReturnValue(true);
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });

    expect(() =>
      resolveSandboxBaseImage({
        ...resolutionOptions(),
        env: {
          ...resolutionOptions().env,
          NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
        },
      }),
    ).toThrow(SandboxBaseImageResolutionError);

    expect(dockerMocks.imageInspect).not.toHaveBeenCalled();
    expect(dockerMocks.pull).not.toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("fails closed when base inputs changed and the local rebuild fails (#4680)", () => {
    sourceMocks.inputsChanged.mockReturnValue(true);
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });
    dockerMocks.build.mockReturnValue({ status: 1, stderr: "local rebuild failed" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      resolveSandboxBaseImage({
        ...resolutionOptions(),
        env: {
          ...resolutionOptions().env,
          NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "1",
        },
      }),
    ).toThrow(SandboxBaseImageResolutionError);

    expect(dockerMocks.build).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("local rebuild failed");
    error.mockRestore();
  });

  it("redacts a local rebuild spawn error before logging it", () => {
    const token = ["spawn", "secret", "token"].join("-");
    sourceMocks.inputsChanged.mockReturnValue(true);
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });
    dockerMocks.build.mockReturnValue({
      status: null,
      error: new Error(`spawn docker EACCES: Bearer ${token}`),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      resolveSandboxBaseImage({
        ...resolutionOptions(),
        env: {
          ...resolutionOptions().env,
          NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "1",
        },
      }),
    ).toThrow(SandboxBaseImageResolutionError);

    const logged = error.mock.calls.flat().join("\n");
    expect(logged).toContain("spawn docker EACCES");
    expect(logged).toContain("process launch failed");
    expect(logged).not.toContain(token);
    error.mockRestore();
  });

  it("rebuilds dirty base inputs before considering published or existing local candidates (#4680)", () => {
    sourceMocks.inputsDirty.mockReturnValue(true);
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });
    dockerMocks.build.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      env: {
        ...resolutionOptions().env,
        NEMOCLAW_INSTALL_REF: "v0.0.31",
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "1",
      },
    });

    expect(resolved).toMatchObject({
      ref: "nemoclaw-sandbox-base-local:test",
      source: "local",
    });
    expect(dockerMocks.imageInspect).not.toHaveBeenCalled();
    expect(dockerMocks.pull).not.toHaveBeenCalled();
    expect(dockerMocks.build).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the image rebuilt from changed inputs misses the required ABI (#4680)", () => {
    sourceMocks.inputsDirty.mockReturnValue(true);
    dockerMocks.build.mockReturnValue({ status: 0 });
    dockerMocks.capture.mockReturnValue("ldd (GNU libc) 2.38");

    expect(() =>
      resolveSandboxBaseImage({
        ...resolutionOptions(),
        env: {
          ...resolutionOptions().env,
          NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "1",
        },
        requireOpenshellSandboxAbi: true,
      }),
    ).toThrow(SandboxBaseImageResolutionError);

    expect(dockerMocks.build).toHaveBeenCalledTimes(1);
    expect(dockerMocks.capture).toHaveBeenCalledTimes(1);
  });

  it("uses an exact cached version image before committed branch divergence (#4680)", () => {
    sourceMocks.inputsChanged.mockReturnValue(true);
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });
    dockerMocks.pull.mockImplementation(() => {
      throw new Error("air-gapped");
    });
    const options = resolutionOptions();

    const resolved = resolveSandboxBaseImage({
      ...options,
      env: { ...options.env, NEMOCLAW_INSTALL_REF: "v0.0.31" },
    });

    expect(resolved).toMatchObject({ source: "version-tag" });
    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(`${IMAGE_NAME}:v0.0.31`, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.pull).not.toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("uses a Dockerfile-pinned remote image before moving published tags (#4680)", () => {
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === REF ? 0 : 1,
    }));
    dockerMocks.pull.mockReturnValue({ status: 1 });

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      pinnedRemoteRef: REF,
    });

    expect(resolved).toMatchObject({
      ref: REF,
      source: "pinned",
      pinnedRemoteRef: REF,
      metadata: expect.objectContaining({
        pinnedRemoteRef: REF,
      }),
    });
    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("prefers an explicitly trusted pin over an available source-SHA image", () => {
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      pinnedRemoteRef: REF,
      preferPinnedRemoteRef: true,
    });

    expect(resolved).toMatchObject({ ref: REF, source: "pinned" });
    expect(dockerMocks.imageInspect).toHaveBeenCalledTimes(1);
    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("rebuilds changed inputs before using a Dockerfile-pinned baseline (#4680)", () => {
    sourceMocks.inputsChanged.mockReturnValue(true);
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });
    dockerMocks.build.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      env: {
        ...resolutionOptions().env,
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "1",
      },
      pinnedRemoteRef: REF,
    });

    expect(resolved).toMatchObject({
      ref: "nemoclaw-sandbox-base-local:test",
      source: "local",
    });
    expect(dockerMocks.imageInspect).not.toHaveBeenCalledWith(REF, expect.anything());
    expect(dockerMocks.build).toHaveBeenCalledTimes(1);
  });

  it("uses an exact source-SHA image only when no release tag is discoverable (#4680)", () => {
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage(resolutionOptions());

    expect(resolved).toMatchObject({ source: "source-sha" });
    expect(dockerMocks.pull).not.toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });
});
