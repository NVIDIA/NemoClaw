// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StagedBuildContext {
  buildCtx: string;
  stagedDockerfile: string;
}

export interface BuildContextStats {
  fileCount: number;
  totalBytes: number;
}

type BuildContextStatsFilter = (entryPath: string) => boolean;

function createBuildContextDir(tmpDir: string = os.tmpdir()): string {
  return fs.mkdtempSync(path.join(tmpDir, "nemoclaw-build-"));
}

function stageLegacySandboxBuildContext(
  rootDir: string,
  tmpDir: string = os.tmpdir(),
): StagedBuildContext {
  const buildCtx = createBuildContextDir(tmpDir);
  fs.copyFileSync(path.join(rootDir, "Dockerfile"), path.join(buildCtx, "Dockerfile"));
  fs.cpSync(path.join(rootDir, "nemoclaw"), path.join(buildCtx, "nemoclaw"), { recursive: true });
  fs.cpSync(path.join(rootDir, "nemoclaw-blueprint"), path.join(buildCtx, "nemoclaw-blueprint"), {
    recursive: true,
  });
  fs.cpSync(path.join(rootDir, "scripts"), path.join(buildCtx, "scripts"), { recursive: true });
  fs.rmSync(path.join(buildCtx, "nemoclaw", "node_modules"), { recursive: true, force: true });

  return {
    buildCtx,
    stagedDockerfile: path.join(buildCtx, "Dockerfile"),
  };
}

function stageOptimizedSandboxBuildContext(
  rootDir: string,
  tmpDir: string = os.tmpdir(),
): StagedBuildContext {
  const buildCtx = createBuildContextDir(tmpDir);
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  const sourceNemoclawDir = path.join(rootDir, "nemoclaw");
  const stagedNemoclawDir = path.join(buildCtx, "nemoclaw");
  const sourceBlueprintDir = path.join(rootDir, "nemoclaw-blueprint");
  const stagedBlueprintDir = path.join(buildCtx, "nemoclaw-blueprint");
  const stagedScriptsDir = path.join(buildCtx, "scripts");

  fs.copyFileSync(path.join(rootDir, "Dockerfile"), stagedDockerfile);

  fs.mkdirSync(stagedNemoclawDir, { recursive: true });
  for (const fileName of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "openclaw.plugin.json",
  ]) {
    fs.copyFileSync(path.join(sourceNemoclawDir, fileName), path.join(stagedNemoclawDir, fileName));
  }
  fs.cpSync(path.join(sourceNemoclawDir, "src"), path.join(stagedNemoclawDir, "src"), {
    recursive: true,
  });

  fs.mkdirSync(stagedBlueprintDir, { recursive: true });
  fs.copyFileSync(
    path.join(sourceBlueprintDir, "blueprint.yaml"),
    path.join(stagedBlueprintDir, "blueprint.yaml"),
  );
  fs.cpSync(path.join(sourceBlueprintDir, "policies"), path.join(stagedBlueprintDir, "policies"), {
    recursive: true,
  });

  fs.mkdirSync(stagedScriptsDir, { recursive: true });
  fs.copyFileSync(
    path.join(rootDir, "scripts", "nemoclaw-start.sh"),
    path.join(stagedScriptsDir, "nemoclaw-start.sh"),
  );
  fs.copyFileSync(
    path.join(rootDir, "scripts", "codex-acp-wrapper.sh"),
    path.join(stagedScriptsDir, "codex-acp-wrapper.sh"),
  );
  // Shared sandbox initialisation library sourced by the entrypoint (#2277)
  fs.mkdirSync(path.join(stagedScriptsDir, "lib"), { recursive: true });
  fs.copyFileSync(
    path.join(rootDir, "scripts", "lib", "sandbox-init.sh"),
    path.join(stagedScriptsDir, "lib", "sandbox-init.sh"),
  );
  // OpenClaw config generator extracted in #2449 (fixed in #2565)
  fs.copyFileSync(
    path.join(rootDir, "scripts", "generate-openclaw-config.py"),
    path.join(stagedScriptsDir, "generate-openclaw-config.py"),
  );

  return { buildCtx, stagedDockerfile };
}

function collectBuildContextStats(
  dir: string,
  shouldInclude: BuildContextStatsFilter = () => true,
): BuildContextStats {
  let fileCount = 0;
  let totalBytes = 0;

  function walk(currentDir: string): void {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (!shouldInclude(entryPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.isFile()) {
        fileCount += 1;
        totalBytes += fs.statSync(entryPath).size;
      }
    }
  }

  walk(dir);
  return { fileCount, totalBytes };
}

export {
  collectBuildContextStats,
  stageLegacySandboxBuildContext,
  stageOptimizedSandboxBuildContext,
};
