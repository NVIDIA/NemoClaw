// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { createPackageFixture } from "./helpers/package-fixture";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");

describe("compiled config schema consumer", () => {
  it("packs the config schema where the compiled validator resolves it (#10938)", () => {
    const fixtureRoot = createPackageFixture({
      prefix: "nemoclaw-config-schema-pack-",
      entries: [
        "dist/lib/config",
        "dist/lib/core/endpoint-contract.js",
        "dist/lib/core/immutable.js",
        "dist/lib/name-validation.js",
        "dist/lib/sandbox-name-contract.js",
        "dist/lib/policy/sandbox-policy-validation.js",
        "dist/lib/adapters/openshell/policy-boundary.js",
        "dist/lib/security/credential-filter.js",
        "nemoclaw/dist/shared",
        "schemas",
      ],
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
          `const fs = require("node:fs");
const model = require("./dist/lib/config/model.js");
const schema = require("./dist/lib/config/schema.js");
const artifact = JSON.parse(fs.readFileSync("./schemas/nemoclaw-config-v1.schema.json", "utf8"));
if (model.NemoClawConfigSchema.$id !== artifact.$id) process.exit(3);
if (JSON.stringify(model.NemoClawConfigSchema) !== JSON.stringify(artifact)) process.exit(4);
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

      mkdirSync(path.join(fixtureRoot, "node_modules"));
      cpSync(
        path.join(REPOSITORY_ROOT, "node_modules", "typebox"),
        path.join(fixtureRoot, "node_modules", "typebox"),
        { recursive: true },
      );
      const consumer = path.join(fixtureRoot, "consumer.ts");
      writeFileSync(
        consumer,
        `import { NemoClawConfigSchema, type NemoClawConfig } from "./dist/lib/config/model.js";
declare const config: NemoClawConfig;
const apiVersion: "nemoclaw.nvidia.com/v1" = config.apiVersion;
// @ts-expect-error The emitted config type must not degrade to any.
const invalidApiVersion: "invalid" = config.apiVersion;
void apiVersion;
void invalidApiVersion;
void NemoClawConfigSchema;
`,
      );
      const declarationProbe = spawnSync(
        path.join(REPOSITORY_ROOT, "node_modules", ".bin", "tsc"),
        [
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "ES2022",
          "--module",
          "Node16",
          "--moduleResolution",
          "Node16",
          consumer,
        ],
        { cwd: fixtureRoot, encoding: "utf8" },
      );
      expect(
        declarationProbe.status,
        `TypeScript consumer declaration check failed:\n${declarationProbe.stdout}${declarationProbe.stderr}`,
      ).toBe(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
