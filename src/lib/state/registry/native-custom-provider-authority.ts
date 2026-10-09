// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeCustomProviderAttachment,
  type NativeCustomProviderAttachment,
} from "../../inference/native-custom";
import { isValidName, isValidProviderName } from "../../name-validation";
import { withLock } from "./lock";
import { load, save } from "./persistence";

export function listNativeCustomProviderAuthorities(
  gatewayName: string,
  sandboxName?: string,
): NativeCustomProviderAttachment[] {
  if (!isValidName(gatewayName) || (sandboxName !== undefined && !isValidName(sandboxName)))
    throw new Error("Invalid native custom provider authority scope");
  return Object.values(load().nativeCustomProviderAuthorities?.[gatewayName] ?? {})
    .map((value) => normalizeNativeCustomProviderAttachment(value, sandboxName))
    .filter((value): value is NativeCustomProviderAttachment => value !== undefined);
}

export function getNativeCustomProviderAuthority(
  gatewayName: string,
  providerName: string,
): NativeCustomProviderAttachment | undefined {
  if (!isValidName(gatewayName) || !isValidProviderName(providerName)) return undefined;
  return normalizeNativeCustomProviderAttachment(
    load().nativeCustomProviderAuthorities?.[gatewayName]?.[providerName],
  );
}

export function setNativeCustomProviderAuthority(
  gatewayName: string,
  value: NativeCustomProviderAttachment,
): void {
  const receipt = normalizeNativeCustomProviderAttachment(value);
  if (!isValidName(gatewayName) || !receipt)
    throw new Error("Cannot record invalid native custom provider authority");
  withLock(() => {
    const data = load();
    data.nativeCustomProviderAuthorities = {
      ...data.nativeCustomProviderAuthorities,
      [gatewayName]: {
        ...data.nativeCustomProviderAuthorities?.[gatewayName],
        [receipt.providerName]: receipt,
      },
    };
    save(data);
  });
}

export function clearNativeCustomProviderAuthority(
  gatewayName: string,
  expected: NativeCustomProviderAttachment,
): void {
  withLock(() => {
    const data = load();
    const current = data.nativeCustomProviderAuthorities?.[gatewayName]?.[expected.providerName];
    if (!current || current.providerId !== expected.providerId) return;
    delete data.nativeCustomProviderAuthorities![gatewayName][expected.providerName];
    if (!Object.keys(data.nativeCustomProviderAuthorities![gatewayName]).length)
      delete data.nativeCustomProviderAuthorities![gatewayName];
    if (!Object.keys(data.nativeCustomProviderAuthorities!).length)
      delete data.nativeCustomProviderAuthorities;
    save(data);
  });
}
