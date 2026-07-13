// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVllmDockerEnv } from "./vllm-docker-env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed vLLM Docker client environment", () => {
  it("forwards one Docker context while retaining subprocess secret filtering (#6757)", () => {
    vi.stubEnv("DOCKER_CONFIG", "/tmp/nemoclaw-docker-config");
    vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
    vi.stubEnv("DOCKER_HOST", "ssh://fallback.example.test");
    vi.stubEnv("UNRELATED_SECRET", "do-not-forward");

    const env = buildVllmDockerEnv({ HF_TOKEN: "hf_test" });

    expect(env).toEqual(
      expect.objectContaining({
        DOCKER_CONFIG: "/tmp/nemoclaw-docker-config",
        DOCKER_CONTEXT: "remote-builder",
        DOCKER_HOST: "ssh://fallback.example.test",
        HF_TOKEN: "hf_test",
      }),
    );
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });
});
