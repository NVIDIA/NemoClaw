// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NativeNvidiaProviderAttachment } from "../../inference/native-nvidia";
import {
  applyNativeNvidiaProviderAuthority,
  readNativeNvidiaProviderAuthority,
  removeNativeNvidiaProviderAuthority as applyRemoveNativeNvidiaProviderAuthority,
} from "./native-provider-authority-state";
import { isDeepStrictEqual } from "node:util";
import type { NativeProviderAttachment } from "../../inference/native-provider/contract";
import { hostedNativeProvider } from "../../inference/native-provider/hosted";
import { requireHostedProviderAttachment } from "../../inference/native-provider/hosted-attachment";
import { readNativeHostedGatewayAuthorities } from "./native-provider-authority-state";
import { withLock } from "./lock";
import { load, save } from "./persistence";

export function getNativeNvidiaProviderAuthority(
  gatewayName: string,
): NativeNvidiaProviderAttachment | undefined {
  return readNativeNvidiaProviderAuthority(load(), gatewayName);
}

export function setNativeNvidiaProviderAuthority(
  gatewayName: string,
  receipt: NativeNvidiaProviderAttachment,
): void {
  withLock(() => {
    const data = load();
    const existing = readNativeNvidiaProviderAuthority(data, gatewayName);
    if (existing?.providerId === receipt.providerId) return;
    if (!applyNativeNvidiaProviderAuthority(data, gatewayName, receipt)) {
      throw new Error("Cannot record invalid native NVIDIA gateway provider authority");
    }
    save(data);
  });
}

export function clearNativeNvidiaProviderAuthority(gatewayName: string): void {
  withLock(() => {
    const data = load();
    if (!applyRemoveNativeNvidiaProviderAuthority(data, gatewayName)) return;
    save(data);
  });
}

export function listNativeNvidiaProviderAttachmentSandboxNames(
  gatewayName: string,
): readonly string[] {
  return Object.values(load().sandboxes)
    .filter(
      (sandbox) =>
        sandbox.gatewayName === gatewayName && sandbox.nativeNvidiaProviderAttachment !== undefined,
    )
    .map((sandbox) => sandbox.name)
    .sort();
}

export function getNativeHostedProviderAuthority(
  gatewayName: string,
  provider: string,
  endpointUrl?: string | null,
): NativeProviderAttachment | undefined {
  if (!hostedNativeProvider(provider)) return undefined;
  const authorities = readNativeHostedGatewayAuthorities(load(), gatewayName);
  const current = requireHostedProviderAttachment(authorities?.[provider], provider);
  if (endpointUrl === undefined) return current;
  const definition = hostedNativeProvider(provider, endpointUrl)!;
  return current?.providerName === definition.providerName
    ? current
    : requireHostedProviderAttachment(authorities?.[definition.providerName], provider);
}

export function setNativeHostedProviderAuthority(
  gatewayName: string,
  provider: string,
  receipt: NativeProviderAttachment,
): void {
  const normalized = requireHostedProviderAttachment(receipt, provider);
  if (!readNativeHostedGatewayAuthorities({}, gatewayName) || !normalized)
    throw new Error("Cannot record invalid native hosted provider authority");
  withLock(() => {
    const state = load();
    const authorities = state.nativeHostedProviderAuthorities ?? {};
    const gateway = authorities[gatewayName] ?? {};
    if (isDeepStrictEqual(gateway[provider], normalized)) return;
    state.nativeHostedProviderAuthorities = {
      ...authorities,
      [gatewayName]: {
        ...gateway,
        ...(gateway[provider] && gateway[provider].providerName !== normalized.providerName
          ? { [gateway[provider].providerName]: gateway[provider] }
          : {}),
        [provider]: normalized,
      },
    };
    save(state);
  });
}

/** Resolve a listed native name without folding it into a legacy resource. */
export function getNativeHostedProviderAuthorityByName(
  gatewayName: string,
  providerName: string,
): NativeProviderAttachment | undefined {
  return Object.values(readNativeHostedGatewayAuthorities(load(), gatewayName) ?? {}).find(
    (receipt) => receipt.providerName === providerName,
  );
}

export function clearNativeHostedProviderAuthority(
  gatewayName: string,
  expected: NativeProviderAttachment,
): void {
  withLock(() => {
    const state = load();
    const gateway = state.nativeHostedProviderAuthorities?.[gatewayName];
    if (!gateway) return;
    for (const [key, receipt] of Object.entries(gateway)) {
      if (isDeepStrictEqual(receipt, expected)) delete gateway[key];
    }
    if (Object.keys(gateway).length === 0)
      delete state.nativeHostedProviderAuthorities![gatewayName];
    save(state);
  });
}

export function listNativeHostedProviderAttachmentSandboxNames(
  gatewayName: string,
  providerName: string,
): readonly string[] {
  return Object.values(load().sandboxes)
    .filter(
      (sandbox) =>
        sandbox.gatewayName === gatewayName &&
        sandbox.nativeHostedProviderAttachment?.providerName === providerName,
    )
    .map((sandbox) => sandbox.name)
    .sort();
}
