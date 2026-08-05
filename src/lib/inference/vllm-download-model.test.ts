// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireHuggingFaceModel: vi.fn(),
  dockerSpawn: vi.fn(),
}));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerSpawn: mocks.dockerSpawn,
}));

vi.mock("./model-acquisition/hugging-face", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-acquisition/hugging-face")>()),
  acquireHuggingFaceModel: mocks.acquireHuggingFaceModel,
}));

import { detectVllmProfile, downloadModel } from "./vllm";

describe("vLLM model acquisition adapter", () => {
  it("maps the existing vLLM contract to shared acquisition and preserves failures (#8279)", async () => {
    const failure = {
      ok: false as const,
      reason: "hf download failed (exit 1)",
    };
    mocks.acquireHuggingFaceModel.mockResolvedValue(failure);
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const model = profile.defaultModel;
    const dockerEnv = { DOCKER_HOST: "ssh://spark.example.test" };

    await expect(
      downloadModel(profile, model, dockerEnv, {
        hostCacheDir: "/home/nvidia/.cache/huggingface",
        userIdentity: "1001:1001",
      }),
    ).resolves.toBe(failure);

    expect(mocks.acquireHuggingFaceModel).toHaveBeenCalledOnce();
    expect(mocks.acquireHuggingFaceModel).toHaveBeenCalledWith(
      {
        dockerEnv,
        downloaderImage: profile.image,
        hostCacheDir: "/home/nvidia/.cache/huggingface",
        repository: model.id,
        revision: model.revision,
        spawnDocker: mocks.dockerSpawn,
        userIdentity: "1001:1001",
      },
      {
        logLine: expect.any(Function),
        onRateLimit: expect.any(Function),
      },
    );
    expect(mocks.dockerSpawn).not.toHaveBeenCalled();
  });
});
