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

    // Remove inline comments for unquoted values first, then strip quotes.
    // This handles cases like KEY='value' # comment correctly.
    const hashIndex = value.indexOf(" #");
    if (hashIndex !== -1) {
      value = value.slice(0, hashIndex).trim();
    }

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Never overwrite existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Load .env files in priority order — first file wins for any given key
// because we never overwrite once set.
const ENV_FILES = [".env.local", ".env"];

for (const file of ENV_FILES) {
  parseEnvFile(path.join(ROOT, file));
}
