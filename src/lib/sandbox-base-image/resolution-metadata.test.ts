// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addTraceEvent: vi.fn(),
  dockerImageInspectFormat: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerImageInspectFormat: mocks.dockerImageInspectFormat,
}));

vi.mock("../trace", () => ({
  addTraceEvent: mocks.addTraceEvent,
}));

import {
  createSandboxBaseImageResolutionMetadata,
  finalizeSandboxBaseImageResolution,
  inspectLocalImageMetadata,
  reuseSandboxBaseImageResolutionHint,
} from "./resolution-metadata";
import type {
  DcodeSandboxBaseImageResolutionMetadata,
  ResolveBaseImageOptions,
  SandboxBaseImageResolution,
  SandboxBaseImageResolutionMetadata,
} from "./types";

const IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const DIGEST = `sha256:${"a".repeat(64)}`;
const REF = `${IMAGE_NAME}@${DIGEST}`;
const KEY = "resolution-key";
const SOURCE_REVISION_LABEL = "org.opencontainers.image.revision";
const SOURCE_REVISION = "c".repeat(40);

const inspected = {
  Id: `sha256:${"b".repeat(64)}`,
  RepoDigests: [REF],
  Os: "linux",
  Architecture: "amd64",
};

const options: ResolveBaseImageOptions = {
  imageName: IMAGE_NAME,
  dockerfilePath: "/repo/Dockerfile.base",
  localTag: "nemoclaw-sandbox-base-local:test",
  label: "sandbox base image",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

const publishedResolution: SandboxBaseImageResolution = {
  ref: REF,
  digest: DIGEST,
  source: "version-tag",
  glibcVersion: "2.41",
};

const metadata: SandboxBaseImageResolutionMetadata = {
  schema: 1,
  key: KEY,
  imageName: IMAGE_NAME,
  ref: REF,
  digest: DIGEST,
  source: "version-tag",
  imageId: inspected.Id,
  os: inspected.Os,
  architecture: inspected.Architecture,
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

describe("sandbox base-image resolution metadata lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads local image identity through the Docker inspect adapter (#4680)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(JSON.stringify(inspected));

    expect(inspectLocalImageMetadata(REF)).toEqual(inspected);
    expect(mocks.dockerImageInspectFormat).toHaveBeenCalledWith("{{json .}}", REF, {
      ignoreError: true,
    });
  });

  it.each(["", "not JSON", "null", '"primitive"'])(
    "ignores unusable Docker inspect output %# (#4680)",
    (output) => {
      mocks.dockerImageInspectFormat.mockReturnValue(output);

      expect(inspectLocalImageMetadata(REF)).toBeNull();
    },
  );

  it("creates metadata for a digest-pinned image with matching local identity (#4680)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(JSON.stringify(inspected));

    expect(createSandboxBaseImageResolutionMetadata(options, KEY, publishedResolution)).toEqual(
      metadata,
    );
  });

  it("preserves an exact digest resolution when Docker omits RepoDigests (#9386)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(
      JSON.stringify({
        Id: inspected.Id,
        Os: inspected.Os,
        Architecture: inspected.Architecture,
      }),
    );

    expect(createSandboxBaseImageResolutionMetadata(options, KEY, publishedResolution)).toEqual(
      metadata,
    );
  });

  it("copies a required source revision from the inspected immutable image (#9386)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(
      JSON.stringify({
        ...inspected,
        Config: { Labels: { [SOURCE_REVISION_LABEL]: SOURCE_REVISION } },
      }),
    );

    expect(
      createSandboxBaseImageResolutionMetadata(
        { ...options, sourceRevisionLabel: SOURCE_REVISION_LABEL },
        KEY,
        publishedResolution,
      ),
    ).toEqual({ ...metadata, sourceRevision: SOURCE_REVISION });
  });

  it.each([undefined, "main", "D".repeat(40)])(
    "rejects a missing or malformed required source revision %# (#9386)",
    (sourceRevision) => {
      mocks.dockerImageInspectFormat.mockReturnValue(
        JSON.stringify({
          ...inspected,
          Config: {
            Labels: sourceRevision === undefined ? {} : { [SOURCE_REVISION_LABEL]: sourceRevision },
          },
        }),
      );

      expect(
        createSandboxBaseImageResolutionMetadata(
          { ...options, sourceRevisionLabel: SOURCE_REVISION_LABEL },
          KEY,
          publishedResolution,
        ),
      ).toBeNull();
    },
  );

  it("rejects sparse RepoDigests when the resolved reference is not the exact digest", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(
      JSON.stringify({ ...inspected, RepoDigests: [] }),
    );

    expect(
      createSandboxBaseImageResolutionMetadata(options, KEY, {
        ...publishedResolution,
        ref: `${IMAGE_NAME}:published`,
      }),
    ).toBeNull();
  });

  it("finalizes a local fallback with identity metadata and no repository digest (#4680)", () => {
    const localResolution: SandboxBaseImageResolution = {
      ref: options.localTag,
      digest: null,
      source: "local",
      glibcVersion: "2.41",
    };
    mocks.dockerImageInspectFormat.mockReturnValue(
      JSON.stringify({ ...inspected, RepoDigests: [] }),
    );

    expect(finalizeSandboxBaseImageResolution(options, KEY, localResolution)).toEqual({
      ...localResolution,
      metadata: {
        ...metadata,
        ref: options.localTag,
        digest: null,
        source: "local",
      },
    });
  });

  it("reuses a matching locally proven hint and records a cache hit (#4680)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(JSON.stringify(inspected));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      reuseSandboxBaseImageResolutionHint({ ...options, resolutionHint: metadata }, KEY),
    ).toEqual({
      ...publishedResolution,
      metadata,
    });
    expect(mocks.addTraceEvent).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.cache_hit", {
      source: "version-tag",
      digest_pinned: true,
    });
  });

  it("rejects a stale hint and records the validation reason (#4680)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(JSON.stringify(inspected));

    expect(
      reuseSandboxBaseImageResolutionHint(
        { ...options, resolutionHint: { ...metadata, key: "stale-key" } },
        KEY,
      ),
    ).toBeNull();
    expect(mocks.addTraceEvent).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.cache_stale", {
      reason: "key_mismatch",
    });
    expect(mocks.addTraceEvent).not.toHaveBeenCalledWith(
      "nemoclaw.sandbox_base_image.cache_hit",
      expect.anything(),
    );
  });

  it("rejects a hint whose source revision differs from the inspected image (#9386)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(
      JSON.stringify({
        ...inspected,
        Config: { Labels: { [SOURCE_REVISION_LABEL]: "d".repeat(40) } },
      }),
    );

    const dcodeMetadata: DcodeSandboxBaseImageResolutionMetadata = {
      ...metadata,
      sourceRevision: SOURCE_REVISION,
    };

    expect(
      reuseSandboxBaseImageResolutionHint(
        {
          ...options,
          sourceRevisionLabel: SOURCE_REVISION_LABEL,
          resolutionHint: dcodeMetadata,
        },
        KEY,
      ),
    ).toBeNull();
    expect(mocks.addTraceEvent).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.cache_stale", {
      reason: "source_revision_mismatch",
    });
  });

  it("revalidates custom runtime requirements before reusing a hint (#4680)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(JSON.stringify(inspected));
    const validateImage = vi.fn(() => false);

    expect(
      reuseSandboxBaseImageResolutionHint(
        {
          ...options,
          resolutionHint: metadata,
          validateImage,
          validationDescription: "the native MCP Streamable HTTP runtime",
        },
        KEY,
      ),
    ).toBeNull();
    expect(validateImage).toHaveBeenCalledWith(REF);
    expect(mocks.addTraceEvent).toHaveBeenCalledWith("nemoclaw.sandbox_base_image.cache_stale", {
      reason: "custom_validation_failed",
    });
    expect(mocks.addTraceEvent).not.toHaveBeenCalledWith(
      "nemoclaw.sandbox_base_image.cache_hit",
      expect.anything(),
    );
  });
});
