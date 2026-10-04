// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isDgxStationGb300PciDevice,
  isDgxStationGb300Product,
} from "../inference/dgx-station-identity.js";
export const STATION_RELEASE_MARKER_MAX_BYTES = 4096;

export type StationProfile =
  | "generic-ubuntu"
  | "supported-dgx-os"
  | "supported-colossus-baseos"
  | "supported-ai-developer-tools"
  | "unsupported-dgx-os"
  | "unknown";

export function isStationGb300ProductName(productName: string): boolean {
  return isDgxStationGb300Product(productName);
}

export function isQualifiedStationProfile(profile: StationProfile | null | undefined): boolean {
  return (
    profile === "generic-ubuntu" ||
    profile === "supported-dgx-os" ||
    profile === "supported-colossus-baseos" ||
    profile === "supported-ai-developer-tools"
  );
}

export function isStationGb300PciDevice(
  vendor: string | null | undefined,
  device: string | null | undefined,
  pciClass: string | null | undefined,
): boolean {
  return isDgxStationGb300PciDevice(vendor, device, pciClass);
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
