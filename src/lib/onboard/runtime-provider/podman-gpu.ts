// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const NVIDIA_CDI_PREFIX = "nvidia.com/gpu=";
const CDI_DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const LEGACY_MIG_DEVICE_NAME = /^MIG-GPU-[A-Za-z0-9-]+\/[0-9]+\/[0-9]+$/u;

export interface PodmanGpuAttachment {
  readonly kind: "cdi";
  readonly device: string;
}

/**
 * Normalize one NVIDIA CDI device identity without consulting host state.
 * Availability is proved separately against the exact Podman endpoint's
 * qualified inventory.
 */
export function normalizeNvidiaCdiDevice(requestedDevice: string): string {
  const requested = requestedDevice.trim();
  const device = requested.startsWith(NVIDIA_CDI_PREFIX)
    ? requested
    : `${NVIDIA_CDI_PREFIX}${requested}`;
  const name = device.slice(NVIDIA_CDI_PREFIX.length);
  if (!CDI_DEVICE_NAME.test(name) && !LEGACY_MIG_DEVICE_NAME.test(name)) {
    throw new Error(
      "Podman GPU device must be a safe NVIDIA CDI name such as 'all', '0', '1:0', 'GPU-...', or 'MIG-...'.",
    );
  }
  return device;
}

export function normalizePodmanCdiInventory(devices: readonly string[]): readonly string[] {
  if (!Array.isArray(devices) || devices.length > 256) {
    throw new Error("Podman CDI inventory is invalid or exceeds its device limit.");
  }
  const normalized = devices.map(normalizeNvidiaCdiDevice).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Podman CDI inventory contains a duplicate NVIDIA device.");
  }
  return Object.freeze(normalized);
}

export function qualifyPodmanGpuAttachments(
  availableDevices: readonly string[],
  requestedDevices: readonly string[] = ["all"],
): readonly PodmanGpuAttachment[] {
  const available = new Set(normalizePodmanCdiInventory(availableDevices));
  if (!Array.isArray(requestedDevices) || requestedDevices.length === 0) {
    throw new Error("Podman GPU attachment requires at least one NVIDIA CDI device.");
  }
  const requested = requestedDevices.map(normalizeNvidiaCdiDevice);
  if (new Set(requested).size !== requested.length) {
    throw new Error("Podman GPU attachment contains a duplicate NVIDIA CDI device.");
  }
  for (const device of requested) {
    if (!available.has(device)) {
      throw new Error(
        `Rootless Podman does not advertise the requested CDI device '${device}'. Refresh the NVIDIA CDI specification and retry.`,
      );
    }
  }
  return Object.freeze(requested.map((device) => Object.freeze({ kind: "cdi" as const, device })));
}
