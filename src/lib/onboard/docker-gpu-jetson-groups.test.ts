// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectTegraDeviceGroupGids } from "./docker-gpu-jetson-groups";

describe("detectTegraDeviceGroupGids", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns unique host-owned GIDs while skipping missing, root-owned, and oversized nodes", () => {
    const deviceGids: Record<string, number> = {
      "/dev/nvmap": 44,
      "/dev/nvhost-ctrl": 44,
      "/dev/nvhost-gpu": 0,
      "/dev/nvgpu/igpu0/ctrl": 110,
      "/dev/nvgpu/igpu0/as": 2_147_483_648,
    };

    expect(
      detectTegraDeviceGroupGids({
        statDeviceGid: (path: string) => (path in deviceGids ? deviceGids[path] : null),
      }),
    ).toEqual(["44", "110"]);
  });

  it("rejects non-integer, non-numeric, negative, zero, and oversized supplementary GIDs", () => {
    const gids = [Number.NaN, 1.5, -1, 0, 2_147_483_648];
    let index = 0;

    expect(
      detectTegraDeviceGroupGids({
        statDeviceGid: () => gids[index++] ?? null,
      }),
    ).toEqual([]);
  });

  it("returns no GIDs when Tegra nodes are missing or unreadable", () => {
    expect(detectTegraDeviceGroupGids({ statDeviceGid: () => null })).toEqual([]);

    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(detectTegraDeviceGroupGids()).toEqual([]);
  });
});
