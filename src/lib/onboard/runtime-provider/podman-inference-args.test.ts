// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { translatePodmanLocalInferenceArgs } from "./podman-inference-args";

const CDI_DEVICES = [
  "nvidia.com/gpu=all",
  "nvidia.com/gpu=0",
  "nvidia.com/gpu=1:0",
  "nvidia.com/gpu=2",
  "nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "nvidia.com/gpu=MIG-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "nvidia.com/gpu=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0",
] as const;

describe("Podman local inference command translation", () => {
  it.each([
    ["all", ["nvidia.com/gpu=all"]],
    ["device=0", ["nvidia.com/gpu=0"]],
    ["device=1:0", ["nvidia.com/gpu=1:0"]],
    [
      "device=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ["nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    ],
    [
      "device=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0",
      ["nvidia.com/gpu=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0"],
    ],
    ['"device=0,2"', ["nvidia.com/gpu=0", "nvidia.com/gpu=2"]],
  ])("preserves Docker selector %s as exact CDI devices", (selector, devices) => {
    const translated = translatePodmanLocalInferenceArgs(
      ["run", "--gpus", selector, "image"],
      CDI_DEVICES,
    );
    expect(translated.filter((value) => value.startsWith("nvidia.com/gpu="))).toEqual(devices);
    expect(translated.filter((value) => value === "--device")).toHaveLength(devices.length);
    expect(translated).not.toContain("--gpus");
  });

  it("translates the NIM and vLLM subset without Docker name-filter leakage", () => {
    expect(
      translatePodmanLocalInferenceArgs(
        ["run", "--gpus=all", "--filter", "name=^/nemoclaw-vllm$"],
        CDI_DEVICES,
      ),
    ).toEqual(["run", "--device", "nvidia.com/gpu=all", "--filter", "name=^nemoclaw-vllm$"]);
    expect(
      translatePodmanLocalInferenceArgs(["run", "--device=nvidia.com/gpu=0", "image"], CDI_DEVICES),
    ).toEqual(["run", "--device", "nvidia.com/gpu=0", "image"]);
  });

  it("fails closed instead of dropping unsupported Docker GPU modes", () => {
    expect(() =>
      translatePodmanLocalInferenceArgs(
        ["run", "--gpus", "capabilities=compute", "image"],
        CDI_DEVICES,
      ),
    ).toThrow("cannot translate Docker GPU selector");
    expect(() =>
      translatePodmanLocalInferenceArgs(["run", "--gpus", "device=0,0"], CDI_DEVICES),
    ).toThrow("duplicate NVIDIA CDI device");
    expect(() =>
      translatePodmanLocalInferenceArgs(["run", "--runtime", "nvidia"], CDI_DEVICES),
    ).toThrow("refuses Docker's NVIDIA runtime mode");
    expect(() =>
      translatePodmanLocalInferenceArgs(["run", "--device", "/dev/nvidia0"], CDI_DEVICES),
    ).toThrow("refuses raw NVIDIA device paths");
    expect(() =>
      translatePodmanLocalInferenceArgs(["run", "--gpus", "device=9"], CDI_DEVICES),
    ).toThrow("does not advertise");
  });
});
