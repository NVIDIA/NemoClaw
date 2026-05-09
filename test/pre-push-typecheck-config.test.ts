// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const PRE_COMMIT_CONFIG = path.join(REPO_ROOT, ".pre-commit-config.yaml");

function hookBlock(id: string): string {
  const config = fs.readFileSync(PRE_COMMIT_CONFIG, "utf-8");
  const start = config.indexOf(`      - id: ${id}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextHook = config.indexOf("\n      - id: ", start + 1);
  return config.slice(start, nextHook === -1 ? undefined : nextHook);
}

describe("pre-push TypeScript checks", () => {
  it("runs CLI typecheck for src and test TypeScript changes", () => {
    const block = hookBlock("tsc-cli");

    expect(block).toContain("entry: npx tsc -p tsconfig.cli.json");
    expect(block).toContain("stages: [pre-push]");
    expect(block).toContain("always_run: true");
    expect(block).toContain(
      String.raw`files: ^(bin|scripts|src|test|nemoclaw-blueprint/scripts)/.*\.(ts|tsx)$|^tsconfig\.cli\.json$`,
    );
    expect(block).not.toContain("types_or:");
  });
});
