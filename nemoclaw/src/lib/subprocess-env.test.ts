// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildDockerSubprocessEnv } from "./subprocess-env";

const source = {
  PATH: "/usr/bin",
  DOCKER_HOST: "unix:///ambient.sock",
  DOCKER_CONFIG: "/source/docker",
  DOCKER_CONTEXT: "source-context",
  NVIDIA_INFERENCE_API_KEY: "must-not-leak",
};

describe("buildDockerSubprocessEnv", () => {
  it("keeps the selected default authority without forwarding an ambient host", () => {
    expect(
      buildDockerSubprocessEnv(source, undefined, {
        DOCKER_CONFIG: "/selected/docker",
        DOCKER_CONTEXT: "selected-context",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      DOCKER_CONFIG: "/selected/docker",
      DOCKER_CONTEXT: "selected-context",
    });
  });

  it("pins an explicit host without a competing Docker context", () => {
    expect(
      buildDockerSubprocessEnv(source, "unix:///selected.sock", {
        DOCKER_CONFIG: "/ignored/docker",
        DOCKER_CONTEXT: "ignored-context",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///selected.sock",
    });
  });
});
