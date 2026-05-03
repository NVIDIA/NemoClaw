// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that scripts/install.sh stays portable across the bash versions we
// actually run on. macOS ships /bin/bash 3.2 (the last GPLv2 release), and
// the curl-pipe install path executes through that interpreter, so any
// bash 4+-only construct in install.sh is a hard install failure on macOS.
//
// Concrete failure mode this guards against:
//
//   /tmp/.../scripts/install.sh: line NNNN: ${_resume_answer,,}: bad substitution
//
// reported by a user who ran the documented one-liner installer on macOS
// and could not get past the "previous onboarding session failed" prompt.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const INSTALL_SH = path.join(ROOT, "scripts", "install.sh");

describe("scripts/install.sh: bash 3.2 portability", () => {
  const source = fs.readFileSync(INSTALL_SH, "utf-8");

  it("does not use bash 4 lowercase expansion (the comma-comma form)", () => {
    // Match ${NAME,,} or ${NAME,} (case-modification expansions added in
    // bash 4.0 — not available on macOS /bin/bash). Examples are constructed
    // dynamically so this test file does not contain literals that would
    // match its own regex.
    const dollar = "$";
    const ex2 = `${dollar}{var,,}`;
    const ex1 = `${dollar}{var,}`;
    expect(`echo ${ex2}`).toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*,,?\}/);
    expect(`echo ${ex1}`).toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*,,?\}/);

    const matches = source.match(/\$\{[A-Za-z_][A-Za-z0-9_]*,,?\}/g) ?? [];
    expect(matches).toEqual([]);
  });

  it("does not use bash 4 uppercase expansion (the caret-caret form)", () => {
    const matches = source.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?\}/g) ?? [];
    expect(matches).toEqual([]);
  });

  it("does not use bash 4 mapfile/readarray builtins", () => {
    expect(source).not.toMatch(/^\s*(mapfile|readarray)\b/m);
  });

  it("does not declare associative arrays (declare -A / local -A)", () => {
    // Associative arrays are bash 4+. Indexed arrays (declare -a) are fine.
    expect(source).not.toMatch(/\b(declare|local)\s+-A\b/);
  });
});
