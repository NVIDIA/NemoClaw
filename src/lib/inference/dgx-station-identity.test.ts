// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { detectNvidiaPlatform } from "./nim";

function withFirmware(productName: string, productFamily: string, assertion: () => void): void {
  const values = new Map([
    ["/sys/class/dmi/id/product_name", productName],
    ["/sys/class/dmi/id/product_family", productFamily],
    ["/sys/class/dmi/id/board_name", ""],
    ["/sys/firmware/devicetree/base/model", ""],
  ]);
  const readFile = vi
    .spyOn(fs, "readFileSync")
    .mockImplementation(
      ((filePath: fs.PathOrFileDescriptor) =>
        values.get(String(filePath)) ?? "") as typeof fs.readFileSync,
    );
  try {
    assertion();
  } finally {
    readFile.mockRestore();
  }
}

describe("DGX Station identity consumption", () => {
  it("uses a Station GB300 product-family identity (#10928)", () => {
    withFirmware("Generic ARM workstation", "NVIDIA DGX Station GB300", () => {
      expect(detectNvidiaPlatform({ stationGb300PciGpu: true })).toBe("station");
    });
  });

  it("rejects conflicting NVIDIA firmware identities (#10928)", () => {
    withFirmware("NVIDIA DGX Spark", "NVIDIA DGX Station GB300", () => {
      expect(detectNvidiaPlatform({ stationGb300PciGpu: true })).toBe("linux");
    });
  });
});
