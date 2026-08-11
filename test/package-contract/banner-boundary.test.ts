// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const url = (...segments: string[]) => pathToFileURL(path.join(repoRoot, ...segments)).href;

describe("banner boundary package contract", () => {
  it("resolves both built package wrappers to the one generated boundary function", () => {
    // Native subprocess: only native resolution bypasses the Vitest source alias
    // (which maps *banner-boundary.cjs to .cts) to compare the real shipped dist.
    const script =
      `const cli = await import(${JSON.stringify(url("dist/lib/cli/banner.js"))});` +
      `const plugin = await import(${JSON.stringify(url("nemoclaw/dist/banner.js"))});` +
      `const b = await import(${JSON.stringify(url("nemoclaw/dist/shared/banner-boundary.cjs"))});` +
      `const cliRenderBox = cli.renderBox ?? cli.default.renderBox;` +
      `process.stdout.write(JSON.stringify([cliRenderBox === b.renderBox, plugin.renderBox === b.renderBox, cliRenderBox(["abcdef"], { columns: 5 })]));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(JSON.parse(output)).toEqual([true, true, ["  ┌─┐", "  │ │", "  └─┘"]]);
  });

  it("ships the generated canonical CJS boundary and its declaration", () => {
    const sharedDir = path.join(repoRoot, "nemoclaw", "dist", "shared");
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.d.cts"))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.js"))).toBe(false);
  });
});
