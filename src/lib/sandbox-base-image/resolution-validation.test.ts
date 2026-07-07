// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateSandboxBaseImageResolutionMetadata } from "./resolution-metadata";
import type { SandboxBaseImageResolutionMetadata } from "./types";

const metadata: SandboxBaseImageResolutionMetadata = {
  schema: 1,
  key: "resolution-key",
  imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc",
  digest: "sha256:abc",
  source: "version-tag",
  imageId: "sha256:image-id",
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

const inspected = {
  Id: metadata.imageId,
  Os: metadata.os,
  Architecture: metadata.architecture,
  RepoDigests: [`${metadata.imageName}@${metadata.digest}`],
};

function validate(
  resolutionMetadata = metadata,
  imageMetadata: typeof inspected | Omit<typeof inspected, "RepoDigests"> | null = inspected,
) {
  return validateSandboxBaseImageResolutionMetadata({
    metadata: resolutionMetadata,
    expectedKey: "resolution-key",
    imageName: metadata.imageName,
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
    inspected: imageMetadata,
  });
}

describe("sandbox base-image resolution validation", () => {
  it("validates a published resolution from matching local RepoDigests (#4680)", () => {
    expect(validate()).toEqual({ ok: true });
  });

  it("rejects missing or changed RepoDigests proof (#4680)", () => {
    expect(validate(metadata, { ...inspected, RepoDigests: [] })).toEqual({
      ok: false,
      reason: "repo_digest_missing",
    });
    const { RepoDigests: _, ...withoutRepoDigests } = inspected;
    expect(validate(metadata, withoutRepoDigests)).toEqual({
      ok: false,
      reason: "repo_digest_missing",
    });
  });

  it("validates local fallback images by identity without RepoDigests (#4680)", () => {
    expect(
      validate(
        {
          ...metadata,
          ref: "nemoclaw-sandbox-base-local:abc1234",
          digest: null,
          source: "local",
        },
        { ...inspected, RepoDigests: [] },
      ),
    ).toEqual({ ok: true });
  });

  it("rejects digestless non-local hints even when image identity matches (#4680)", () => {
    expect(
      validate({ ...metadata, digest: null, source: "latest" }, { ...inspected, RepoDigests: [] }),
    ).toEqual({ ok: false, reason: "repo_digest_missing" });
  });

  it("rejects stale keys, platform drift, and incompatible ABI evidence (#4680)", () => {
    expect(validate({ ...metadata, key: "different-key" })).toEqual({
      ok: false,
      reason: "key_mismatch",
    });
    expect(validate(metadata, { ...inspected, Architecture: "arm64" })).toEqual({
      ok: false,
      reason: "local_image_changed",
    });
    expect(validate({ ...metadata, glibcVersion: "2.36" })).toEqual({
      ok: false,
      reason: "abi_incompatible",
    });
  });
});
