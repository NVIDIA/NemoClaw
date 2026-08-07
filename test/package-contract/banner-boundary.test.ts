// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");

type BannerModule = {
  renderBox: (
    lines: Array<string | null>,
    options?: { columns?: number; minInner?: number },
  ) => string[];
};

// Import the built wrappers by file URL. The compiled CommonJS CLI wrapper
// resolves its own `require("nemoclaw/dist/shared/banner-boundary.cjs")`, so
// this loads the real generated boundary — if that artifact is missing or stale
// the import throws. The source-mode banner tests alias the boundary to its
// .cts source and cannot catch that.
async function importBuilt(...segments: string[]): Promise<BannerModule> {
  return (await import(pathToFileURL(path.join(repoRoot, ...segments)).href)) as BannerModule;
}

describe("banner boundary package contract", () => {
  it("renders through the generated boundary from both built package wrappers", async () => {
    const cli = await importBuilt("dist", "lib", "cli", "banner.js");
    const plugin = await importBuilt("nemoclaw", "dist", "banner.js");

    // The built CLI wrapper renders through the real compiled boundary. This
    // exact output matches the narrow-terminal case in the source banner tests.
    expect(cli.renderBox(["abcdef"], { columns: 5 })).toEqual(["  ┌─┐", "  │ │", "  └─┘"]);

    // Both built wrappers render identically, so the two packages cannot drift.
    const lines = [
      "  Endpoint:  https://integrate.api.nvidia.com/v1",
      null,
      "  Slash:     /nemoclaw",
    ];
    expect(cli.renderBox(lines, { columns: 100 })).toEqual(
      plugin.renderBox(lines, { columns: 100 }),
    );
  });

  it("ships the generated canonical CJS boundary and its declaration", () => {
    const sharedDir = path.join(repoRoot, "nemoclaw", "dist", "shared");
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.d.cts"))).toBe(true);
    // The boundary is emitted as .cjs, never a plain .js, so ESM and CommonJS
    // consumers resolve the one CommonJS artifact.
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.js"))).toBe(false);
  });
});
