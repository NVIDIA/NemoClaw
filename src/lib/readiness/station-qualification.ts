// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const STATION_GB300_PRODUCT_PATTERN = /(?:^|[^A-Za-z0-9])Station[\s_-]+GB300(?:$|[^A-Za-z0-9])/iu;
const NVIDIA_PCI_VENDOR = "0x10de";
const STATION_GB300_PCI_DEVICES = new Set(["0x31c2", "0x31c3"]);
const DISPLAY_PCI_CLASS_PATTERN = /^0x03[0-9a-f]{4}$/iu;
export const STATION_RELEASE_MARKER_MAX_BYTES = 4096;

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

export function isStationGb300PciDevice(
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

export function isQualifiedStationRuntime(input: {
  platform: string;
  architecture: string;
  osId?: string | null;
  osVersionId?: string | null;
  hasNvidiaGpu: boolean;
}): boolean {
  return (
    input.platform === "linux" &&
    input.architecture === "arm64" &&
    input.osId === "ubuntu" &&
    input.osVersionId === "24.04" &&
    input.hasNvidiaGpu
  );
}

export function isTrustedStationReleaseMarker(metadata: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  uid: number;
  gid: number;
  mode: number;
}): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size > 0 &&
    metadata.size <= STATION_RELEASE_MARKER_MAX_BYTES &&
    metadata.uid === 0 &&
    metadata.gid === 0 &&
    (metadata.mode & 0o022) === 0
  );
}
