// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createPackageFixture } from "./helpers/package-fixture";

const repoRoot = path.join(import.meta.dirname, "..", "..");

describe("managed image registry transport package contract", () => {
  it("loads from the packed CLI after an omit-dev install (#7744)", { timeout: 240_000 }, () => {
    const compiledTransport = path.join(
      repoRoot,
      "dist",
      "lib",
      "onboard",
      "managed-image",
      "registry-fetch.js",
    );
    expect(
      fs.existsSync(compiledTransport),
      "Run `npm run build:cli` before the package-contract project.",
    ).toBe(true);

    const productionTree = spawnSync("npm", ["ls", "undici", "--omit=dev", "--all", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(productionTree.status, `${productionTree.stdout}${productionTree.stderr}`).toBe(0);
    const productionDependencies = JSON.parse(productionTree.stdout) as {
      dependencies?: { undici?: { version?: string } };
    };
    expect(productionDependencies.dependencies?.undici?.version).toBe("8.10.0");

    const fixtureRoot = createPackageFixture({
      prefix: "nemoclaw-managed-registry-pack-",
      entries: ["dist"],
    });
    const archiveRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-managed-registry-archive-"),
    );
    const consumerRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-managed-registry-consumer-"),
    );
    try {
      const packed = spawnSync(
        "npm",
        ["pack", "--ignore-scripts", "--silent", "--pack-destination", archiveRoot],
        { cwd: fixtureRoot, encoding: "utf8", timeout: 120_000 },
      );
      expect(packed.status, `${packed.stdout}${packed.stderr}`).toBe(0);
      const archives = fs.readdirSync(archiveRoot).filter((entry) => entry.endsWith(".tgz"));
      expect(archives).toHaveLength(1);

      fs.writeFileSync(
        path.join(consumerRoot, "package.json"),
        `${JSON.stringify({ name: "managed-image-registry-consumer", private: true })}\n`,
      );
      const installed = spawnSync(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--no-save",
          "--prefer-offline",
          path.join(archiveRoot, archives[0]!),
        ],
        {
          cwd: consumerRoot,
          encoding: "utf8",
          timeout: 120_000,
          env: { ...process.env, npm_config_update_notifier: "false" },
        },
      );
      expect(installed.status, `${installed.stdout}${installed.stderr}`).toBe(0);

      const installedProductionTree = spawnSync(
        "npm",
        ["ls", "undici", "--omit=dev", "--all", "--json"],
        { cwd: consumerRoot, encoding: "utf8" },
      );
      expect(
        installedProductionTree.status,
        `${installedProductionTree.stdout}${installedProductionTree.stderr}`,
      ).toBe(0);
      const installedProductionDependencies = JSON.parse(installedProductionTree.stdout) as {
        dependencies?: { undici?: { version?: string } };
      };
      expect(installedProductionDependencies.dependencies?.undici?.version).toBe("8.10.0");

      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          `
const transport = require("./dist/lib/onboard/managed-image/registry-fetch.js");
const session = transport.createManagedImageRegistryFetchSession({
  environment: { NEMOCLAW_CORPORATE_CA_IMPORT: "0" },
});
session.close().then(
  () => process.stdout.write("constructed"),
  (error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  },
);
`,
        ],
        {
          cwd: path.join(consumerRoot, "node_modules", "nemoclaw"),
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(probe.status, `${probe.stdout}${probe.stderr}`).toBe(0);
      expect(probe.stdout).toBe("constructed");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fs.rmSync(archiveRoot, { recursive: true, force: true });
      fs.rmSync(consumerRoot, { recursive: true, force: true });
    }
  });
});
