// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  build: vi.fn(),
  imageInspect: vi.fn(),
  imageInspectFormat: vi.fn(),
  infoFormat: vi.fn(),
  manifestInspect: vi.fn(),
  pull: vi.fn(),
}));
const traceMocks = vi.hoisted(() => ({
  add: vi.fn(),
}));
const sourceMocks = vi.hoisted(() => ({
  inputsChanged: vi.fn(),
  inputsDirty: vi.fn(),
  nearestTags: vi.fn(),
  sourceTags: vi.fn(),
  versionTags: vi.fn(),
}));

vi.mock("./adapters/docker", () => ({
  dockerBuild: dockerMocks.build,
  dockerImageInspect: dockerMocks.imageInspect,
  dockerImageInspectFormat: dockerMocks.imageInspectFormat,
  dockerInfoFormat: dockerMocks.infoFormat,
  dockerManifestInspect: dockerMocks.manifestInspect,
  dockerPull: dockerMocks.pull,
}));

vi.mock("./trace", () => ({
  addTraceEvent: traceMocks.add,
}));

vi.mock("./sandbox-base-image/source-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-base-image/source-identity")>()),
  baseImageInputsChangedSinceMain: sourceMocks.inputsChanged,
  baseImageInputsDirty: sourceMocks.inputsDirty,
  getNearestVersionedBaseImageTags: sourceMocks.nearestTags,
  getSourceShortShaTags: sourceMocks.sourceTags,
  getVersionedBaseImageTags: sourceMocks.versionTags,
}));

import {
  createSandboxBaseImageResolutionKey,
  OPENSHELL_SANDBOX_MIN_GLIBC,
  resolveSandboxBaseImage,
  type SandboxBaseImageResolutionMetadata,
} from "./sandbox-base-image";

const IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const DIGEST = `sha256:${"a".repeat(64)}`;
const REF = `${IMAGE_NAME}@${DIGEST}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const PLATFORM_DIGEST = "sha256:c0c149ed03b3e8fcd3e395558b22e871cd27c9966ea6faf04c0d2b94d0a821b9";
const PLATFORM_REF = `${IMAGE_NAME}@${PLATFORM_DIGEST}`;
const ARM_PLATFORM_DIGEST = `sha256:${"d".repeat(64)}`;
const ARM_PLATFORM_REF = `${IMAGE_NAME}@${ARM_PLATFORM_DIGEST}`;

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

function pinnedMetadata(overrides: Partial<SandboxBaseImageResolutionMetadata> = {}) {
  const options = resolutionOptions();
  return {
    schema: 1,
    key: createSandboxBaseImageResolutionKey({ ...options, pinnedRemoteRef: REF }),
    imageName: IMAGE_NAME,
    ref: REF,
    digest: DIGEST,
    source: "pinned",
    pinnedRemoteRef: REF,
    imageId: IMAGE_ID,
    os: "linux",
    architecture: "amd64",
    glibcVersion: null,
    requireOpenshellSandboxAbi: false,
    minGlibcVersion: OPENSHELL_SANDBOX_MIN_GLIBC,
    ...overrides,
  } satisfies SandboxBaseImageResolutionMetadata;
}

describe("sandbox base-image pinned platform digest resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.infoFormat.mockReturnValue("linux/amd64\n");
    sourceMocks.inputsDirty.mockReturnValue(false);
    sourceMocks.inputsChanged.mockReturnValue(false);
    sourceMocks.nearestTags.mockReturnValue([]);
    sourceMocks.sourceTags.mockReturnValue([]);
    sourceMocks.versionTags.mockReturnValue([]);
    dockerMocks.pull.mockReturnValue({ status: 1 });
  });

  it("returns a Dockerfile-pinned platform digest from the resolver path", () => {
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === REF || ref === PLATFORM_REF ? 0 : 1,
    }));
    dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) =>
      (
        new Map([
          [`{{json .RepoDigests}}\0${REF}`, JSON.stringify([PLATFORM_REF])],
          [
            `{{json .}}\0${PLATFORM_REF}`,
            JSON.stringify({
              Id: IMAGE_ID,
              RepoDigests: [PLATFORM_REF],
              Os: "linux",
              Architecture: "amd64",
            }),
          ],
        ]).get(`${format}\0${ref}`) ?? ""
      ).trim(),
    );

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      pinnedRemoteRef: REF,
      preferPinnedRemoteRef: true,
    });

    expect(resolved).toEqual({
      ref: PLATFORM_REF,
      digest: PLATFORM_DIGEST,
      source: "pinned",
      pinnedRemoteRef: REF,
      glibcVersion: null,
      metadata: expect.objectContaining({
        ref: PLATFORM_REF,
        digest: PLATFORM_DIGEST,
        source: "pinned",
        pinnedRemoteRef: REF,
      }),
    });
    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.imageInspectFormat).toHaveBeenCalledWith("{{json .RepoDigests}}", REF, {
      ignoreError: true,
    });
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("uses the one locally proven platform digest when the first inspect reports the index", () => {
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === REF || ref === PLATFORM_REF ? 0 : 1,
    }));
    dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) =>
      (
        new Map([
          [`{{json .RepoDigests}}\0${REF}`, JSON.stringify([REF])],
          [
            `{{json .}}\0${REF}`,
            JSON.stringify({
              Id: IMAGE_ID,
              RepoDigests: [PLATFORM_REF],
              Os: "linux",
              Architecture: "amd64",
            }),
          ],
          [
            `{{json .}}\0${PLATFORM_REF}`,
            JSON.stringify({
              Id: IMAGE_ID,
              RepoDigests: [PLATFORM_REF],
              Os: "linux",
              Architecture: "amd64",
            }),
          ],
        ]).get(`${format}\0${ref}`) ?? ""
      ).trim(),
    );

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      pinnedRemoteRef: REF,
      preferPinnedRemoteRef: true,
    });

    expect(resolved).toMatchObject({
      ref: PLATFORM_REF,
      digest: PLATFORM_DIGEST,
      source: "pinned",
      pinnedRemoteRef: REF,
      metadata: {
        ref: PLATFORM_REF,
        digest: PLATFORM_DIGEST,
        imageId: IMAGE_ID,
      },
    });
  });

  it("resolves and locally proves the daemon platform when Docker retains the index digest (#9386)", () => {
    let platformRepoDigestOutput = "";
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockImplementation((ref: string) => {
      platformRepoDigestOutput =
        new Map([[PLATFORM_REF, JSON.stringify([PLATFORM_REF])]]).get(ref) ??
        platformRepoDigestOutput;
      return { status: 0 };
    });
    dockerMocks.manifestInspect.mockReturnValue(
      JSON.stringify({
        manifests: [
          {
            digest: PLATFORM_DIGEST,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            digest: `sha256:${"d".repeat(64)}`,
            platform: { architecture: "arm64", os: "linux" },
          },
        ],
      }),
    );
    dockerMocks.imageInspectFormat.mockImplementation(
      (format: string, ref: string) =>
        new Map([
          [`{{json .RepoDigests}}\0${REF}`, JSON.stringify([REF])],
          [`{{json .RepoDigests}}\0${PLATFORM_REF}`, platformRepoDigestOutput],
          [
            `{{json .}}\0${PLATFORM_REF}`,
            JSON.stringify({
              Id: IMAGE_ID,
              RepoDigests: [PLATFORM_REF],
              Os: "linux",
              Architecture: "amd64",
            }),
          ],
        ]).get(`${format}\0${ref}`) ?? "",
    );

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
      env: {
        ...resolutionOptions().env,
        NEMOCLAW_SANDBOX_BASE_IMAGE_REF: REF,
      },
    });

    expect(resolved).toMatchObject({
      ref: PLATFORM_REF,
      digest: PLATFORM_DIGEST,
      source: "override",
      metadata: {
        ref: PLATFORM_REF,
        digest: PLATFORM_DIGEST,
        imageId: IMAGE_ID,
        os: "linux",
        architecture: "amd64",
      },
    });
    expect(dockerMocks.infoFormat).toHaveBeenCalledWith("{{.OSType}}/{{.Architecture}}", {
      ignoreError: true,
    });
    expect(dockerMocks.manifestInspect).toHaveBeenCalledWith(REF, { ignoreError: true });
    expect(dockerMocks.pull).toHaveBeenNthCalledWith(1, REF, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(dockerMocks.pull).toHaveBeenNthCalledWith(2, PLATFORM_REF, {
      ignoreError: true,
      suppressOutput: true,
    });
  });

  it("does not select an ambiguous daemon-platform manifest (#9386)", () => {
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === REF ? 0 : 1,
    }));
    dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) =>
      format === "{{json .RepoDigests}}" && ref === REF ? JSON.stringify([REF]) : "",
    );
    dockerMocks.manifestInspect.mockReturnValue(
      JSON.stringify({
        manifests: [
          {
            digest: PLATFORM_DIGEST,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            digest: `sha256:${"d".repeat(64)}`,
            platform: { architecture: "amd64", os: "linux" },
          },
        ],
      }),
    );

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      pinnedRemoteRef: REF,
      preferPinnedRemoteRef: true,
    });

    expect(resolved).toMatchObject({ ref: REF, digest: DIGEST, source: "pinned" });
    expect(resolved).not.toHaveProperty("metadata");
    expect(dockerMocks.pull).not.toHaveBeenCalled();
  });

  it("resolves the daemon-selected ARM variant and locally proves its digest (#9386)", () => {
    let platformRepoDigestOutput = "";
    dockerMocks.infoFormat.mockReturnValue("linux/aarch64\n");
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockImplementation((ref: string) => {
      platformRepoDigestOutput =
        new Map([[ARM_PLATFORM_REF, JSON.stringify([ARM_PLATFORM_REF])]]).get(ref) ??
        platformRepoDigestOutput;
      return { status: 0 };
    });
    dockerMocks.manifestInspect.mockReturnValue(
      JSON.stringify({
        manifests: [
          {
            digest: ARM_PLATFORM_DIGEST,
            platform: { architecture: "arm64", os: "linux", variant: "v8" },
          },
          {
            digest: `sha256:${"e".repeat(64)}`,
            platform: { architecture: "arm64", os: "linux", variant: "v9" },
          },
        ],
      }),
    );
    dockerMocks.imageInspectFormat.mockImplementation(
      (format: string, ref: string) =>
        new Map([
          [`{{json .RepoDigests}}\0${REF}`, JSON.stringify([REF])],
          [`{{json .Variant}}\0${REF}`, JSON.stringify("v8")],
          [`{{json .RepoDigests}}\0${ARM_PLATFORM_REF}`, platformRepoDigestOutput],
          [
            `{{json .}}\0${ARM_PLATFORM_REF}`,
            JSON.stringify({
              Id: IMAGE_ID,
              RepoDigests: [ARM_PLATFORM_REF],
              Os: "linux",
              Architecture: "arm64",
              Variant: "v8",
            }),
          ],
        ]).get(`${format}\0${ref}`) ?? "",
    );

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
      env: {
        ...resolutionOptions().env,
        NEMOCLAW_SANDBOX_BASE_IMAGE_REF: REF,
      },
    });

    expect(resolved).toMatchObject({
      ref: ARM_PLATFORM_REF,
      digest: ARM_PLATFORM_DIGEST,
      source: "override",
      metadata: {
        ref: ARM_PLATFORM_REF,
        digest: ARM_PLATFORM_DIGEST,
        imageId: IMAGE_ID,
        os: "linux",
        architecture: "arm64",
      },
    });
    expect(dockerMocks.imageInspectFormat).toHaveBeenCalledWith("{{json .Variant}}", REF, {
      ignoreError: true,
    });
    expect(dockerMocks.pull).toHaveBeenNthCalledWith(2, ARM_PLATFORM_REF, {
      ignoreError: true,
      suppressOutput: true,
    });
  });

  it.each([
    ["a nonmatching", JSON.stringify("v8")],
    ["an unavailable", ""],
    ["an invalid", JSON.stringify("arm64-v8")],
  ])("does not select an ARM manifest with %s daemon variant (#9386)", (_case, variantOutput) => {
    dockerMocks.infoFormat.mockReturnValue("linux/arm64\n");
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === REF ? 0 : 1,
    }));
    dockerMocks.imageInspectFormat.mockImplementation(
      (format: string, ref: string) =>
        new Map([
          [`{{json .RepoDigests}}\0${REF}`, JSON.stringify([REF])],
          [`{{json .Variant}}\0${REF}`, variantOutput],
        ]).get(`${format}\0${ref}`) ?? "",
    );
    dockerMocks.manifestInspect.mockReturnValue(
      JSON.stringify({
        manifests: [
          {
            digest: ARM_PLATFORM_DIGEST,
            platform: { architecture: "arm64", os: "linux", variant: "v9" },
          },
        ],
      }),
    );

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      pinnedRemoteRef: REF,
      preferPinnedRemoteRef: true,
    });

    expect(resolved).toMatchObject({ ref: REF, digest: DIGEST, source: "pinned" });
    expect(resolved).not.toHaveProperty("metadata");
    expect(dockerMocks.pull).not.toHaveBeenCalled();
  });

  it("falls back to the Dockerfile-pinned digest when RepoDigests JSON is malformed", () => {
    dockerMocks.imageInspect.mockImplementation((ref: string) => ({
      status: ref === REF ? 0 : 1,
    }));
    dockerMocks.imageInspectFormat.mockImplementation((format: string, ref: string) =>
      (
        new Map([[`{{json .RepoDigests}}\0${REF}`, "{not-json"]]).get(`${format}\0${ref}`) ?? ""
      ).trim(),
    );

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      pinnedRemoteRef: REF,
      preferPinnedRemoteRef: true,
    });

    expect(resolved).toMatchObject({
      ref: REF,
      digest: DIGEST,
      source: "pinned",
      pinnedRemoteRef: REF,
    });
    expect(traceMocks.add).toHaveBeenCalledWith(
      "nemoclaw.sandbox_base_image.repodigest_parse_failed",
      { digest_pinned: true },
    );
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("rejects a pinned resolution hint from a stale Dockerfile pin", () => {
    const options = resolutionOptions();
    const stalePin = `${IMAGE_NAME}@sha256:${"c".repeat(64)}`;
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });

    const resolved = resolveSandboxBaseImage({
      ...options,
      pinnedRemoteRef: REF,
      resolutionHint: pinnedMetadata({ pinnedRemoteRef: stalePin }),
      env: {
        ...options.env,
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
      },
    });

    expect(resolved).toBeNull();
    expect(traceMocks.add).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.cache_stale", {
      reason: "pinned_ref_mismatch",
    });
    expect(dockerMocks.imageInspect).toHaveBeenCalledWith(REF, {
      ignoreError: true,
      suppressOutput: true,
    });
  }, 10_000);
});
