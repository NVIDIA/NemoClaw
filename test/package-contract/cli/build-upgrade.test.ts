// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PREVIOUS_COMMAND_ARTIFACT = "dist/commands/deploy.js";
const PREVIOUS_COMMAND_DECLARATION = "dist/commands/deploy.d.ts";
const PREVIOUS_COMMAND_SOURCE_MAP = "dist/commands/deploy.js.map";
const PREVIOUS_ACTION_ARTIFACT = "dist/lib/actions/deploy.js";
const PREVIOUS_ACTION_DECLARATION_MAP = "dist/lib/actions/deploy.d.ts.map";
const PREVIOUS_IMPLEMENTATION_ARTIFACT = "dist/lib/deploy/index.js";
const PREVIOUS_SHIELDS_ROOT_ARTIFACT = "dist/lib/shields/index.js";
const PREVIOUS_SHIELDS_PLUGIN_ARTIFACT = "dist/commands/shields-status.js";
const RETIRED_ROUTE_HELPER_ARTIFACT = "dist/lib/inference/gateway/command-args.js";
const RETIRED_ROUTE_HELPER_SOURCE_MAP = "dist/lib/inference/gateway/command-args.js.map";
const RETIRED_ROUTE_HELPER_DECLARATION = "dist/lib/inference/gateway/command-args.d.ts";
const RETIRED_ROUTE_HELPER_DECLARATION_MAP = "dist/lib/inference/gateway/command-args.d.ts.map";

describe("CLI source-checkout upgrade build", () => {
  it("prunes retired CLI artifacts before the normal build (#9809, #10572, #10696)", () => {
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

      cpSync(path.join(REPOSITORY_ROOT, "bin"), path.join(fixtureRoot, "bin"), {
        recursive: true,
      });
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
      const scriptsRoot = path.join(fixtureRoot, "scripts", "lib");
      mkdirSync(scriptsRoot, { recursive: true });
      copyFileSync(
        path.join(REPOSITORY_ROOT, "scripts", "lib", "package-blueprint-runner-runtime.mts"),
        path.join(scriptsRoot, "package-blueprint-runner-runtime.mts"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "scripts", "lib", "normalize-package-bin-modes.mts"),
        path.join(scriptsRoot, "normalize-package-bin-modes.mts"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "scripts", "lib", "repository-input-path.mts"),
        path.join(scriptsRoot, "repository-input-path.mts"),
      );

      const policyRoot = path.join(fixtureRoot, "nemoclaw");
      mkdirSync(policyRoot);
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "package.json"),
        path.join(policyRoot, "package.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.json"),
        path.join(policyRoot, "tsconfig.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.shared.json"),
        path.join(policyRoot, "tsconfig.shared.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.runner.json"),
        path.join(policyRoot, "tsconfig.runner.json"),
      );
      cpSync(path.join(REPOSITORY_ROOT, "nemoclaw", "src"), path.join(policyRoot, "src"), {
        recursive: true,
      });

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

      const previousCommandPath = path.join(fixtureRoot, PREVIOUS_COMMAND_ARTIFACT);
      const previousCommandDeclarationPath = path.join(fixtureRoot, PREVIOUS_COMMAND_DECLARATION);
      const previousCommandSourceMapPath = path.join(fixtureRoot, PREVIOUS_COMMAND_SOURCE_MAP);
      const previousActionPath = path.join(fixtureRoot, PREVIOUS_ACTION_ARTIFACT);
      const previousActionDeclarationMapPath = path.join(
        fixtureRoot,
        PREVIOUS_ACTION_DECLARATION_MAP,
      );
      const previousImplementationPath = path.join(fixtureRoot, PREVIOUS_IMPLEMENTATION_ARTIFACT);
      const previousShieldsRootPath = path.join(fixtureRoot, PREVIOUS_SHIELDS_ROOT_ARTIFACT);
      const retiredRouteHelperArtifactPath = path.join(fixtureRoot, RETIRED_ROUTE_HELPER_ARTIFACT);
      const retiredRouteHelperSourceMapPath = path.join(
        fixtureRoot,
        RETIRED_ROUTE_HELPER_SOURCE_MAP,
      );
      const retiredRouteHelperDeclarationPath = path.join(
        fixtureRoot,
        RETIRED_ROUTE_HELPER_DECLARATION,
      );
      const retiredRouteHelperDeclarationMapPath = path.join(
        fixtureRoot,
        RETIRED_ROUTE_HELPER_DECLARATION_MAP,
      );
      mkdirSync(path.dirname(previousCommandPath), { recursive: true });
      mkdirSync(path.dirname(previousActionPath), { recursive: true });
      mkdirSync(path.dirname(previousImplementationPath), { recursive: true });
      mkdirSync(path.dirname(previousShieldsRootPath), { recursive: true });
      mkdirSync(path.dirname(retiredRouteHelperArtifactPath), { recursive: true });
      writeFileSync(previousCommandPath, "module.exports = {};\n");
      writeFileSync(previousCommandDeclarationPath, "export {};\n");
      writeFileSync(previousCommandSourceMapPath, "{}\n");
      writeFileSync(previousActionPath, "module.exports = {};\n");
      writeFileSync(previousActionDeclarationMapPath, "{}\n");
      writeFileSync(previousImplementationPath, "module.exports = {};\n");
      writeFileSync(previousShieldsRootPath, "module.exports = {};\n");
      writeFileSync(retiredRouteHelperArtifactPath, "stale route helper\n");
      writeFileSync(retiredRouteHelperSourceMapPath, "stale route helper\n");
      writeFileSync(retiredRouteHelperDeclarationPath, "stale route helper\n");
      writeFileSync(retiredRouteHelperDeclarationMapPath, "stale route helper\n");

      const staleMetadataPath = path.join(
        fixtureRoot,
        "dist/lib/cli/oclif-command-metadata.generated.json",
      );
      mkdirSync(path.dirname(staleMetadataPath), { recursive: true });
      writeFileSync(
        staleMetadataPath,
        `${JSON.stringify({ deploy: { id: "deploy", summary: "Deprecated Brev command" } })}\n`,
      );

      const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
      const build = spawnSync(npmExecutable, ["run", "build:cli"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: process.env,
        timeout: 120_000,
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      expect(
        process.platform === "win32" ||
          (statSync(path.join(fixtureRoot, "dist/lib/acp/main.js")).mode & 0o777) === 0o755,
        "nemoclaw-acp",
      ).toBe(true);
      expect(
        process.platform === "win32" ||
          (statSync(path.join(fixtureRoot, "dist/lib/blueprint-runner.js")).mode & 0o777) === 0o755,
        "nemoclaw-blueprint-runner",
      ).toBe(true);

      expect(existsSync(previousCommandPath), PREVIOUS_COMMAND_ARTIFACT).toBe(false);
      expect(existsSync(previousCommandDeclarationPath), PREVIOUS_COMMAND_DECLARATION).toBe(false);
      expect(existsSync(previousCommandSourceMapPath), PREVIOUS_COMMAND_SOURCE_MAP).toBe(false);
      expect(existsSync(previousActionPath), PREVIOUS_ACTION_ARTIFACT).toBe(false);
      expect(existsSync(previousActionDeclarationMapPath), PREVIOUS_ACTION_DECLARATION_MAP).toBe(
        false,
      );
      expect(existsSync(previousImplementationPath), PREVIOUS_IMPLEMENTATION_ARTIFACT).toBe(false);
      expect(existsSync(previousShieldsRootPath), PREVIOUS_SHIELDS_ROOT_ARTIFACT).toBe(false);
      expect(existsSync(retiredRouteHelperArtifactPath), RETIRED_ROUTE_HELPER_ARTIFACT).toBe(false);
      expect(existsSync(retiredRouteHelperSourceMapPath), RETIRED_ROUTE_HELPER_SOURCE_MAP).toBe(
        false,
      );
      expect(existsSync(retiredRouteHelperDeclarationPath), RETIRED_ROUTE_HELPER_DECLARATION).toBe(
        false,
      );
      expect(
        existsSync(retiredRouteHelperDeclarationMapPath),
        RETIRED_ROUTE_HELPER_DECLARATION_MAP,
      ).toBe(false);
      const routing = spawnSync(
        process.execPath,
        [
          "-e",
          "const registry = require('./dist/lib/cli/command-registry'); process.stdout.write(String(registry.globalCommandTokens().has('deploy')))",
        ],
        { cwd: fixtureRoot, encoding: "utf8", env: process.env },
      );
      expect(routing.status, routing.stderr).toBe(0);
      expect(routing.stdout).toBe("false");

      const help = spawnSync(process.execPath, ["bin/nemoclaw.js", "deploy", "--help"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.join(fixtureRoot, "home"),
          NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
          NEMOCLAW_GATEWAY_PORT: "49100",
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

  it("prunes compiled Shields output in a standalone plugin build (#10696)", () => {
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

      const previousShieldsPluginPath = path.join(pluginRoot, PREVIOUS_SHIELDS_PLUGIN_ARTIFACT);
      mkdirSync(path.dirname(previousShieldsPluginPath), { recursive: true });
      writeFileSync(previousShieldsPluginPath, "module.exports = {};\n");

      const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
      const build = spawnSync(npmExecutable, ["run", "build"], {
        cwd: pluginRoot,
        encoding: "utf8",
        env: process.env,
        timeout: 60_000,
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      expect(existsSync(previousShieldsPluginPath), PREVIOUS_SHIELDS_PLUGIN_ARTIFACT).toBe(false);
      expect(existsSync(path.join(pluginRoot, "dist", "index.js"))).toBe(true);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }, 90_000);
});
