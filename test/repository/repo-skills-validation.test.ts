// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const VALIDATOR = path.join(
  REPO_ROOT,
  "test/e2e/e2e-cloud-experimental/features/skill/lib/validate_repo_skills.sh",
);

it("validates every repository skill with the deterministic shell contract", () => {
  const result = spawnSync("bash", [VALIDATOR, "--repo", REPO_ROOT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(/validate_repo_skills: \d+ skill\(s\) OK/u);
});
