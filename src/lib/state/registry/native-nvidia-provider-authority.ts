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

import type { SandboxRegistry } from "./types";
import { withLock } from "./lock";
import { load, save } from "./persistence";

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
  return changed;
}

export function listNativeHostedProviderAttachmentSandboxNames(
  profileId: string,
  gatewayName?: string,
): readonly string[] {
  return Object.values(load().sandboxes)
    .filter((sandbox) => !gatewayName || sandbox.gatewayName === gatewayName)
    .filter(
      (sandbox) =>
        sandbox.nativeHostedProviderAttachment?.profileId === profileId ||
        sandbox.nativeNvidiaProviderAttachment?.profileId === profileId ||
        sandbox.pendingNativeHostedProviderDetach?.profileId === profileId,
    )
    .map((sandbox) => sandbox.name)
    .sort();
}

export function listNativeNvidiaProviderAttachmentSandboxNames(
  gatewayName?: string,
): readonly string[] {
  return listNativeHostedProviderAttachmentSandboxNames(
    "nemoclaw-nvidia-inference-v1",
    gatewayName,
  );
}
