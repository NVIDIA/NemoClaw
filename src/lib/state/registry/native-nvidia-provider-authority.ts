// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NativeNvidiaProviderAttachment } from "../../inference/native-nvidia";
import {
  applyNativeNvidiaProviderAuthority,
  readNativeNvidiaProviderAuthority,
  removeNativeNvidiaProviderAuthority as applyRemoveNativeNvidiaProviderAuthority,
} from "./native-nvidia-provider-authority-state";
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
    let changed = applyRemoveNativeNvidiaProviderAuthority(data, gatewayName);
    for (const [sandboxName, sandbox] of Object.entries(data.sandboxes)) {
      if (
        sandbox.gatewayName !== gatewayName ||
        sandbox.nativeNvidiaProviderAuthority === undefined
      ) {
        continue;
      }
      const { nativeNvidiaProviderAuthority: _removedAuthority, ...retained } = sandbox;
      data.sandboxes[sandboxName] = retained;
      changed = true;
    }
    if (!changed) return;
    save(data);
  });
}
