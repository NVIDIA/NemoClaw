// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { detectNvidiaPlatform } from "./nim";

const PCI_ROOT = "/sys/bus/pci/devices";
const PCI_ENTRY = "0000:01:00.0";

interface PciFixtureValues {
  vendor: string;
  device: string;
  pciClass: string;
}

function withFirmwareProducts(
  products: Partial<
    Record<"productName" | "productFamily" | "boardName" | "deviceTreeModel", string>
  >,
  assertion: () => void,
  pciValues?: PciFixtureValues,
): void {
  const originalReadFileSync = fs.readFileSync;
  const originalReaddirSync = fs.readdirSync;
  const values = new Map<string, string>([
    ["/sys/class/dmi/id/product_name", products.productName ?? ""],
    ["/sys/class/dmi/id/product_family", products.productFamily ?? ""],
    ["/sys/class/dmi/id/board_name", products.boardName ?? ""],
    ["/sys/firmware/devicetree/base/model", products.deviceTreeModel ?? ""],
  ]);
  const pciEntryPath = `${PCI_ROOT}/${PCI_ENTRY}`;
  values.set(`${pciEntryPath}/vendor`, pciValues?.vendor ?? "");
  values.set(`${pciEntryPath}/device`, pciValues?.device ?? "");
  values.set(`${pciEntryPath}/class`, pciValues?.pciClass ?? "");
  fs.readdirSync = ((directory: unknown, ...args: unknown[]) =>
    String(directory) === PCI_ROOT
      ? [PCI_ENTRY]
      : Reflect.apply(originalReaddirSync, fs, [directory, ...args])) as typeof fs.readdirSync;
  fs.readFileSync = ((filePath: unknown, ...args: unknown[]) =>
    values.has(String(filePath))
      ? (values.get(String(filePath)) ?? "")
      : Reflect.apply(originalReadFileSync, fs, [filePath, ...args])) as typeof fs.readFileSync;
  try {
    assertion();
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.readdirSync = originalReaddirSync;
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

  it("classifies family-only Station identity through the real PCI scanner (#10928)", () => {
    withFirmwareProducts(
      { productName: "Generic ARM workstation", productFamily: "NVIDIA DGX Station GB300" },
      () => expect(detectNvidiaPlatform()).toBe("station"),
      { vendor: "0x10de\n", device: "0x31c2\n", pciClass: "0x030000\n" },
    );
  });

  it.each([
    ["wrong device", { vendor: "0x10de\n", device: "0xffff\n", pciClass: "0x030000\n" }],
    ["malformed class", { vendor: "0x10de\n", device: "0x31c2\n", pciClass: "0x030000extra\n" }],
  ])("denies family-only Station through the real PCI scanner for %s (#10928)", (_case, pci) => {
    withFirmwareProducts(
      { productName: "Generic ARM workstation", productFamily: "NVIDIA DGX Station GB300" },
      () => expect(detectNvidiaPlatform()).toBe("linux"),
      pci,
    );
  });

  it.each(["DGX-Station", "P3830"])("does not admit unqualified Station identifier %s", (value) => {
    withFirmwareProducts({ productName: value }, () =>
      expect(detectNvidiaPlatform({ stationGb300PciGpu: true })).toBe("linux"),
    );
  });
});
