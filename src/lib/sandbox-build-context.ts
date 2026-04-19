// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

function createBuildContextDir(tmpDir = os.tmpdir()) {
  return fs.mkdtempSync(path.join(tmpDir, "nemoclaw-build-"));
}

function stageLegacySandboxBuildContext(rootDir, tmpDir = os.tmpdir()) {
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

function stageOptimizedSandboxBuildContext(rootDir, tmpDir = os.tmpdir()) {
  const buildCtx = createBuildContextDir(tmpDir);
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  const sourceNemoclawDir = path.join(rootDir, "nemoclaw");
  const stagedNemoclawDir = path.join(buildCtx, "nemoclaw");
  const sourceBlueprintDir = path.join(rootDir, "nemoclaw-blueprint");
  const stagedBlueprintDir = path.join(buildCtx, "nemoclaw-blueprint");
  const stagedScriptsDir = path.join(buildCtx, "scripts");

  fs.copyFileSync(path.join(rootDir, "Dockerfile"), stagedDockerfile);

  fs.mkdirSync(stagedNemoclawDir, { recursive: true });
  for (const file of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "openclaw.plugin.json",
  ]) {
    fs.copyFileSync(path.join(sourceNemoclawDir, file), path.join(stagedNemoclawDir, file));
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

  return { buildCtx, stagedDockerfile };
}

function collectBuildContextStats(dir) {
  let fileCount = 0;
  let totalBytes = 0;

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
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
