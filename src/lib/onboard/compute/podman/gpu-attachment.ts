// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const NVIDIA_CDI_PREFIX = "nvidia.com/gpu=";
const CDI_DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const LEGACY_MIG_DEVICE_NAME = /^MIG-GPU-[A-Za-z0-9-]+\/[0-9]+\/[0-9]+$/u;

export interface PodmanGpuAttachment {
  readonly kind: "cdi";
  readonly device: string;
}

/**
 * Return one canonical NVIDIA CDI device identity. The accepted selector
 * surface covers the identities emitted by nvidia-ctk: `all`, numeric GPU and
 * MIG indices, GPU/MIG UUIDs, and the legacy MIG-GPU-.../<gi>/<ci> spelling.
 * Availability is proved separately against the qualified Podman runtime.
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

export function resolvePodmanGpuAttachment(
  enabled: boolean,
  requestedDevice: string | null | undefined,
): PodmanGpuAttachment | null {
  if (!enabled) return null;
  return {
    kind: "cdi",
    device: normalizeNvidiaCdiDevice(requestedDevice?.trim() || "all"),
  };
}

export function assertPodmanGpuAttachmentQualified(
  availableDevices: readonly string[],
  attachment: PodmanGpuAttachment,
): void {
  if (!availableDevices.includes(attachment.device)) {
    throw new Error(
      `Rootless Podman does not advertise the requested CDI device '${attachment.device}'. Refresh the NVIDIA CDI specification and retry.`,
    );
  }
}
