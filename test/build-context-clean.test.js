// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that sandbox image build context excludes developer artifacts
// like .venv from nemoclaw-blueprint/.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/774

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("build context excludes .venv (#774)", () => {
  it("onboard.js: removes .venv from staged nemoclaw-blueprint", () => {
    const content = fs.readFileSync(path.join(ROOT, "bin/lib/onboard.js"), "utf-8");
    expect(content).toContain('nemoclaw-blueprint/.venv"');
  });

  it("setup.sh: removes .venv from staged nemoclaw-blueprint", () => {
    const content = fs.readFileSync(path.join(ROOT, "scripts/setup.sh"), "utf-8");
    expect(content).toContain("nemoclaw-blueprint/.venv");
  });

  it("nemoclaw.js: rsync excludes .venv", () => {
    const content = fs.readFileSync(path.join(ROOT, "bin/nemoclaw.js"), "utf-8");
    expect(content).toContain("--exclude .venv");
  });

  it(".dockerignore: includes .venv", () => {
    const content = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf-8");
    expect(content).toContain(".venv");
  });
});
