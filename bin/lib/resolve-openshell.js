// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync } = require("child_process");
const fs = require("fs");

/**
 * Resolve the openshell binary path.
 *
 * Checks `command -v` first (must return an absolute path to prevent alias
 * injection), then falls back to common installation directories.
 *
 * @param {object} [opts] DI overrides for testing
 * @param {string|null} [opts.commandVResult] Mock result (undefined = run real command)
 * @param {function} [opts.checkExecutable] (path) => boolean
 * @param {string} [opts.home] HOME override
 * @returns {string|null} Absolute path to openshell, or null if not found
 */
function resolveOpenshell(opts = {}) {
  const home = opts.home ?? process.env.HOME;

  // Step 1: command -v
  if (opts.commandVResult === undefined) {
    try {
      const found = execSync("command -v openshell", { encoding: "utf-8" }).trim();
      if (found.startsWith("/")) return found;
    } catch { /* ignored */ }
  } else if (opts.commandVResult && opts.commandVResult.startsWith("/")) {
    return opts.commandVResult;
  }

  // Step 2: fallback candidates
  const checkExecutable = opts.checkExecutable || ((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  });

  const candidates = [
    ...(home && home.startsWith("/") ? [`${home}/.local/bin/openshell`] : []),
    "/usr/local/bin/openshell",
    "/usr/bin/openshell",
  ];
  for (const p of candidates) {
    if (checkExecutable(p)) return p;
  }

  return null;
}

module.exports = { resolveOpenshell };
