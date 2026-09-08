// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MCP_DENIED_TOOL_SELECTOR_MAX_COUNT = 500;
const MCP_DENIED_TOOL_SELECTOR_RE = /^[A-Za-z0-9_.?*{}\[\]-]{1,128}$/u;

export type McpDeniedToolSelectorInspection =
  | {
      ok: true;
      canonical: boolean;
      duplicate: boolean;
      selectors: string[];
    }
  | {
      ok: false;
      reason: "invalid-selector" | "not-array" | "too-many";
      invalidSelector?: unknown;
    };

export function inspectMcpDeniedToolSelectors(value: unknown): McpDeniedToolSelectorInspection {
  if (!Array.isArray(value)) return { ok: false, reason: "not-array" };
  if (value.length > MCP_DENIED_TOOL_SELECTOR_MAX_COUNT) {
    return { ok: false, reason: "too-many" };
  }
  const invalidIndex = value.findIndex(
    (selector) => typeof selector !== "string" || !MCP_DENIED_TOOL_SELECTOR_RE.test(selector),
  );
  if (invalidIndex >= 0) {
    return { ok: false, reason: "invalid-selector", invalidSelector: value[invalidIndex] };
  }
  const selectors = [...new Set(value as string[])].sort();
  const duplicate = selectors.length !== value.length;
  return {
    ok: true,
    canonical:
      !duplicate && selectors.every((selector, index) => selector === (value as string[])[index]),
    duplicate,
    selectors,
  };
}
