// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../core/ports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/ports")>()),
  VLLM_PORT: 19_000,
}));

import { buildVllmRunArgs } from "./vllm";

describe("managed vLLM configured host port", () => {
  it("maps a fixed serving recipe onto NEMOCLAW_VLLM_PORT", () => {
    const model = {
      id: "test/model",
      label: "Test model",
      envValue: "test-model",
      downloadSizeBytes: 1,
      maxModelLen: 4096,
      modelArgs: [],
      gated: false,
      platforms: ["linux" as const],
      fixedServeCommand: true as const,
    };
    const image = `vllm/vllm-openai@sha256:${"1".repeat(64)}`;
    const profile = {
      name: "Linux + NVIDIA GPU",
      platform: "linux" as const,
      image,
      imageDownloadSizeBytes: 1,
      defaultModel: model,
      containerName: "nemoclaw-vllm",
      dockerRunFlags: ["--gpus", "all"],
      pullTimeoutSec: 60,
      loadTimeoutSec: 60,
    };

    expect(buildVllmRunArgs(profile, model, profile.dockerRunFlags)).toContain("19000:8000");
  });
});
