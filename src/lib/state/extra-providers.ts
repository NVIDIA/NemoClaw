// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const EXTRA_PROVIDER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;

export interface ExtraProvidersState {
  extraProviders?: string[];
}

export function isValidExtraProviderName(name: string): boolean {
  return EXTRA_PROVIDER_NAME_PATTERN.test(name);
}

export function normalizeExtraProviders(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const cleaned = input.filter(
    (value): value is string =>
      typeof value === "string" && EXTRA_PROVIDER_NAME_PATTERN.test(value),
  );
  const deduped = [...new Set(cleaned)].sort();
  return deduped.length > 0 ? deduped : undefined;
}

export function readExtraProviders(data: ExtraProvidersState): string[] {
  return [...(data.extraProviders ?? [])];
}

export function applyAddExtraProvider(name: string, data: ExtraProvidersState): boolean {
  if (!isValidExtraProviderName(name)) return false;
  const existing = new Set(data.extraProviders ?? []);
  if (existing.has(name)) return false;
  existing.add(name);
  data.extraProviders = [...existing].sort();
  return true;
}

export function applyRemoveExtraProvider(name: string, data: ExtraProvidersState): boolean {
  const existing = new Set(data.extraProviders ?? []);
  if (!existing.delete(name)) return false;
  const sorted = [...existing].sort();
  if (sorted.length > 0) data.extraProviders = sorted;
  else delete data.extraProviders;
  return true;
}
