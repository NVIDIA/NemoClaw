// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const BOUNDARY_SCRIPT = path.join(REPO_ROOT, "scripts", "check-layer-import-boundaries.ts");

describe("CLI layer import boundaries", () => {
  it("keeps domain, adapter, action, and command layers separated", () => {
    const result = spawnSync(TSX, [BOUNDARY_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });

    expect(`${result.stdout}${result.stderr}`).toContain("Layer import boundaries passed.");
    expect(result.status).toBe(0);
  });
});
