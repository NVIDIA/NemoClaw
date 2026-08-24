// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const NVIDIA_CDI_PREFIX = "nvidia.com/gpu=";
const CDI_DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const LEGACY_MIG_DEVICE_NAME = /^MIG-GPU-[A-Za-z0-9-]+\/[0-9]+\/[0-9]+$/u;
const MAX_CDI_DEVICES = 256;

export interface PodmanGpuAttachment {
  readonly kind: "cdi";
  readonly device: string;
}

function safeDeviceName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error("Podman GPU device must be one safe NVIDIA CDI identity.");
  }
  return value;
}

/** Normalize one requested NVIDIA device without consulting host state. */
export function normalizeNvidiaCdiDevice(requestedDevice: string): string {
  const requested = safeDeviceName(requestedDevice);
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

/** Validate the exact canonical NVIDIA subset reported by Podman's CDI registry. */
export function normalizePodmanCdiInventory(devices: readonly string[]): readonly string[] {
  if (!Array.isArray(devices) || devices.length > MAX_CDI_DEVICES) {
    throw new Error("Podman CDI inventory is invalid or exceeds its device limit.");
  }
  const normalized = devices.map((device) => {
    const exact = safeDeviceName(device);
    const canonical = normalizeNvidiaCdiDevice(exact);
    if (canonical !== exact) {
      throw new Error("Podman CDI inventory must contain canonical NVIDIA device identities.");
    }
    return canonical;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Podman CDI inventory contains a duplicate NVIDIA device.");
  }
  return Object.freeze(normalized.sort());
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
