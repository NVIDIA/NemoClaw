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

  it("loads both built port wrappers through the generated boundary", () => {
    const script =
      `const cli = await import(${JSON.stringify(url("dist/lib/core/ports.js"))});` +
      `const plugin = await import(${JSON.stringify(url("nemoclaw/dist/lib/ports.js"))});` +
      `const boundary = await import(${JSON.stringify(url("nemoclaw/dist/shared/port-boundary.cjs"))});` +
      `const errors = [];` +
      `for (const parse of [` +
      `() => cli.parsePort("NEMOCLAW_VLLM_PORT", 8000, { NEMOCLAW_VLLM_PORT: "08000" }),` +
      `() => { process.env.NEMOCLAW_DASHBOARD_PORT = "08000"; return plugin.parsePort("NEMOCLAW_DASHBOARD_PORT", 18789); },` +
      `() => boundary.parseServicePortOverride("NEMOCLAW_VLLM_PORT", "08000", 8000)` +
      `]) { try { parse(); } catch (error) { errors.push(error.message); } }` +
      `process.stdout.write(JSON.stringify(errors));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(JSON.parse(output)).toEqual([
      'Invalid port: NEMOCLAW_VLLM_PORT="08000" — must be an integer between 1024 and 65535',
      'Invalid port: NEMOCLAW_DASHBOARD_PORT="08000" — must be an integer between 1024 and 65535',
      'Invalid port: NEMOCLAW_VLLM_PORT="08000" — must be an integer between 1024 and 65535',
    ]);
  });

  it("ships the generated canonical CJS boundary and its declaration", () => {
    const sharedDir = path.join(repoRoot, "nemoclaw", "dist", "shared");
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.d.cts"))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir, "banner-boundary.js"))).toBe(false);
    expect(fs.existsSync(path.join(sharedDir, "port-boundary.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir, "port-boundary.d.cts"))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir, "port-boundary.js"))).toBe(false);
  });
});
