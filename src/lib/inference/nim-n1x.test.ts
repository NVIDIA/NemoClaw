// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { detectNvidiaPlatform } from "./nim";

function withFirmwareModel(model: string, fn: () => void): void {
  const originalReadFileSync = fs.readFileSync;
  const firmwareFiles = new Map<fs.PathOrFileDescriptor, string>([
    ["/sys/class/dmi/id/product_name", model],
    ["/sys/firmware/devicetree/base/model", ""],
  ]);
  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    return (
      firmwareFiles.get(filePath) ?? Reflect.apply(originalReadFileSync, fs, [filePath, ...args])
    );
  }) as typeof fs.readFileSync;
  try {
    fn();
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

describe("N1x NVIDIA platform detection", () => {
  it("classifies a trusted DGX Spark FastOS marker on an OEM ARM64 host (#10717)", () => {
    withFirmwareModel("OEM GB10 system", () => {
      expect(
        detectNvidiaPlatform({
          hostPlatform: "linux",
          architecture: "arm64",
          collectN1xIdentityImpl: () => ({
            candidate: true,
            fastOsMarker: false,
            fastOsPlatform: "spark",
            pciGpu: undefined,
            qualified: false,
          }),
        }),
      ).toBe("spark");
    });
  });

  it("requires a qualified identity instead of generic SKU 1 firmware (#8574)", () => {
    withFirmwareModel("SKU 1", () => {
      const qualified = () => ({
        candidate: true,
        fastOsMarker: true,
        pciGpu: true,
        qualified: true,
      });
      const markerOnly = () => ({
        candidate: true,
        fastOsMarker: true,
        pciGpu: false,
        qualified: false,
      });

      expect(
        detectNvidiaPlatform({
          hostPlatform: "linux",
          architecture: "arm64",
          collectN1xIdentityImpl: qualified,
        }),
      ).toBe("n1x");
      expect(
        detectNvidiaPlatform({
          hostPlatform: "linux",
          architecture: "arm64",
          collectN1xIdentityImpl: markerOnly,
        }),
      ).toBe("linux");
    });
  });

  it.each([
    ["the wrong operating system", "darwin", "arm64"],
    ["the wrong architecture", "linux", "x64"],
  ] as const)("does not classify N1x on %s (#8574)", (_scenario, hostPlatform, architecture) => {
    withFirmwareModel("SKU 1", () => {
      expect(
        detectNvidiaPlatform({
          hostPlatform,
          architecture,
          collectN1xIdentityImpl: () => ({
            candidate: true,
            fastOsMarker: true,
            pciGpu: true,
            qualified: true,
          }),
        }),
      ).toBe("linux");
    });
  });
});
