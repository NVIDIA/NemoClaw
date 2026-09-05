// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const NVIDIA_FIRMWARE_VALUE_MAX_BYTES = 256;

const STATION_GB300_PRODUCT_PATTERN = /(?:^|[^A-Za-z0-9])Station[\s_-]+GB300(?:$|[^A-Za-z0-9])/iu;
const NVIDIA_PCI_VENDOR = "0x10de";
const STATION_GB300_PCI_DEVICES = new Set(["0x31c2", "0x31c3"]);
const DISPLAY_PCI_CLASS_PATTERN = /^0x03[0-9a-f]{4}$/iu;

export type NvidiaFirmwareProductClass = "spark" | "station-gb300" | "station-other" | "jetson";

export interface NvidiaFirmwareIdentity {
  firmwareClass?: NvidiaFirmwareProductClass;
  nvidiaPlatform?: "spark" | "station" | "jetson";
  stationFirmwareProduct?: string;
  platformIdentityConflict?: true;
}

/** Match the bounded product identifiers reported by supported DGX Station GB300 firmware. */
export function isDgxStationGb300Product(productName: string): boolean {
  return STATION_GB300_PRODUCT_PATTERN.test(productName.trim());
}

export function isDgxStationGb300PciDevice(
  vendor: string | null | undefined,
  device: string | null | undefined,
  pciClass: string | null | undefined,
): boolean {
  return (
    vendor?.trim().toLowerCase() === NVIDIA_PCI_VENDOR &&
    STATION_GB300_PCI_DEVICES.has(device?.trim().toLowerCase() ?? "") &&
    DISPLAY_PCI_CLASS_PATTERN.test(pciClass?.trim() ?? "")
  );
}

export function readBoundedNvidiaFirmwareValue(
  readFile: (filePath: string) => string,
  filePath: string,
  stripNul = false,
): string | undefined {
  try {
    const contents = readFile(filePath);
    const normalized = (stripNul ? contents.replace(/\0/g, "") : contents).replace(/\n+$/u, "");
    if (
      Buffer.byteLength(normalized) > NVIDIA_FIRMWARE_VALUE_MAX_BYTES ||
      /[\r\n\0]/u.test(normalized)
    ) {
      return undefined;
    }
    return normalized.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function nvidiaFirmwareProductClass(
  product: string,
): NvidiaFirmwareProductClass | undefined {
  if (/DGX[_\s-]+Spark/iu.test(product)) return "spark";
  if (isDgxStationGb300Product(product)) return "station-gb300";
  if (/(?<![A-Za-z0-9])P3830(?![A-Za-z0-9])/iu.test(product)) return "station-other";
  if (/DGX[_\s-]+Station/iu.test(product)) return "station-other";
  if (/Jetson|Tegra|Thor|Orin|Xavier/iu.test(product)) return "jetson";
  return undefined;
}

export function classifyNvidiaFirmwareProducts(
  products: readonly (string | null | undefined)[],
): NvidiaFirmwareIdentity {
  let recognized: NvidiaFirmwareProductClass | undefined;
  let stationFirmwareProduct: string | undefined;
  for (const product of products) {
    if (!product) continue;
    const current = nvidiaFirmwareProductClass(product);
    if (!current) continue;
    if (recognized && recognized !== current) return { platformIdentityConflict: true };
    recognized = current;
    if (current === "station-gb300" && !stationFirmwareProduct) stationFirmwareProduct = product;
  }
  if (recognized === "station-gb300" || recognized === "station-other") {
    return {
      firmwareClass: recognized,
      nvidiaPlatform: "station",
      ...(stationFirmwareProduct ? { stationFirmwareProduct } : {}),
    };
  }
  return recognized ? { firmwareClass: recognized, nvidiaPlatform: recognized } : {};
}

export function hasDgxStationGb300PciGpu(
  readFile: (filePath: string) => string,
  readdir: (directory: string) => readonly string[],
  pciDevicesPath = "/sys/bus/pci/devices",
): boolean | undefined {
  try {
    const entries = readdir(pciDevicesPath);
    let incompleteEvidence = entries.length > 256;
    for (const entry of entries.slice(0, 256)) {
      const devicePath = path.join(pciDevicesPath, entry);
      const vendor = readBoundedNvidiaFirmwareValue(readFile, path.join(devicePath, "vendor"));
      const device = readBoundedNvidiaFirmwareValue(readFile, path.join(devicePath, "device"));
      const pciClass = readBoundedNvidiaFirmwareValue(readFile, path.join(devicePath, "class"));
      if (isDgxStationGb300PciDevice(vendor, device, pciClass)) return true;
      if (vendor === undefined || device === undefined || pciClass === undefined) {
        incompleteEvidence = true;
      }
    }
    return incompleteEvidence ? undefined : false;
  } catch {
    return undefined;
  }
}
