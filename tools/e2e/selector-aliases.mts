// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const E2E_SELECTOR_ALIASES = Object.freeze({
  "hermes-dashboard": "hermes-e2e",
} as const);

export function normalizeE2eSelectorId(selector: string): string {
  return Object.hasOwn(E2E_SELECTOR_ALIASES, selector)
    ? E2E_SELECTOR_ALIASES[selector as keyof typeof E2E_SELECTOR_ALIASES]
    : selector;
}

export function normalizeE2eSelectorIds(selectors: readonly string[]): string[] {
  return [
    ...new Set(
      selectors.map((selector) => normalizeE2eSelectorId(selector.trim())).filter(Boolean),
    ),
  ];
}

export function normalizeE2eSelectorCsv(selectors: string): string {
  return normalizeE2eSelectorIds(selectors.split(",")).join(",");
}

export function selectorsForCanonicalE2eId(canonicalSelector: string): string[] {
  return [
    canonicalSelector,
    ...Object.entries(E2E_SELECTOR_ALIASES)
      .filter(([, canonical]) => canonical === canonicalSelector)
      .map(([legacy]) => legacy),
  ];
}
