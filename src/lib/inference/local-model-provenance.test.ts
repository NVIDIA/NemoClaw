// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { resolveNonInteractiveOllamaModel } from "./local";

describe("local model selection provenance", () => {
  it.each(["requested", "recovered"] as const)(
    "records a catalog source when replacing an oversize %s model",
    (source) => {
      const onModelSelectionSource = vi.fn();
      const model = resolveNonInteractiveOllamaModel(
        source === "requested" ? "qwen3.6:35b" : null,
        source === "recovered" ? "qwen3.6:35b" : null,
        { type: "nvidia", totalMemoryMB: 131_072, availableMemoryMB: 12_000 },
        vi.fn<(message: string) => void>(),
        undefined,
        onModelSelectionSource,
      );
      expect(model).toBe("qwen3.5:9b");
      expect(onModelSelectionSource).toHaveBeenCalledExactlyOnceWith("product_catalog");
    },
  );

  it.each([
    ["direct input", "qwen3.5:9b", null, [], "custom"],
    ["legacy recovery", null, "qwen3.5:9b", [], "unknown"],
    ["inventory", null, null, ["qwen3.5:9b"], "local"],
    ["fresh catalog", null, null, [], "product_catalog"],
  ] as const)(
    "keeps the source of %s distinct",
    (_condition, requested, recovered, inventory, expectedSource) => {
      const onModelSelectionSource = vi.fn();
      resolveNonInteractiveOllamaModel(
        requested,
        recovered,
        { type: "nvidia", totalMemoryMB: 131_072, availableMemoryMB: 131_072 },
        [...inventory],
        undefined,
        onModelSelectionSource,
      );
      expect(onModelSelectionSource).toHaveBeenCalledExactlyOnceWith(expectedSource);
    },
  );
});
