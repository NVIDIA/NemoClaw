// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../core/ports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/ports")>()),
  VLLM_PORT: 19_000,
}));

import { buildVllmRunArgs, detectVllmProfile } from "./vllm";

describe("managed vLLM configured host port", () => {
  it.each([undefined, "0.0.0.0", "::", "203.0.113.1"])(
    "rejects bridge address %s without managed bearer authentication (#14083)",
    (bridgeHost) => {
      const profile = detectVllmProfile({ platform: "linux", type: "nvidia" })!;
      expect(() =>
        buildVllmRunArgs(
          profile,
          { ...profile.defaultModel, managedBearerAuth: undefined },
          profile.dockerRunFlags,
          {},
          bridgeHost,
        ),
      ).toThrow("requires one private OpenShell bridge address");
    },
  );

  it.each([undefined, true] as const)(
    "publishes the configured port on loopback and the OpenShell bridge when managed bearer authentication is %s (#14083)",
    (managedBearerAuth) => {
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
        managedBearerAuth,
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

      const args = buildVllmRunArgs(
        profile,
        model,
        profile.dockerRunFlags,
        { VLLM_API_KEY: "a".repeat(64) },
        "172.18.0.1",
      );
      expect(args.flatMap((value, index) => (value === "-p" ? [args[index + 1]] : []))).toEqual([
        "127.0.0.1:19000:8000",
        "172.18.0.1:19000:8000",
      ]);
    },
  );
});
