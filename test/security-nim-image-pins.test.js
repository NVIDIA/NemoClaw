// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const nimImages = require("../bin/lib/nim-images.json");

describe("NIM container image digest pinning", () => {
  // TODO: remove this allowlist once NGC license acceptance is done for these images
  const PENDING_LICENSE_ACCEPTANCE = new Set([
    "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
    "nvcr.io/nim/meta/llama-3.1-8b-instruct:latest",
  ]);

  it("every NIM model image includes a @sha256: digest pin", () => {
    const unpinned = nimImages.models
      .filter((m) => !/@sha256:[a-f0-9]{64}/.test(m.image))
      .filter((m) => !PENDING_LICENSE_ACCEPTANCE.has(m.image));

    expect(
      unpinned,
      `Unpinned NIM images found:\n${unpinned.map((m) => `  ${m.image}`).join("\n")}\n\n` +
        "Run: scripts/update-nim-pins.sh",
    ).toEqual([]);
  });

  it("tracks images pending license acceptance", () => {
    const stillPending = nimImages.models.filter((m) => PENDING_LICENSE_ACCEPTANCE.has(m.image));
    if (stillPending.length === 0) {
      throw new Error(
        "All pending images are now pinned — remove PENDING_LICENSE_ACCEPTANCE allowlist",
      );
    }
  });

  it("all images reference nvcr.io", () => {
    for (const m of nimImages.models) {
      expect(m.image).toMatch(/^nvcr\.io\//);
    }
  });
});
