// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assertNoDockerfileBuild } from "../fixtures/docker-build-guard.ts";

describe("Docker build guard", () => {
  it.each([
    "build .",
    "buildx build .",
    "--context default build .",
    "-H unix:///var/run/docker.sock buildx build .",
    "buildx bake",
    "--context default buildx bake release",
  ])("rejects a Dockerfile build recorded as %s", (trace) => {
    expect(() => assertNoDockerfileBuild(trace)).toThrow("forbidden Dockerfile build");
  });

  it("allows Docker commands that do not build an image", () => {
    expect(() => assertNoDockerfileBuild("--context default info\nps --all\n")).not.toThrow();
  });
});
