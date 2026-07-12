#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// preinstall guard: refuse to install on a Node major older than the
// minimum declared in package.json engines.node, with a clear actionable
// error. Without this, npm install proceeds on Node 18/20 and fails
// partway through prepare with a wall of unrelated errors that look like
// the repo is broken (see #2399).

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const pkgPath = path.join(__dirname, "..", "package.json");
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
} catch (err) {
  console.error(`[preinstall] could not read package.json: ${err.message}`);
  process.exit(1);
}

const range = pkg && pkg.engines && pkg.engines.node;
if (!range || typeof range !== "string") {
  // Nothing to enforce. Pass through quietly so consumer trees that
  // strip engines metadata are not blocked.
  process.exit(0);
}

// Pull the first \d+\.\d+\.\d+ from the range. Any of "22.16.0",
// ">=22.16.0", "^22.16.0", "22.16.0 || 24.0.0" all yield 22.16.0.
const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
if (!match) {
  process.exit(0);
}
const minMajor = parseInt(match[1], 10);
const minMinor = parseInt(match[2], 10);
const minPatch = parseInt(match[3], 10);

const current = process.versions.node;
const currentMatch = /(\d+)\.(\d+)\.(\d+)/.exec(current);
if (!currentMatch) {
  process.exit(0);
}
const currentMajor = parseInt(currentMatch[1], 10);
const currentMinor = parseInt(currentMatch[2], 10);
const currentPatch = parseInt(currentMatch[3], 10);

const tooOld =
  currentMajor < minMajor ||
  (currentMajor === minMajor && currentMinor < minMinor) ||
  (currentMajor === minMajor && currentMinor === minMinor && currentPatch < minPatch);

if (tooOld) {
  console.error("");
  console.error(
    `  NemoClaw requires Node ${minMajor}.${minMinor}.${minPatch} or newer. Detected Node ${current}.`,
  );
  console.error("");
  console.error("  Upgrade Node, then re-run `npm install`. For example, with nvm:");
  console.error(`    nvm install ${minMajor} && nvm use ${minMajor}`);
  console.error("");
  console.error("  See package.json engines.node for the required range.");
  console.error("");
  process.exit(1);
}
