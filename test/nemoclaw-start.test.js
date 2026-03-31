// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("nemoclaw-start non-root fallback", () => {
  it("detaches gateway output from sandbox create in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toMatch(/if \[ "\$\(id -u\)" -ne 0 \]; then/);
    expect(src).toMatch(/touch \/tmp\/gateway\.log/);
    expect(src).toMatch(/nohup "\$OPENCLAW" gateway run >\/tmp\/gateway\.log 2>&1 &/);
  });

  it("exits on config integrity failure in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    // Non-root block must call verify_config_integrity and exit 1 on failure
    expect(src).toMatch(
      /if ! verify_config_integrity; then\s+.*exit 1/s,
    );
    // Must not contain the old "proceeding anyway" fallback
    expect(src).not.toMatch(/proceeding anyway/i);
  });

  it("calls verify_config_integrity in both root and non-root paths", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    // The function must be called at least twice: once in the non-root
    // if-block and once in the root path below it.
    const calls = src.match(/verify_config_integrity/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
  });

  it("sends startup diagnostics to stderr so they do not leak into bridge output (#1064)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toContain("echo 'Setting up NemoClaw...' >&2");

    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)^fi$/m);
    expect(nonRootBlock).toBeTruthy();
    const block = nonRootBlock[1];

    const echoLines = block.match(/^\s*echo\s+.+$/gm) || [];
    expect(echoLines.length).toBeGreaterThan(0);
    for (const line of echoLines) {
      expect(line).toContain(">&2");
    }

    const dashboardFn = src.match(/print_dashboard_urls\(\) \{([\s\S]*?)^\}/m);
    expect(dashboardFn).toBeTruthy();
    const dashboardBody = dashboardFn[1];
    const dashboardEchoes = dashboardBody.match(/^\s*echo\s+.+$/gm) || [];
    expect(dashboardEchoes.length).toBeGreaterThan(0);
    for (const line of dashboardEchoes) {
      expect(line).toContain(">&2");
    }
  });
});
