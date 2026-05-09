// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, "..", "bin", "nemoclaw.js");

describe("nemoclaw update command", () => {
  it("appears in root help as an Upgrade command", () => {
    const output = execSync(`node "${CLI}" help`, { encoding: "utf-8" });
    expect(output).toContain("Upgrade");
    expect(output).toMatch(/nemoclaw update\s+Run the maintained NemoClaw installer update flow\s+\(--check, --yes\|-y\)/);
  });

  it("prints oclif help for update-specific flags", () => {
    const output = execSync(`node "${CLI}" update --help`, { encoding: "utf-8" });
    expect(output).toContain("update [--check] [--yes|-y]");
    expect(output).toContain("--check");
    expect(output).toContain("--yes");
  });
});
