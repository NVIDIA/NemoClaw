// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectTegraDeviceGroupGids } from "./docker-gpu-jetson-groups";

describe("detectTegraDeviceGroupGids", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns unique host-owned GIDs with effective group read/write permission", () => {
    const deviceAccess: Record<string, { gid: number; mode: number }> = {
      "/dev/nvmap": { gid: 44, mode: 0o440 },
      "/dev/nvhost-ctrl": { gid: 44, mode: 0o660 },
      "/dev/nvgpu/igpu0/ctrl": { gid: 110, mode: 0o660 },
    };

    expect(
      detectTegraDeviceGroupGids({
        statDeviceAccess: (path: string) => deviceAccess[path] ?? null,
        listDevicePaths: () => Object.keys(deviceAccess),
      }),
    ).toEqual(["44", "110"]);
  });

  it("rejects unusable or unnecessary device-group access", () => {
    const access = [
      { gid: Number.NaN, mode: 0o660 },
      { gid: 1.5, mode: 0o660 },
      { gid: -1, mode: 0o660 },
      { gid: 0, mode: 0o660 },
      { gid: 2_147_483_648, mode: 0o660 },
      { gid: 44, mode: 0o600 },
      { gid: 104, mode: 0o666 },
    ];
    let index = 0;

    expect(
      detectTegraDeviceGroupGids({
        statDeviceAccess: () => access[index++] ?? null,
        listDevicePaths: () => access.map((_, accessIndex) => `/dev/device${accessIndex}`),
      }),
    ).toEqual([]);
  });

  it("returns no GIDs when Tegra nodes are missing or unreadable", () => {
    expect(
      detectTegraDeviceGroupGids({
        statDeviceAccess: () => null,
        listDevicePaths: () => ["/dev/nvmap"],
      }),
    ).toEqual([]);

    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    try {
      expect(detectTegraDeviceGroupGids({ listDevicePaths: () => ["/dev/nvmap"] })).toEqual([]);
    } finally {
      lstat.mockRestore();
    }
  });

  it("rejects regular files and symlinks before reading their group", () => {
    const lstat = vi
      .spyOn(fs, "lstatSync")
      .mockReturnValueOnce({
        gid: 110,
        mode: 0o660,
        isCharacterDevice: () => false,
        isSymbolicLink: () => false,
      } as fs.Stats)
      .mockReturnValueOnce({
        gid: 120,
        mode: 0o660,
        isCharacterDevice: () => false,
        isSymbolicLink: () => true,
      } as fs.Stats);

    try {
      expect(
        detectTegraDeviceGroupGids({
          listDevicePaths: () => ["/dev/nvgpu/igpu0/not-a-device", "/dev/nvgpu/igpu0/link"],
        }),
      ).toEqual([]);
    } finally {
      lstat.mockRestore();
    }
  });

  it("adds the host render group from real DRI render devices only", () => {
    const readdir = vi.spyOn(fs, "readdirSync").mockImplementation(
      () =>
        [
          {
            name: "renderD128",
            isCharacterDevice: () => true,
            isSymbolicLink: () => false,
          },
          {
            name: "renderD129",
            isCharacterDevice: () => false,
            isSymbolicLink: () => true,
          },
          {
            name: "card0",
            isCharacterDevice: () => true,
            isSymbolicLink: () => false,
          },
        ] as never,
    );
    const lstat = vi.spyOn(fs, "lstatSync").mockReturnValue({
      gid: 104,
      mode: 0o660,
      isCharacterDevice: () => true,
      isSymbolicLink: () => false,
    } as fs.Stats);

    try {
      expect(detectTegraDeviceGroupGids()).toEqual(["104"]);
      expect(lstat).toHaveBeenCalledWith("/dev/dri/renderD128");
      expect(lstat).not.toHaveBeenCalledWith("/dev/dri/renderD129");
      expect(lstat).not.toHaveBeenCalledWith("/dev/dri/card0");
    } finally {
      lstat.mockRestore();
      readdir.mockRestore();
    }
  });
});
