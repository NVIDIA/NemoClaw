// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXED_HONO_NODE_SERVER_VERSION,
  prepareHistoricalMcporterInstall,
  restoreHistoricalMcporterInstall,
  verifyHistoricalMcporterInstall,
} from "../scripts/mcporter-hono-security-revision.mts";

const tempDirectories: string[] = [];

function writeJson(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(): { backupDirectory: string; packageRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcporter-hono-"));
  tempDirectories.push(root);
  const packageRoot = path.join(root, "mcporter-runtime");
  const backupDirectory = path.join(root, "backup");
  fs.mkdirSync(backupDirectory);
  writeJson(path.join(packageRoot, "package.json"), {
    name: "nemoclaw-mcporter-runtime",
    version: "0.0.0",
    dependencies: { mcporter: "0.7.3" },
  });
  writeJson(path.join(packageRoot, "package-lock.json"), {
    name: "nemoclaw-mcporter-runtime",
    version: "0.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "nemoclaw-mcporter-runtime",
        version: "0.0.0",
        dependencies: { mcporter: "0.7.3" },
      },
      "node_modules/@hono/node-server": {
        version: "1.19.14",
        resolved: "https://registry.npmjs.org/@hono/node-server/-/node-server-1.19.14.tgz",
        integrity:
          "sha512-GwtvgtXxnWsucXvbQXkRgqksiH2Qed37H9xHZocE5sA3N8O8O8/8FA3uclQXxXVzc9XBZuEOMK7+r02FmSpHtw==",
        engines: { node: ">=18.14.1" },
      },
      "node_modules/@modelcontextprotocol/sdk": {
        version: "1.29.0",
        dependencies: { "@hono/node-server": "^1.19.9" },
      },
      "node_modules/mcporter": { version: "0.7.3" },
    },
  });
  return { backupDirectory, packageRoot };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("historical mcporter Hono security revision (#7272)", () => {
  it("atomically revises the reviewed metadata and verifies the installed package", () => {
    const target = fixture();
    expect(prepareHistoricalMcporterInstall(target)).toBe("vulnerable");
    writeJson(
      path.join(target.packageRoot, "node_modules", "@hono", "node-server", "package.json"),
      { name: "@hono/node-server", version: FIXED_HONO_NODE_SERVER_VERSION },
    );
    expect(() => verifyHistoricalMcporterInstall(target.packageRoot)).not.toThrow();
  });

  it("restores the exact vulnerable metadata after a failed install", () => {
    const target = fixture();
    prepareHistoricalMcporterInstall(target);
    restoreHistoricalMcporterInstall(target);
    fs.rmSync(target.backupDirectory, { recursive: true });
    fs.mkdirSync(target.backupDirectory);
    expect(prepareHistoricalMcporterInstall(target)).toBe("vulnerable");
  });

  it("rejects mixed and symlinked historical metadata", () => {
    const mixed = fixture();
    const manifestPath = path.join(mixed.packageRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.overrides = { "@hono/node-server": FIXED_HONO_NODE_SERVER_VERSION };
    writeJson(manifestPath, manifest);
    expect(() => prepareHistoricalMcporterInstall(mixed)).toThrow("mixed or has drifted");

    const symlinked = fixture();
    const realManifest = path.join(symlinked.packageRoot, "real-package.json");
    fs.renameSync(path.join(symlinked.packageRoot, "package.json"), realManifest);
    fs.symlinkSync(realManifest, path.join(symlinked.packageRoot, "package.json"));
    expect(() => prepareHistoricalMcporterInstall(symlinked)).toThrow("must be a real file");
  });
});
