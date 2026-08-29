// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");

describe("removed replaceConfigFile patch QA guidance", () => {
  it("keeps the retired rcf_patch.py out of the repo and blueprint", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "rcf_patch.py"))).toBe(false);
    expect(
      fs.existsSync(path.join(REPO_ROOT, "nemoclaw-blueprint", "scripts", "rcf_patch.py")),
    ).toBe(false);
  });
});
