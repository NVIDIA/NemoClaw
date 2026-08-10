// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

const scopedCredentialOverrides = new AsyncLocalStorage<ReadonlyMap<string, string>>();

/** Make normalized credential overrides available to one asynchronous call tree. */
export async function withCredentialOverrides<T>(
  values: Readonly<Record<string, string>>,
  operation: () => Promise<T> | T,
): Promise<T> {
  const inherited = scopedCredentialOverrides.getStore();
  const overrides = new Map(inherited ?? []);
  for (const [key, rawValue] of Object.entries(values)) {
    const value = rawValue.replace(/\r/g, "").trim();
    if (!value) throw new Error(`Scoped credential '${key}' must not be empty.`);
    overrides.set(key, value);
  }
  return scopedCredentialOverrides.run(overrides, operation);
}

export function getScopedCredentialOverride(key: string): string | null {
  return scopedCredentialOverrides.getStore()?.get(key) ?? null;
}
