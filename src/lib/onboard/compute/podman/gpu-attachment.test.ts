// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assertPodmanGpuAttachmentQualified, resolvePodmanGpuAttachment } from "./gpu-attachment";

describe("Podman GPU attachment", () => {
  it.each([
    [null, "nvidia.com/gpu=all"],
    ["all", "nvidia.com/gpu=all"],
    ["0", "nvidia.com/gpu=0"],
    ["1:0", "nvidia.com/gpu=1:0"],
    ["GPU-deadbeef", "nvidia.com/gpu=GPU-deadbeef"],
    ["nvidia.com/gpu=MIG-deadbeef", "nvidia.com/gpu=MIG-deadbeef"],
    [
      "MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0",
      "nvidia.com/gpu=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0",
    ],
  ])("normalizes %s to a qualified CDI identity", (requested, expected) => {
    expect(resolvePodmanGpuAttachment(true, requested)).toEqual({
      kind: "cdi",
      device: expected,
    });
  });

  it("returns no attachment for a CPU sandbox", () => {
    expect(resolvePodmanGpuAttachment(false, "nvidia.com/gpu=all")).toBeNull();
  });

  it("rejects unsafe names and CDI devices absent from exact-socket qualification", () => {
    expect(() => resolvePodmanGpuAttachment(true, "../../dev/nvidia0")).toThrow(
      "safe NVIDIA CDI name",
    );
    expect(() =>
      assertPodmanGpuAttachmentQualified(
        ["nvidia.com/gpu=0"],
        resolvePodmanGpuAttachment(true, "all")!,
      ),
    ).toThrow("does not advertise");
  });
});
