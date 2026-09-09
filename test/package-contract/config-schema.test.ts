// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { createPackageFixture } from "./helpers/package-fixture";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");

describe("compiled config schema consumer", () => {
  it("packs the config schema where the compiled validator resolves it (#10938)", () => {
    const fixtureRoot = createPackageFixture({
      prefix: "nemoclaw-config-schema-pack-",
      entries: ["dist/lib/config", "schemas"],
    });
    try {
      const report = JSON.parse(
        execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
          cwd: fixtureRoot,
          encoding: "utf8",
        }),
      ) as Array<{ files: Array<{ path: string }> }>;
      const files = report[0]?.files.map((file) => file.path) ?? [];
      expect(files).toEqual(
        expect.arrayContaining([
          "schemas/nemoclaw-config-v1.schema.json",
          "schemas/network-policy.schema.json",
          "schemas/sandbox-policy.schema.json",
        ]),
      );

      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          `const schema = require("./dist/lib/config/schema.js");
try {
  schema.validateNemoClawConfig({});
} catch (error) {
  if (error && error.name === "NemoClawConfigValidationError") {
    process.stdout.write("schema-loaded");
    process.exit(0);
  }
  throw error;
}
process.exit(2);`,
        ],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: { ...process.env, NODE_PATH: path.join(REPOSITORY_ROOT, "node_modules") },
        },
      );
      expect(probe.status, `${probe.stdout}${probe.stderr}`).toBe(0);
      expect(probe.stdout).toBe("schema-loaded");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
