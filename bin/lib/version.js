// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the NemoClaw version from (in order):
 *   1. `git describe --tags --match "v*"` — works in dev / source checkouts
 *   2. `.version` file at repo root       — stamped at publish time
 *   3. `package.json` version             — hard-coded fallback
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");

function getVersion() {
  // 1. Try git (available in dev clones and CI)
  try {
    const raw = execFileSync("git", ["describe", "--tags", "--match", "v*"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // raw looks like "v0.3.0" or "v0.3.0-4-gabcdef1"
    if (raw) return raw.replace(/^v/, "");
  } catch {
    // no git, or no matching tags — fall through
  }

  // 2. Try .version file (stamped by prepublishOnly)
  try {
    const ver = fs.readFileSync(path.join(ROOT, ".version"), "utf-8").trim();
    if (ver) return ver;
  } catch {
    // not present — fall through
  }

  // 3. Fallback to package.json
  return require(path.join(ROOT, "package.json")).version;
}

module.exports = { getVersion };
