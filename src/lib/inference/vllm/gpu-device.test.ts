// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildVllmRunArgs, detectVllmProfile, selectVllmGpuDevice } from "../vllm";
import { normalizeVllmGpuDevice } from "../vllm-models";

describe("managed vLLM GPU selection", () => {
  it.each([
    ["an index", "2"],
    ["a UUID", "GPU-69adb14e-820e-bfb4-0993-171e73f68504"],
  ])("uses %s as the exact Docker GPU request", (_kind, device) => {
    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" })!;
    const selected = selectVllmGpuDevice(profile, device);
    const args = buildVllmRunArgs(
      selected,
      selected.defaultModel,
      selected.buildDockerRunFlags?.() ?? selected.dockerRunFlags,
    );

    expect(args.slice(args.indexOf("--gpus"), args.indexOf("--gpus") + 2)).toEqual([
      "--gpus",
      `device=${device}`,
    ]);
  });

  it.each(["-1", "GPU-deadbeef", "nvidia.com/gpu=0", "0,1"])(
    "rejects unsupported selector %s",
    (device) => {
      expect(() => normalizeVllmGpuDevice(device)).toThrow(
        "non-negative GPU index or full GPU UUID",
      );
    },
  );
});
