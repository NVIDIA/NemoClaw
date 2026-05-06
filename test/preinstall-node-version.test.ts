// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/check-node-version.js");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");

function readPackageJson(): {
  scripts?: Record<string, string>;
  engines?: { node?: string };
} {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"));
}

describe("preinstall node-version guard (#2399)", () => {
  it("scripts/check-node-version.js exists and is executable", () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    const stat = fs.statSync(SCRIPT_PATH);
    // 0o111 covers any-user-executable. We only need it to be runnable; the
    // exact mode bits vary across umask defaults.
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it("package.json wires the script as preinstall", () => {
    const pkg = readPackageJson();
    expect(pkg.scripts?.preinstall).toBe("node scripts/check-node-version.js");
  });

  it("package.json declares engines.node so the guard has something to enforce", () => {
    const pkg = readPackageJson();
    expect(pkg.engines?.node).toBeDefined();
    expect(pkg.engines?.node).toMatch(/\d+\.\d+\.\d+/);
  });

  it("guard exits 0 on a Node version that satisfies the declared range", () => {
    // The current process is the same Node version that npm install uses, and
    // the repo is installable in this Node, so the guard must accept it.
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("guard exits 1 with an actionable error when a fake Node 18 is simulated", () => {
    // Run the guard under Node, but trick it by overriding process.versions.node
    // before requiring the script. We use --require to inject the override
    // before any user code runs, so the script reads the patched value.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "preinstall-guard-"),
    );
    try {
      const overridePath = path.join(tmpDir, "fake-node-18.js");
      fs.writeFileSync(
        overridePath,
        "Object.defineProperty(process.versions, 'node', { value: '18.20.0', configurable: true });\n",
      );
      const result = spawnSync(
        process.execPath,
        ["--require", overridePath, SCRIPT_PATH],
        {
          encoding: "utf-8",
          timeout: 5000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/NemoClaw requires Node \d+\.\d+\.\d+/);
      expect(result.stderr).toContain("Detected Node 18.20.0");
      expect(result.stderr).toContain("nvm install");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("guard tolerates package.json without engines.node by exiting 0", () => {
    // Synthesize a package.json fixture without engines and run the script
    // pointed at it via a sibling tmp dir. The script reads
    // path.join(__dirname, '..', 'package.json'), so we copy the
    // script next to a custom package.json.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "preinstall-guard-no-engines-"),
    );
    try {
      const scriptsDir = path.join(tmpDir, "scripts");
      fs.mkdirSync(scriptsDir);
      fs.copyFileSync(SCRIPT_PATH, path.join(scriptsDir, "check-node-version.js"));
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "fixture", version: "0.0.0" }, null, 2),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(scriptsDir, "check-node-version.js")],
        {
          encoding: "utf-8",
          timeout: 5000,
        },
      );
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
