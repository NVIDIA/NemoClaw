// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ROOT, SCRIPTS } from "../../dist/lib/paths";

describe("paths", () => {
  it("resolves the repo root", () => {
    expect(existsSync(join(ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(ROOT, "bin", "nemoclaw.js"))).toBe(true);
  });

  it("resolves the scripts directory from the repo root", () => {
    expect(SCRIPTS).toBe(join(ROOT, "scripts"));
    expect(existsSync(join(SCRIPTS, "debug.sh"))).toBe(true);
  });
});
