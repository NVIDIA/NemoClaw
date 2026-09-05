// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { detectNvidiaPlatform } from "./nim";

function withFirmwareProducts(
  products: Partial<
    Record<"productName" | "productFamily" | "boardName" | "deviceTreeModel", string>
  >,
  assertion: () => void,
): void {
  const originalReadFileSync = fs.readFileSync;
  const values = new Map<string, string>([
    ["/sys/class/dmi/id/product_name", products.productName ?? ""],
    ["/sys/class/dmi/id/product_family", products.productFamily ?? ""],
    ["/sys/class/dmi/id/board_name", products.boardName ?? ""],
    ["/sys/firmware/devicetree/base/model", products.deviceTreeModel ?? ""],
  ]);
  fs.readFileSync = ((filePath: unknown, ...args: unknown[]) =>
    values.has(String(filePath))
      ? (values.get(String(filePath)) ?? "")
      : Reflect.apply(originalReadFileSync, fs, [filePath, ...args])) as typeof fs.readFileSync;
  try {
    assertion();
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

describe("NVIDIA platform firmware identity", () => {
  it("classifies Station GB300 from product family when product name is generic (#10928)", () => {
    withFirmwareProducts(
      { productName: "Generic ARM workstation", productFamily: "NVIDIA DGX Station GB300" },
      () => expect(detectNvidiaPlatform({ stationGb300PciGpu: true })).toBe("station"),
    );
  });

  it("rejects conflicting NVIDIA firmware identities (#10928)", () => {
    withFirmwareProducts(
      { productName: "NVIDIA DGX Spark", productFamily: "NVIDIA DGX Station GB300" },
      () => expect(detectNvidiaPlatform({ stationGb300PciGpu: true })).toBe("linux"),
    );
  });

  it("requires exact GB300 PCI identity for Station firmware (#10928)", () => {
    withFirmwareProducts({ productName: "NVIDIA DGX Station GB300" }, () =>
      expect(detectNvidiaPlatform({ stationGb300PciGpu: false })).toBe("linux"),
    );
  });

  it.each(["DGX-Station", "P3830"])("does not admit unqualified Station identifier %s", (value) => {
    withFirmwareProducts({ productName: value }, () =>
      expect(detectNvidiaPlatform({ stationGb300PciGpu: true })).toBe("linux"),
    );
  });
});
