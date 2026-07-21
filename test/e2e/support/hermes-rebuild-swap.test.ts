// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HERMES_REBUILD_SWAP_BYTES,
  needsHermesRebuildSwap,
  parseActiveSwapBytes,
} from "../fixtures/hermes-rebuild-swap.ts";

describe("Hermes rebuild swap", () => {
  it("adds active swap sizes reported by swapon", () => {
    expect(parseActiveSwapBytes("17179869184\n17179869184\n")).toBe(HERMES_REBUILD_SWAP_BYTES);
  });

  it("adds active swap sizes from GitHub Actions runner rows", () => {
    const output = [
      "/swapfile file 3221221376 0 -2",
      "/mnt/nemoclaw-hermes-rebuild.swap file 34359734272 0 -3",
    ].join("\n");

    expect(parseActiveSwapBytes(output)).toBe(37_580_955_648);
  });

  it("ignores unrelated five-field output", () => {
    const activeSwapBytes = parseActiveSwapBytes("notice ignored 34359738368 text text");

    expect(activeSwapBytes).toBe(0);
    expect(needsHermesRebuildSwap({ activeSwapBytes, githubActions: true })).toBe(true);
  });

  it("provisions swap only on GitHub Actions runners below the rebuild floor", () => {
    expect(needsHermesRebuildSwap({ activeSwapBytes: 0, githubActions: true })).toBe(true);
    expect(
      needsHermesRebuildSwap({
        activeSwapBytes: HERMES_REBUILD_SWAP_BYTES,
        githubActions: true,
      }),
    ).toBe(false);
    expect(needsHermesRebuildSwap({ activeSwapBytes: 0, githubActions: false })).toBe(false);
  });

  it("checks the fallback before the live Docker fixture starts", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../live/rebuild-hermes.test.ts"),
      "utf8",
    );
    const ensureSwap = source.indexOf("await ensureHermesRebuildSwap(host);");
    const dockerProbe = source.indexOf('host.command("docker", ["info"]');

    expect(ensureSwap).toBeGreaterThan(-1);
    expect(dockerProbe).toBeGreaterThan(ensureSwap);
  });
});
