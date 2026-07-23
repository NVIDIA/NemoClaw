// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const STATION_GB300_PRODUCT_PATTERN = /(?:^|[^A-Za-z0-9])Station[\s_-]+GB300(?:$|[^A-Za-z0-9])/iu;
const NVIDIA_PCI_VENDOR = "0x10de";
const DISPLAY_PCI_CLASS_PATTERN = /^0x03[0-9a-f]{4}$/iu;

export type StationProfile =
  | "generic-ubuntu"
  | "supported-dgx-os"
  | "supported-colossus-baseos"
  | "supported-ai-developer-tools"
  | "unsupported-dgx-os"
  | "unknown";

export function isStationGb300ProductName(productName: string): boolean {
  return STATION_GB300_PRODUCT_PATTERN.test(productName.trim());
}

export function isQualifiedStationProfile(profile: StationProfile | null | undefined): boolean {
  return (
    profile !== undefined &&
    profile !== null &&
    profile !== "unknown" &&
    profile !== "unsupported-dgx-os"
  );
}

export function isNvidiaDisplayClassPciDevice(
  vendor: string | null | undefined,
  pciClass: string | null | undefined,
): boolean {
  return (
    vendor?.trim().toLowerCase() === NVIDIA_PCI_VENDOR &&
    DISPLAY_PCI_CLASS_PATTERN.test(pciClass?.trim() ?? "")
  );
}
