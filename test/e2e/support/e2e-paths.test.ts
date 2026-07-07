// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLI_DIST_ENTRYPOINT,
  CLI_ENTRYPOINT,
  E2E_ROOT,
  LIVE_E2E_ROOT,
  REPO_ROOT,
} from "../fixtures/paths.ts";

const LOCAL_PATH_DECLARATION =
  /^(?:export\s+)?const\s+(?:REPO_ROOT|CLI_ENTRYPOINT|CLI_DIST_ENTRYPOINT)\s*=/m;
const LOCAL_CLI_ENTRYPOINT_DERIVATION =
  /path\.join\(\s*REPO_ROOT\s*,\s*["'](?:bin|dist)["']\s*,\s*["']nemoclaw\.js["']\s*\)/;

function typescriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory()
      ? typescriptFiles(target)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [target]
        : [];
  });
}

describe("E2E repository paths", () => {
  it("resolves the canonical E2E and CLI locations from the repository root", () => {
    const expectedRoot = path.resolve(import.meta.dirname, "../../..");

    expect(REPO_ROOT).toBe(expectedRoot);
    expect(E2E_ROOT).toBe(path.join(expectedRoot, "test", "e2e"));
    expect(LIVE_E2E_ROOT).toBe(path.join(E2E_ROOT, "live"));
    expect(CLI_ENTRYPOINT).toBe(path.join(expectedRoot, "bin", "nemoclaw.js"));
    expect(CLI_DIST_ENTRYPOINT).toBe(path.join(expectedRoot, "dist", "nemoclaw.js"));
    expect(fs.existsSync(CLI_ENTRYPOINT)).toBe(true);
  });

  it("keeps live targets on the canonical path exports", () => {
    const violations = typescriptFiles(LIVE_E2E_ROOT)
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return LOCAL_PATH_DECLARATION.test(source) || LOCAL_CLI_ENTRYPOINT_DERIVATION.test(source);
      })
      .map((file) => path.relative(LIVE_E2E_ROOT, file));

    expect(violations).toEqual([]);
  });
});
