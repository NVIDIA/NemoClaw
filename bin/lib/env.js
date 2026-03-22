// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Lightweight .env loader — reads .env files from the project root and populates
// process.env. Existing environment variables are never overwritten, so shell
// exports always take precedence over file values.
//
// Supports:
//   - Multiple files (loaded in order; first file's values win over later files)
//   - Comments (#) and blank lines
//   - KEY=VALUE, KEY="VALUE", KEY='VALUE'
//   - Inline comments after unquoted values

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CWD = process.cwd();

/**
 * Walk up from a directory looking for a .git marker to find the repo root.
 * @param {string} start - Directory to begin searching from.
 * @returns {string|null} Absolute path to the git root, or null if not found.
 */
function findGitRoot(start) {
  let dir = start;
  while (true) {
    try {
      fs.statSync(path.join(dir, ".git"));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

const GIT_ROOT = findGitRoot(CWD);

/**
 * Parse a .env file and populate process.env with its values.
 * Existing environment variables are never overwritten.
 * @param {string} filePath - Absolute path to the .env file.
 */
function parseEnvFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return; // file doesn't exist or isn't readable — skip silently
  }

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = line.slice(eqIndex + 1).trim();

    // Strip surrounding quotes first so that `#` inside quoted values is
    // preserved (e.g. KEY="val#ue" or KEY="value" # comment).
    if (
      (value.startsWith('"') && value.includes('"', 1)) ||
      (value.startsWith("'") && value.includes("'", 1))
    ) {
      const quote = value[0];
      const closeIdx = value.indexOf(quote, 1);
      value = value.slice(1, closeIdx);
    } else {
      // Unquoted value — strip inline comments
      const hashIndex = value.indexOf(" #");
      if (hashIndex !== -1) {
        value = value.slice(0, hashIndex).trim();
      }
    }

    // Never overwrite existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Collect unique directories to search for .env files.  The git repo root and
// CWD are checked in addition to the __dirname-relative ROOT so that a user's
// .env.local (which is gitignored and therefore not synced into the sandbox
// source directory) is still picked up on a fresh install.
const SEARCH_DIRS = [...new Set([ROOT, GIT_ROOT, CWD].filter(Boolean))];

// Load .env files in priority order — first file wins for any given key
// because we never overwrite once set.
const ENV_FILES = [".env.local", ".env"];

for (const file of ENV_FILES) {
  for (const dir of SEARCH_DIRS) {
    parseEnvFile(path.join(dir, file));
  }
}

module.exports = { parseEnvFile, findGitRoot };
