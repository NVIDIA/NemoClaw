#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fernRoot = path.join(repoRoot, "fern");
const watchRoots = ["docs", "fern"];
const ignoredDirectoryNames = new Set([".fern-cache", ".git", "_build", "node_modules"]);
const debounceMs = 500;

const fernVersion = JSON.parse(
  readFileSync(path.join(repoRoot, "fern", "fern.config.json"), "utf8"),
).version;

const branchName = currentBranchName();
let running = false;
let pending = false;
let debounceTimer;
let currentChild;
const watchers = new Map();

console.log(`Using Fern preview id: ${branchName}`);
console.log(`Watching: ${watchRoots.join(", ")}`);

for (const root of watchRoots) {
  watchDirectoryTree(path.join(repoRoot, root));
}

runFernGenerate("initial run");

process.on("SIGINT", () => {
  closeWatchers();
  currentChild?.kill("SIGINT");
  process.exit(130);
});

process.on("SIGTERM", () => {
  closeWatchers();
  currentChild?.kill("SIGTERM");
  process.exit(143);
});

function currentBranchName() {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const branch = result.stdout.trim();

  if (result.status !== 0 || branch.length === 0) {
    console.error("Could not determine the current Git branch name.");
    process.exit(1);
  }

  return branch;
}

function watchDirectoryTree(directory) {
  if (!existsSync(directory) || watchers.has(directory)) {
    return;
  }

  try {
    watchers.set(
      directory,
      watch(directory, { persistent: true }, (_eventType, filename) => {
        if (filename) {
          const changedPath = path.join(directory, filename.toString());
          if (shouldIgnorePath(changedPath)) {
            return;
          }
          addWatcherForNewDirectory(changedPath);
        }
        scheduleRun();
      }),
    );
  } catch (error) {
    if (!isIgnorableWatchError(error)) {
      throw error;
    }
    return;
  }

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (!isIgnorableWatchError(error)) {
      throw error;
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childDirectory = path.join(directory, entry.name);
    if (!shouldIgnorePath(childDirectory)) {
      watchDirectoryTree(childDirectory);
    }
  }
}

function addWatcherForNewDirectory(changedPath) {
  if (!existsSync(changedPath)) {
    return;
  }

  try {
    const stats = statSync(changedPath);
    if (stats.isDirectory()) {
      watchDirectoryTree(changedPath);
    }
  } catch (error) {
    if (!isIgnorableWatchError(error)) {
      throw error;
    }
  }
}

function isIgnorableWatchError(error) {
  return error?.code === "ENOENT" || error?.code === "EPERM";
}

function shouldIgnorePath(candidatePath) {
  return candidatePath.split(path.sep).some((part) => ignoredDirectoryNames.has(part));
}

function scheduleRun() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runFernGenerate("file change"), debounceMs);
}

function runFernGenerate(reason) {
  if (running) {
    pending = true;
    return;
  }

  running = true;
  pending = false;

  const args = [
    "--yes",
    `fern-api@${fernVersion}`,
    "generate",
    "--docs",
    "--preview",
    "--id",
    branchName,
    "--force",
  ];

  console.log(`\n[${new Date().toLocaleTimeString()}] Running Fern (${reason})`);
  console.log(`cd fern && npx ${args.join(" ")}`);

  const child = spawn("npx", args, {
    cwd: fernRoot,
    stdio: "inherit",
  });
  currentChild = child;

  child.on("error", (error) => {
    running = false;
    currentChild = undefined;
    console.error(`Failed to start Fern preview generation: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    running = false;
    currentChild = undefined;

    if (signal) {
      console.log(`Fern stopped by signal ${signal}.`);
    } else if (code === 0) {
      console.log("Fern preview generation completed.");
    } else {
      console.error(`Fern preview generation failed with exit code ${code}.`);
    }

    if (pending) {
      runFernGenerate("queued file change");
    }
  });
}

function closeWatchers() {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
}
