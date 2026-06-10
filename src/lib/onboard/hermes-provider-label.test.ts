// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

const { REMOTE_PROVIDER_CONFIG } = require("../../../dist/lib/onboard/providers") as {
  REMOTE_PROVIDER_CONFIG: Record<string, { label: string; providerName: string }>;
};

// The Hermes Provider is a single consolidated menu entry that serves nine
// model families through the same Nous portal endpoint and credential. The
// model picker reveals the family options after this entry is selected. The
// label names all nine families so QA scripts and operators can discover them
// without first selecting the entry; this file guards both that contract and
// the count.
describe("Hermes Provider menu contract", () => {
  it("is a single menu entry, not nine distinct provider configs", () => {
    const hermesKeys = Object.keys(REMOTE_PROVIDER_CONFIG).filter((key) =>
      key.toLowerCase().includes("hermes"),
    );
    expect(hermesKeys).toEqual(["hermesProvider"]);
    expect(REMOTE_PROVIDER_CONFIG.hermesProvider.providerName).toBe("hermes-provider");
  });

  it("names every Hermes-served model family in its menu label", () => {
    const label = REMOTE_PROVIDER_CONFIG.hermesProvider.label;
    expect(label.startsWith("Hermes Provider")).toBe(true);
    for (const family of [
      "Moonshot",
      "Z-AI",
      "MiniMax",
      "Qwen",
      "Xiaomi",
      "Tencent",
      "StepFun",
      "xAI",
      "Arcee",
    ]) {
      expect(label).toContain(family);
    }
  });
});
