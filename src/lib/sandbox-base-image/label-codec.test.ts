// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerImageInspectFormat: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerImageInspectFormat: mocks.dockerImageInspectFormat,
}));

import {
  formatSandboxBaseImageResolutionLabels,
  MAX_ENCODED_RESOLUTION_LABEL_LENGTH,
  parseSandboxBaseImageResolutionLabels,
  readSandboxBaseImageResolutionMetadata,
} from "./label-codec";
import {
  SANDBOX_BASE_IMAGE_RESOLUTION_SOURCES,
  SANDBOX_BASE_RESOLUTION_LABEL,
  type SandboxBaseImageResolutionMetadata,
} from "./types";

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

function encoded(value: unknown): Record<string, string> {
  return {
    [SANDBOX_BASE_RESOLUTION_LABEL]: Buffer.from(JSON.stringify(value), "utf8").toString(
      "base64url",
    ),
  };
}

describe("sandbox base-image resolution label codec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats round-trippable completed-image labels (#4680)", () => {
    const labels = formatSandboxBaseImageResolutionLabels(metadata);
    const payload = labels.match(/base-resolution="([^"]+)"/)?.[1];
    expect(labels).toContain(`base-resolution-key="${metadata.key}"`);
    expect(
      parseSandboxBaseImageResolutionLabels({
        [SANDBOX_BASE_RESOLUTION_LABEL]: payload,
      }),
    ).toEqual(metadata);
  });

  it("rejects missing, malformed, and invalid-alphabet labels (#4680)", () => {
    expect(parseSandboxBaseImageResolutionLabels(null)).toBeNull();
    expect(parseSandboxBaseImageResolutionLabels({})).toBeNull();
    expect(
      parseSandboxBaseImageResolutionLabels({
        [SANDBOX_BASE_RESOLUTION_LABEL]: "not+base64url/payload=",
      }),
    ).toBeNull();
  });

  it("rejects unknown schema versions (#4680)", () => {
    expect(parseSandboxBaseImageResolutionLabels(encoded({ ...metadata, schema: 2 }))).toBeNull();
  });

  it("rejects oversized payloads before decoding (#4680)", () => {
    expect(
      parseSandboxBaseImageResolutionLabels({
        [SANDBOX_BASE_RESOLUTION_LABEL]: "a".repeat(MAX_ENCODED_RESOLUTION_LABEL_LENGTH + 1),
      }),
    ).toBeNull();
  });

  it.each(
    SANDBOX_BASE_IMAGE_RESOLUTION_SOURCES,
  )("accepts the shared %s resolution source (#4680)", (source) => {
    expect(parseSandboxBaseImageResolutionLabels(encoded({ ...metadata, source }))).toEqual({
      ...metadata,
      source,
    });
  });

  it("reads valid resolution metadata through the Docker inspect adapter (#4680)", () => {
    mocks.dockerImageInspectFormat.mockReturnValue(JSON.stringify(encoded(metadata)));

    expect(readSandboxBaseImageResolutionMetadata("nemoclaw:cached")).toEqual(metadata);
    expect(mocks.dockerImageInspectFormat).toHaveBeenCalledWith(
      "{{json .Config.Labels}}",
      "nemoclaw:cached",
      { ignoreError: true },
    );
  });

  it.each([
    ["malformed", JSON.stringify({ [SANDBOX_BASE_RESOLUTION_LABEL]: "not+base64url/payload=" })],
    [
      "oversized",
      JSON.stringify({
        [SANDBOX_BASE_RESOLUTION_LABEL]: "a".repeat(MAX_ENCODED_RESOLUTION_LABEL_LENGTH + 1),
      }),
    ],
    ["non-JSON", "docker inspect diagnostic output"],
  ])("ignores %s Docker inspect label output (#4680)", (_kind, inspectOutput) => {
    mocks.dockerImageInspectFormat.mockReturnValue(inspectOutput);

    expect(readSandboxBaseImageResolutionMetadata("nemoclaw:untrusted")).toBeNull();
  });
});
