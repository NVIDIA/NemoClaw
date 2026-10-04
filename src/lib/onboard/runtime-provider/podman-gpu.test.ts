// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  normalizeNvidiaCdiDevice,
  normalizePodmanCdiInventory,
  qualifyPodmanGpuAttachments,
} from "./podman-gpu";

describe("Podman GPU attachment authority", () => {
  it.each([
    ["all", "nvidia.com/gpu=all"],
    ["0", "nvidia.com/gpu=0"],
    ["1:0", "nvidia.com/gpu=1:0"],
    ["GPU-deadbeef", "nvidia.com/gpu=GPU-deadbeef"],
    ["nvidia.com/gpu=MIG-deadbeef", "nvidia.com/gpu=MIG-deadbeef"],
    [
      "MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0",
      "nvidia.com/gpu=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0",
    ],
  ])("normalizes %s to one canonical NVIDIA CDI identity", (requested, expected) => {
    expect(normalizeNvidiaCdiDevice(requested)).toBe(expected);
  });

  it("qualifies only exact devices advertised by the injected endpoint", () => {
    const attachments = qualifyPodmanGpuAttachments(
      ["nvidia.com/gpu=all", "nvidia.com/gpu=0", "nvidia.com/gpu=GPU-deadbeef"],
      ["0", "GPU-deadbeef"],
    );

    expect(attachments).toEqual([
      { kind: "cdi", device: "nvidia.com/gpu=0" },
      { kind: "cdi", device: "nvidia.com/gpu=GPU-deadbeef" },
    ]);
    expect(Object.isFrozen(attachments)).toBe(true);
    expect(Object.isFrozen(attachments[0])).toBe(true);
  });

  it("sorts and freezes a unique exact Podman inventory", () => {
    const inventory = normalizePodmanCdiInventory(["nvidia.com/gpu=all", "nvidia.com/gpu=0"]);

    expect(inventory).toEqual(["nvidia.com/gpu=0", "nvidia.com/gpu=all"]);
    expect(Object.isFrozen(inventory)).toBe(true);
  });

  it("rejects missing, duplicate, raw, shorthand, and malformed authority", () => {
    expect(() => qualifyPodmanGpuAttachments([], ["all"])).toThrow("does not advertise");
    expect(() =>
      qualifyPodmanGpuAttachments(["nvidia.com/gpu=0"], ["0", "nvidia.com/gpu=0"]),
    ).toThrow("duplicate NVIDIA CDI device");
    expect(() => normalizeNvidiaCdiDevice("/dev/nvidia0")).toThrow("safe NVIDIA CDI name");
    expect(() => normalizePodmanCdiInventory(["all"])).toThrow("canonical NVIDIA");
    expect(() => normalizePodmanCdiInventory(["nvidia.com/gpu=all", "nvidia.com/gpu=all"])).toThrow(
      "duplicate NVIDIA device",
    );
    expect(() => normalizeNvidiaCdiDevice(" nvidia.com/gpu=0 ")).toThrow("safe NVIDIA CDI");
  });
});
