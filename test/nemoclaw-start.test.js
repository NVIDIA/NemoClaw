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
});

describe("config integrity check", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("exits on integrity failure in non-root mode", () => {
    // Extract the outer non-root block.  The trailing \nfi\n targets the
    // closing "fi" at column 0 — inner "fi" lines are indented (e.g. "  fi")
    // so [\s\S]*? stops at the first unindented fi, selecting only the outer
    // block.  This relies on consistent indentation in nemoclaw-start.sh.
    const nonRootMatch = src.match(
      /if \[ "\$\(id -u\)" -ne 0 \]; then\n([\s\S]*?)\nfi\n/
    );
    expect(nonRootMatch).not.toBeNull();
    const nonRootBlock = nonRootMatch[1];

    // The block must NOT contain "proceeding anyway" — that was the old bypass
    expect(nonRootBlock).not.toMatch(/proceeding anyway/i);

    // The block must exit on integrity failure
    expect(nonRootBlock).toMatch(/verify_config_integrity/);
    expect(nonRootBlock).toMatch(/exit 1/);
  });

  it("does not bypass verify_config_integrity in any code path", () => {
    // No line should catch and ignore a verify_config_integrity failure
    expect(src).not.toMatch(/verify_config_integrity[\s\S]*?proceeding anyway/);
  });
});
