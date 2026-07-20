// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { checkHermesLightSkinBoundary } from "../scripts/checks/hermes-light-skin-boundary.mts";

function dockerfileWithVersion(version: string): string {
  return ["FROM debian:bookworm-slim", `ARG HERMES_VERSION=${version}`, ""].join("\n");
}

describe("hermes light-skin boundary check", () => {
  it("passes when the pinned version is reviewed", () => {
    expect(
      checkHermesLightSkinBoundary({
        dockerfileText: dockerfileWithVersion("v2026.7.1"),
        reviewedVersions: ["v2026.6.19", "v2026.7.1"],
      }),
    ).toBeNull();
  });

  it("fails when the pinned version has not been reviewed", () => {
    const error = checkHermesLightSkinBoundary({
      dockerfileText: dockerfileWithVersion("v2026.8.1"),
      reviewedVersions: ["v2026.6.19", "v2026.7.1"],
    });

    expect(error).toContain("needs re-review");
    expect(error).toContain("v2026.8.1");
  });

  it("fails when the Dockerfile has no HERMES_VERSION arg", () => {
    const error = checkHermesLightSkinBoundary({
      dockerfileText: "FROM debian:bookworm-slim\n",
      reviewedVersions: ["v2026.7.1"],
    });

    expect(error).toContain("could not find ARG HERMES_VERSION");
  });
});
