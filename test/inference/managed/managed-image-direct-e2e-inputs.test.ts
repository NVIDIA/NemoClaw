// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseManagedImageDirectE2eInputs } from "../../../scripts/checks/run-managed-image-direct-e2e";

const IMMUTABLE_IMAGE_ID = `sha256:${"a".repeat(64)}`;

describe("managed-image direct E2E inputs", () => {
  it.each([
    "linux/amd64",
    "linux/arm64",
  ] as const)("accepts the native publication platform %s (#7744)", (platform) => {
    expect(
      parseManagedImageDirectE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMMUTABLE_IMAGE_ID,
        "--platform",
        platform,
      ]),
    ).toEqual({ agent: "openclaw", image: IMMUTABLE_IMAGE_ID, platform });
  });

  it("rejects platforms outside the native publication matrix", () => {
    expect(() =>
      parseManagedImageDirectE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMMUTABLE_IMAGE_ID,
        "--platform",
        "linux/s390x",
      ]),
    ).toThrow("--platform must be linux/amd64 or linux/arm64");
  });
});
