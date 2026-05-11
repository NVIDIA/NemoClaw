// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const BOUNDARY_SCRIPT = path.join(REPO_ROOT, "scripts", "checks", "layer-import-boundaries.ts");

describe("CLI layer import boundaries", () => {
  it("keeps domain, adapter, action, and command layers separated", () => {
    const result = spawnSync(TSX, [BOUNDARY_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });

    expect(`${result.stdout}${result.stderr}`).toContain("Layer import boundaries passed.");
    expect(result.status).toBe(0);
  });

  it("collects TypeScript import-equals references", () => {
    const fixture = path.join(REPO_ROOT, "src", "lib", "domain", `__boundary-import-equals-${process.pid}.ts`);
    try {
      fs.writeFileSync(
        fixture,
        'import adapter = require("../adapters/openshell/client");\nexport const value = adapter;\n',
      );
      const result = spawnSync(TSX, [BOUNDARY_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("domain must not import src/lib/adapters/openshell/client.ts");
    } finally {
      fs.rmSync(fixture, { force: true });
    }
  });

  it("counts only classes that extend Command as oclif command classes", () => {
    const fixture = path.join(REPO_ROOT, "src", "lib", "commands", `__boundary-implements-${process.pid}.ts`);
    try {
      fs.writeFileSync(
        fixture,
        'import { Command } from "@oclif/core";\nclass NotACommand implements Command {}\n',
      );
      const result = spawnSync(TSX, [BOUNDARY_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "command files must define exactly one registered oclif command class; found 0",
      );
    } finally {
      fs.rmSync(fixture, { force: true });
    }
  });
});
