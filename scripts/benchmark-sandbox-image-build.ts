// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectBuildContextStats,
  stageLegacySandboxBuildContext,
  stageOptimizedSandboxBuildContext,
  type StagedBuildContext,
} from "../dist/lib/sandbox/build-context";

type Args = {
  currentRepo: string;
  mainRef: string;
  noCache: boolean;
  keepWorktree: boolean;
};

type RunOptions = {
  cwd?: string;
  stdio?: StdioOptions;
};

type StageBuildContext = (repoRoot: string, tmpRoot: string) => StagedBuildContext;

type ImageBuildResult = {
  label: string;
  buildCtx: string;
  fileCount: number;
  totalBytes: number;
  elapsedSeconds: number;
  imageBytes: number;
  imageTag: string;
};

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    currentRepo: process.cwd(),
    mainRef: "origin/main",
    noCache: true,
    keepWorktree: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--current-repo") {
      i += 1;
      args.currentRepo = requireValue(argv, i, arg);
    } else if (arg === "--main-ref") {
      i += 1;
      args.mainRef = requireValue(argv, i, arg);
    } else if (arg === "--cache") {
      args.noCache = false;
    } else if (arg === "--keep-worktree") {
      args.keepWorktree = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function run(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    cwd: options.cwd,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function makeTempWorktree(mainRef: string, currentRepo: string): string {
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-main-worktree-"));
  try {
    run("git", ["worktree", "add", "--detach", worktreeRoot, mainRef], { cwd: currentRepo });
  } catch (error) {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    throw error;
  }
  return worktreeRoot;
}

function removeWorktree(worktreeRoot: string, currentRepo: string): void {
  try {
    run("git", ["worktree", "remove", "--force", worktreeRoot], { cwd: currentRepo });
  } catch {
    // Best-effort cleanup; remove the temp directory either way.
  }
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
}

function dockerBuild(
  repoRoot: string,
  stageFn: StageBuildContext,
  label: string,
  noCache: boolean,
): ImageBuildResult {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-bench-${label}-`));
  const { buildCtx } = stageFn(repoRoot, tmpRoot);
  const stats = collectBuildContextStats(buildCtx);
  const imageTag = `nemoclaw-bench-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const args = ["build", "-t", imageTag];
  if (noCache) args.push("--no-cache");
  args.push(buildCtx);

  const startedAt = process.hrtime.bigint();
  try {
    run("docker", args);
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const imageBytes = Number(
      run("docker", ["image", "inspect", imageTag, "--format", "{{.Size}}"]),
    );
    return {
      label,
      buildCtx,
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
      elapsedSeconds,
      imageBytes,
      imageTag,
    };
  } finally {
    spawnSync("docker", ["image", "rm", "-f", imageTag], { stdio: "ignore" });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function fmtMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function fmtSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function printSummary(results: ImageBuildResult[]): void {
  console.log("");
  console.log("Sandbox image build benchmark");
  console.log("");
  for (const result of results) {
    console.log(`${result.label}`);
    console.log(`  context files: ${result.fileCount}`);
    console.log(`  context size:  ${fmtMiB(result.totalBytes)}`);
    console.log(`  build time:    ${fmtSeconds(result.elapsedSeconds)}`);
    console.log(`  image size:    ${fmtMiB(result.imageBytes)}`);
  }

  if (results.length === 2) {
    const [base, candidate] = results;
    const timeDelta = base.elapsedSeconds - candidate.elapsedSeconds;
    const sizeDelta = base.totalBytes - candidate.totalBytes;
    console.log("");
    console.log("Delta");
    console.log(`  context saved: ${fmtMiB(sizeDelta)}`);
    console.log(`  time saved:    ${fmtSeconds(timeDelta)}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const currentRepo = path.resolve(args.currentRepo);
  const currentHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: currentRepo,
    encoding: "utf8",
  }).trim();
  const currentDirty =
    execFileSync("git", ["status", "--short"], { cwd: currentRepo, encoding: "utf8" }).trim()
      .length > 0;
  const currentLabel = currentDirty ? `${currentHead} + dirty` : currentHead;
  const mainWorktree = makeTempWorktree(args.mainRef, currentRepo);

  try {
    const mainLabel = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: mainWorktree,
      encoding: "utf8",
    }).trim();
    const results = [
      dockerBuild(
        mainWorktree,
        stageLegacySandboxBuildContext,
        `main (${mainLabel})`,
        args.noCache,
      ),
      dockerBuild(
        currentRepo,
        stageOptimizedSandboxBuildContext,
        `candidate (${currentLabel})`,
        args.noCache,
      ),
    ];
    printSummary(results);
  } finally {
    if (!args.keepWorktree) removeWorktree(mainWorktree, currentRepo);
  }
}

main();
