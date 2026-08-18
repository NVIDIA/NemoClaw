// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BUILT_IN_CHANNEL_MANIFESTS } from "./channels/built-ins";
import { BUILT_IN_MESSAGING_HOOK_REGISTRY } from "./hooks/builtins";
import type { MessagingManagedStartupPlaceholderAuthorization } from "./hooks/types";
import type { ChannelManifest } from "./manifest";

export function authorizeMessagingManagedStartupPlaceholders(
  step: unknown,
): readonly MessagingManagedStartupPlaceholderAuthorization[] {
  if (!isPlainDataObject(step)) return [];
  const channelId = ownDataPropertyValue(step, "channelId");
  const hookId = ownDataPropertyValue(step, "hookId");
  const handlerId = ownDataPropertyValue(step, "handler");
  const outputId = ownDataPropertyValue(step, "outputId");
  const kind = ownDataPropertyValue(step, "kind");
  const required = ownDataPropertyValue(step, "required");

  const manifests: readonly ChannelManifest[] = BUILT_IN_CHANNEL_MANIFESTS;
  const manifest = manifests.find((entry) => entry.id === channelId);
  const hook = manifest?.hooks.find((entry) => entry.id === hookId && entry.handler === handlerId);
  const output = hook?.outputs?.find((entry) => entry.id === outputId);
  if (
    !hook ||
    !output ||
    output.kind !== kind ||
    (output.required === true) !== required ||
    (kind !== "build-arg" && kind !== "build-file" && kind !== "package-install")
  ) {
    return [];
  }

  return BUILT_IN_MESSAGING_HOOK_REGISTRY.authorizeManagedStartupPlaceholders(
    hook.handler,
    output.id,
    ownDataPropertyValue(step, "value"),
  ).map((authorization) => ({
    ...authorization,
    path: ["value", ...authorization.path],
  }));
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownDataPropertyValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
