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
const PREVIOUS_COMMAND_ARTIFACT = "dist/commands/deploy.js";
const PREVIOUS_COMMAND_DECLARATION = "dist/commands/deploy.d.ts";
const PREVIOUS_COMMAND_SOURCE_MAP = "dist/commands/deploy.js.map";
const PREVIOUS_ACTION_ARTIFACT = "dist/lib/actions/deploy.js";
const PREVIOUS_ACTION_DECLARATION_MAP = "dist/lib/actions/deploy.d.ts.map";
const PREVIOUS_IMPLEMENTATION_ARTIFACT = "dist/lib/deploy/index.js";
const RETIRED_ARTIFACT_PRUNER = "scripts/lib/prune-retired-build-artifacts.mts";
const RETIRED_CLI_ARTIFACTS = [
  "dist/lib/actions/sandbox/agent/connect-shields-relock-notice.js",
  "dist/lib/actions/sandbox/agent/passthrough-shields-warning.js.map",
  "dist/lib/actions/sandbox/backup-shields-window.d.ts",
  "dist/lib/actions/sandbox/rebuild-shields-phase.d.ts.map",
  "dist/lib/actions/sandbox/rebuild-shields.js",
  "dist/lib/domain/duration.js.map",
  "dist/lib/onboard/runtime-provider/container-state-mutation.d.ts",
  "dist/lib/onboard/runtime-provider/docker-state-mutation.d.ts.map",
  "dist/lib/onboard/runtime-provider/persisted-engine-lifecycle.js",
  "dist/lib/onboard/runtime-provider/podman-state-mutation.js.map",
  "dist/lib/onboard/runtime-provider/state-mutation.d.ts",
  "dist/lib/state/mcp-lifecycle-lock/shields-timer-authority.d.ts.map",
  "dist/commands/sandbox/shields/up.js",
  "dist/lib/shields/index.js",
  "nemoclaw/dist/commands/shields-status.js",
] as const;

function copyRetiredArtifactPruner(fixtureRoot: string): void {
  const fixturePruner = path.join(fixtureRoot, RETIRED_ARTIFACT_PRUNER);
  mkdirSync(path.dirname(fixturePruner), { recursive: true });
  copyFileSync(path.join(REPOSITORY_ROOT, RETIRED_ARTIFACT_PRUNER), fixturePruner);
}

function writeArtifact(root: string, relativePath: string): string {
  const artifactPath = path.join(root, relativePath);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, "export {};\n");
  return artifactPath;
}

describe("CLI source-checkout upgrade build", () => {
  it("prunes compiled deploy artifacts before the normal build (#10572)", () => {
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
      copyRetiredArtifactPruner(fixtureRoot);
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

      const policyRoot = path.join(fixtureRoot, "nemoclaw");
      mkdirSync(policyRoot);
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.json"),
        path.join(policyRoot, "tsconfig.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.shared.json"),
        path.join(policyRoot, "tsconfig.shared.json"),
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "node_modules"),
        path.join(policyRoot, "node_modules"),
        "junction",
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "src"),
        path.join(policyRoot, "src"),
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

      const previousCommandPath = path.join(fixtureRoot, PREVIOUS_COMMAND_ARTIFACT);
      const previousCommandDeclarationPath = path.join(fixtureRoot, PREVIOUS_COMMAND_DECLARATION);
      const previousCommandSourceMapPath = path.join(fixtureRoot, PREVIOUS_COMMAND_SOURCE_MAP);
      const previousActionPath = path.join(fixtureRoot, PREVIOUS_ACTION_ARTIFACT);
      const previousActionDeclarationMapPath = path.join(
        fixtureRoot,
        PREVIOUS_ACTION_DECLARATION_MAP,
      );
      const previousImplementationPath = path.join(fixtureRoot, PREVIOUS_IMPLEMENTATION_ARTIFACT);
      mkdirSync(path.dirname(previousCommandPath), { recursive: true });
      mkdirSync(path.dirname(previousActionPath), { recursive: true });
      mkdirSync(path.dirname(previousImplementationPath), { recursive: true });
      writeFileSync(previousCommandPath, "module.exports = {};\n");
      writeFileSync(previousCommandDeclarationPath, "export {};\n");
      writeFileSync(previousCommandSourceMapPath, "{}\n");
      writeFileSync(previousActionPath, "module.exports = {};\n");
      writeFileSync(previousActionDeclarationMapPath, "{}\n");
      writeFileSync(previousImplementationPath, "module.exports = {};\n");
      const previousShieldsCommandPath = writeArtifact(
        fixtureRoot,
        "dist/commands/sandbox/shields/up.js",
      );
      const previousShieldsLibraryPath = writeArtifact(fixtureRoot, "dist/lib/shields/index.js");
      const previousPluginShieldsCommandPath = writeArtifact(
        fixtureRoot,
        "nemoclaw/dist/commands/shields-status.js",
      );
      const preservedBuildArtifact = writeArtifact(
        fixtureRoot,
        "dist/lib/actions/sandbox/current-output.js",
      );

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

      expect(existsSync(previousCommandPath), PREVIOUS_COMMAND_ARTIFACT).toBe(false);
      expect(existsSync(previousCommandDeclarationPath), PREVIOUS_COMMAND_DECLARATION).toBe(false);
      expect(existsSync(previousCommandSourceMapPath), PREVIOUS_COMMAND_SOURCE_MAP).toBe(false);
      expect(existsSync(previousActionPath), PREVIOUS_ACTION_ARTIFACT).toBe(false);
      expect(existsSync(previousActionDeclarationMapPath), PREVIOUS_ACTION_DECLARATION_MAP).toBe(
        false,
      );
      expect(existsSync(previousImplementationPath), PREVIOUS_IMPLEMENTATION_ARTIFACT).toBe(false);
      expect(existsSync(previousShieldsCommandPath)).toBe(false);
      expect(existsSync(previousShieldsLibraryPath)).toBe(false);
      expect(existsSync(previousPluginShieldsCommandPath)).toBe(false);
      expect(existsSync(preservedBuildArtifact)).toBe(true);
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

  it.each(RETIRED_CLI_ARTIFACTS)(
    "prunes the retired output %s without broad dist cleanup (#10696)",
    (retiredArtifact) => {
      const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-shields-cli-upgrade-build-"));
      try {
        copyFileSync(
          path.join(REPOSITORY_ROOT, "package.json"),
          path.join(fixtureRoot, "package.json"),
        );
        copyRetiredArtifactPruner(fixtureRoot);

        const retiredArtifactPath = writeArtifact(fixtureRoot, retiredArtifact);
        const preservedCliArtifact = writeArtifact(
          fixtureRoot,
          "dist/lib/actions/sandbox/current-output.js",
        );
        const preservedPluginArtifact = writeArtifact(
          fixtureRoot,
          "nemoclaw/dist/commands/current-command.js",
        );

        const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
        const prune = spawnSync(npmExecutable, ["run", "prune:retired-cli"], {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: process.env,
          timeout: 30_000,
        });
        expect(prune.status, `${prune.stdout}\n${prune.stderr}`).toBe(0);

        expect(existsSync(retiredArtifactPath), retiredArtifact).toBe(false);
        expect(existsSync(preservedCliArtifact)).toBe(true);
        expect(existsSync(preservedPluginArtifact)).toBe(true);
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
  );

  it("prunes only the retired Shields plugin command during an in-place build (#10696)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-shields-plugin-upgrade-build-"));
    const pluginRoot = path.join(fixtureRoot, "nemoclaw");
    try {
      mkdirSync(pluginRoot, { recursive: true });
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "package.json"),
        path.join(pluginRoot, "package.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "tsconfig.json"),
        path.join(pluginRoot, "tsconfig.json"),
      );
      copyRetiredArtifactPruner(fixtureRoot);
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw", "node_modules"),
        path.join(pluginRoot, "node_modules"),
        "junction",
      );
      writeArtifact(pluginRoot, "src/index.ts");

      const retiredJavaScript = writeArtifact(pluginRoot, "dist/commands/shields-status.js");
      const retiredJavaScriptMap = writeArtifact(pluginRoot, "dist/commands/shields-status.js.map");
      const retiredDeclaration = writeArtifact(pluginRoot, "dist/commands/shields-status.d.ts");
      const retiredDeclarationMap = writeArtifact(
        pluginRoot,
        "dist/commands/shields-status.d.ts.map",
      );
      const preservedArtifact = writeArtifact(pluginRoot, "dist/commands/current-command.js");

      const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
      const build = spawnSync(npmExecutable, ["run", "build"], {
        cwd: pluginRoot,
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      expect(existsSync(retiredJavaScript)).toBe(false);
      expect(existsSync(retiredJavaScriptMap)).toBe(false);
      expect(existsSync(retiredDeclaration)).toBe(false);
      expect(existsSync(retiredDeclarationMap)).toBe(false);
      expect(existsSync(preservedArtifact)).toBe(true);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});
