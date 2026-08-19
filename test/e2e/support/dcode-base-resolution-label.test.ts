// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseSandboxBaseImageResolutionLabels } from "../../../src/lib/sandbox-base-image/label-codec.ts";
import { SANDBOX_BASE_RESOLUTION_LABEL } from "../../../src/lib/sandbox-base-image/types.ts";
import {
  createDcodeBaseResolutionMetadata,
  encodeDcodeBaseResolutionMetadata,
} from "../../../scripts/checks/export-dcode-base-resolution-label.mts";

const IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
const DIGEST = `sha256:${"a".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);

function authority(overrides: Record<string, unknown> = {}) {
  return {
    imageName: IMAGE,
    reference: `${IMAGE}@${DIGEST}`,
    digest: DIGEST,
    sourceRevision: SOURCE_REVISION,
    imageId: `sha256:${"c".repeat(64)}`,
    os: "linux",
    architecture: "amd64",
    platform: "linux/amd64",
    glibcVersion: "2.41",
    ...overrides,
  };
}

describe("Deep Agents Code managed-image base resolution label", () => {
  it("serializes immutable base authority into a parseable final-image label (#9386)", () => {
    const metadata = createDcodeBaseResolutionMetadata(authority());
    const encoded = encodeDcodeBaseResolutionMetadata(metadata);

    expect(
      parseSandboxBaseImageResolutionLabels({ [SANDBOX_BASE_RESOLUTION_LABEL]: encoded }),
    ).toEqual(metadata);
    expect(metadata).toMatchObject({
      imageName: IMAGE,
      ref: `${IMAGE}@${DIGEST}`,
      digest: DIGEST,
      sourceRevision: SOURCE_REVISION,
      os: "linux",
      architecture: "amd64",
      source: "override",
    });
  });

  it.each([
    ["a mutable reference", { reference: `${IMAGE}:latest` }],
    ["a mismatched platform", { architecture: "arm64" }],
    ["a malformed revision", { sourceRevision: "main" }],
  ])("fails closed for %s (#9386)", (_label, overrides) => {
    expect(() => createDcodeBaseResolutionMetadata(authority(overrides))).toThrow(
      /Deep Agents Code base-resolution label/u,
    );
  });
});
