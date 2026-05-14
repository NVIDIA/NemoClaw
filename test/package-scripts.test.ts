// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
  scripts?: Record<string, string>;
};

describe("package scripts", () => {
  it("keeps dev dependencies installed after prepare so CLI typechecking works on macOS", () => {
    expect(packageJson.scripts?.prepare).toBeDefined();
    expect(packageJson.scripts?.prepare).not.toMatch(/--omit=dev|--production/);
    expect(packageJson.scripts?.["typecheck:cli"]).toBe("tsc -p tsconfig.cli.json");
  });
});
