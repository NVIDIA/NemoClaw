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
    vi.stubEnv("DOCKER_TLS", "1");
    vi.stubEnv("UNRELATED_SECRET", "do-not-forward");

    const env = buildVllmDockerEnv({ HF_TOKEN: "hf_test" });

    expect(env).toEqual(
      expect.objectContaining({
        DOCKER_CONFIG: "/tmp/nemoclaw-docker-config",
        DOCKER_CONTEXT: "remote-builder",
        DOCKER_HOST: "ssh://fallback.example.test",
        DOCKER_TLS: "1",
        HF_TOKEN: "hf_test",
      }),
    );
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  it("does not inherit Docker selectors omitted from an explicit source (#6757)", () => {
    vi.stubEnv("DOCKER_HOST", "ssh://ambient.example.test");

    const env = buildVllmDockerEnv({}, { DOCKER_CONTEXT: "requested-context" });

    expect(env.DOCKER_CONTEXT).toBe("requested-context");
    expect(env.DOCKER_HOST).toBeUndefined();
  });
});
