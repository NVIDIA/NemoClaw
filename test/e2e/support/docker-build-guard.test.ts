// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertNoDockerfileBuild,
  assertNoLocalImageBuild,
  countLocalImageBuildCommands,
} from "../fixtures/docker-build-guard.ts";

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

  it.each(["build .", "buildx bake", "--url unix:///run/user/1000/podman.sock build ."])(
    "rejects a Podman image build recorded as %s",
    (trace) => {
      expect(() => assertNoLocalImageBuild(trace, "podman")).toThrow(
        "forbidden podman image build",
      );
      expect(countLocalImageBuildCommands(trace)).toBe(1);
    },
  );

  it("allows Podman pull, inspect, lifecycle, and cleanup commands", () => {
    const trace = [
      "pull --retry=0 ghcr.io/example/image@sha256:abc",
      "image inspect --format json ghcr.io/example/image@sha256:abc",
      "container start sandbox-id",
      "rm --force sandbox-id",
    ].join("\n");

    expect(() => assertNoLocalImageBuild(trace, "podman")).not.toThrow();
    expect(countLocalImageBuildCommands(trace)).toBe(0);
  });
});
