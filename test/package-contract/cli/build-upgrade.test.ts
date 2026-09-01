// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function writeArtifact(root: string, relativePath: string): string {
  const artifactPath = path.join(root, relativePath);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, "export {};\n");
  return artifactPath;
}

function runNpmBuild(cwd: string, script: string, timeout: number) {
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(npmExecutable, ["run", script], {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout,
  });
}

describe("source-checkout upgrade builds", () => {
  it("cleans stale Shields and unrelated CLI outputs before the real build (#10572, #10696)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-cli-upgrade-build-"));
    try {
      copyFileSync(
        path.join(REPOSITORY_ROOT, "package.json"),
        path.join(fixtureRoot, "package.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "tsconfig.src.json"),
        path.join(fixtureRoot, "tsconfig.src.json"),
      );
      writeFileSync(path.join(fixtureRoot, ".source-revision"), `${"a".repeat(40)}\n`);

      symlinkSync(path.join(REPOSITORY_ROOT, "bin"), path.join(fixtureRoot, "bin"), "junction");
      symlinkSync(
        path.join(REPOSITORY_ROOT, "managed-inference"),
        path.join(fixtureRoot, "managed-inference"),
        "junction",
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "junction",
      );
      symlinkSync(path.join(REPOSITORY_ROOT, "src"), path.join(fixtureRoot, "src"), "junction");

      const pluginRoot = path.join(fixtureRoot, "nemoclaw");
      mkdirSync(pluginRoot);
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.json"),
        path.join(pluginRoot, "tsconfig.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.shared.json"),
        path.join(pluginRoot, "tsconfig.shared.json"),
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "node_modules"),
        path.join(pluginRoot, "node_modules"),
        "junction",
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "src"),
        path.join(pluginRoot, "src"),
        "junction",
      );

      const blueprintRoot = path.join(fixtureRoot, "nemoclaw-blueprint");
      mkdirSync(blueprintRoot);
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "tsconfig.json"),
        path.join(blueprintRoot, "tsconfig.json"),
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "scripts"),
        path.join(blueprintRoot, "scripts"),
        "junction",
      );

      const staleShieldsArtifact = writeArtifact(fixtureRoot, "dist/lib/shields/index.js");
      const staleDeployCommand = writeArtifact(fixtureRoot, "dist/commands/deploy.js");
      const staleDeployAction = writeArtifact(fixtureRoot, "dist/lib/actions/deploy.js");
      const staleDeployImplementation = writeArtifact(fixtureRoot, "dist/lib/deploy/index.js");
      const unrelatedStaleArtifact = writeArtifact(
        fixtureRoot,
        "dist/lib/actions/sandbox/unrelated-stale-output.js",
      );

      const build = runNpmBuild(fixtureRoot, "build:cli", 120_000);
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      expect(existsSync(staleShieldsArtifact)).toBe(false);
      expect(existsSync(staleDeployCommand)).toBe(false);
      expect(existsSync(staleDeployAction)).toBe(false);
      expect(existsSync(staleDeployImplementation)).toBe(false);
      expect(existsSync(unrelatedStaleArtifact)).toBe(false);
      expect(existsSync(path.join(fixtureRoot, "dist", "nemoclaw.js"))).toBe(true);
      expect(
        existsSync(path.join(pluginRoot, "dist", "shared", "openshell-policy-boundary.cjs")),
      ).toBe(true);

      const help = spawnSync(process.execPath, ["bin/nemoclaw.js", "deploy", "--help"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.join(fixtureRoot, "home"),
          NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
        },
        timeout: 30_000,
      });
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain("Usage: nemoclaw deploy connect");
      expect(help.stdout).not.toContain("Brev-specific");
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }, 150_000);

  it("cleans stale Shields and unrelated outputs in a standalone plugin package (#10696)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-plugin-upgrade-build-"));
    const pluginRoot = path.join(fixtureRoot, "package");
    try {
      mkdirSync(pluginRoot);
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "package.json"),
        path.join(pluginRoot, "package.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.json"),
        path.join(pluginRoot, "tsconfig.json"),
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "node_modules"),
        path.join(pluginRoot, "node_modules"),
        "junction",
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "src"),
        path.join(pluginRoot, "src"),
        "junction",
      );

      const staleShieldsArtifact = writeArtifact(pluginRoot, "dist/commands/shields-status.js");
      const unrelatedStaleArtifact = writeArtifact(
        pluginRoot,
        "dist/commands/unrelated-stale-output.js",
      );

      expect(existsSync(path.join(fixtureRoot, "scripts"))).toBe(false);
      const build = runNpmBuild(pluginRoot, "build", 60_000);
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      expect(existsSync(staleShieldsArtifact)).toBe(false);
      expect(existsSync(unrelatedStaleArtifact)).toBe(false);
      expect(existsSync(path.join(pluginRoot, "dist", "index.js"))).toBe(true);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }, 90_000);
});
