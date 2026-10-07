// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeHostedProviderAttachment,
  type NativeHostedProviderAttachment,
} from "../../inference/native-hosted/contract";
import {
  normalizeNativeHostedProviderAuthorities,
  retainNativeHostedProviderAuthority,
} from "../../inference/native-hosted/authority";
import { isValidNativeProviderGateway as isValidName } from "./native-nvidia-provider-authority-state";

import {
  normalizeNativeNvidiaProviderAttachment,
  type NativeNvidiaProviderAttachment,
} from "../../inference/native-nvidia";
import type { SandboxRegistry } from "./types";
import { withLock } from "./lock";
import { load, save } from "./persistence";

export function getNativeNvidiaProviderAuthority(
  gatewayName: string,
): NativeNvidiaProviderAttachment | undefined {
  return normalizeNativeNvidiaProviderAttachment(
    getNativeHostedProviderAuthority(gatewayName, "nemoclaw-nvidia-inference-v1"),
  );
}

export function setNativeNvidiaProviderAuthority(
  gatewayName: string,
  receipt: NativeNvidiaProviderAttachment,
): void {
  if (receipt.profileId !== "nemoclaw-nvidia-inference-v1")
    throw new Error("Invalid native NVIDIA gateway provider authority");
  setNativeHostedProviderAuthority(gatewayName, receipt);
}

export function clearNativeNvidiaProviderAuthority(gatewayName: string): void {
  clearNativeHostedProviderAuthority(gatewayName, "nemoclaw-nvidia-inference-v1");
}

export function getNativeHostedProviderAuthority(
  gatewayName: string,
  profileId: string,
): NativeHostedProviderAttachment | undefined {
  if (!isValidName(gatewayName)) return undefined;
  return normalizeNativeHostedProviderAuthorities(
    load().gatewayNativeHostedProviderAuthorities?.[gatewayName],
  )?.find((receipt) => receipt.profileId === profileId);
}

export function setNativeHostedProviderAuthority(
  gatewayName: string,
  receipt: NativeHostedProviderAttachment,
): void {
  const normalized = normalizeNativeHostedProviderAttachment(receipt);
  if (!isValidName(gatewayName) || !normalized)
    throw new Error("Invalid native provider gateway authority");
  withLock(() => {
    const data = load();
    const previous = data.gatewayNativeHostedProviderAuthorities?.[gatewayName];
    const retained = retainNativeHostedProviderAuthority(previous, normalized);
    if (JSON.stringify(previous) === JSON.stringify(retained)) return;
    data.gatewayNativeHostedProviderAuthorities = {
      ...data.gatewayNativeHostedProviderAuthorities,
      [gatewayName]: retained,
    };
    save(data);
  });
}

export function clearNativeHostedProviderAuthority(gatewayName: string, profileId: string): void {
  if (!isValidName(gatewayName)) return;
  withLock(() => {
    const data = load();
    if (removeHostedAuthority(data, gatewayName, profileId)) save(data);
  });
}

function removeHostedAuthority(
  data: SandboxRegistry,
  gatewayName: string,
  profileId: string,
): boolean {
  let changed = false;
  const previous = data.gatewayNativeHostedProviderAuthorities?.[gatewayName];
  if (previous?.some((receipt) => receipt.profileId === profileId)) {
    const next = { ...data.gatewayNativeHostedProviderAuthorities };
    const retained = previous.filter((receipt) => receipt.profileId !== profileId);
    if (retained.length) next[gatewayName] = retained;
    else delete next[gatewayName];
    if (Object.keys(next).length) data.gatewayNativeHostedProviderAuthorities = next;
    else delete data.gatewayNativeHostedProviderAuthorities;
    changed = true;
  }
  for (const sandbox of Object.values(data.sandboxes)) {
    if (
      sandbox.gatewayName !== gatewayName ||
      !sandbox.nativeHostedProviderAuthorities?.some((receipt) => receipt.profileId === profileId)
    )
      continue;
    const retained = sandbox.nativeHostedProviderAuthorities.filter(
      (receipt) => receipt.profileId !== profileId,
    );
    if (retained.length) sandbox.nativeHostedProviderAuthorities = retained;
    else delete sandbox.nativeHostedProviderAuthorities;
    changed = true;
  }
  return changed;
}
