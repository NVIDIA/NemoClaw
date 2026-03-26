// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync } = require("child_process");
const fs = require("fs");

/**
 * Verify that the binary at `binPath` is the OpenShell CLI and not another
 * package that happens to share the same name (e.g. the npm `openshell`
 * gateway package installed as a transitive dependency of `openclaw`).
 *
 * The OpenShell CLI prints a version string starting with "openshell "
 * when invoked with `--version`.
 */
function isOpenshellCLI(binPath) {
  try {
    const out = execSync(`"${binPath}" --version`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^openshell\s+\d+/.test(out);
  } catch {
    return false;
  }
}

/**
 * Resolve the openshell binary path.
 *
 * Checks `command -v` first (must return an absolute path to prevent alias
 * injection), then falls back to common installation directories.
 *
 * Every candidate is verified with `isOpenshellCLI()` to ensure the resolved
 * binary is the real OpenShell CLI and not a same-named npm package.
 *
 * @param {object} [opts] DI overrides for testing
 * @param {string|null} [opts.commandVResult] Mock result (undefined = run real command)
 * @param {function} [opts.checkExecutable] (path) => boolean
 * @param {function} [opts.checkCLI] (path) => boolean — override for `isOpenshellCLI`
 * @param {string} [opts.home] HOME override
 * @returns {string|null} Absolute path to openshell, or null if not found
 */
function resolveOpenshell(opts = {}) {
  const home = opts.home ?? process.env.HOME;
  const checkCLI = opts.checkCLI || isOpenshellCLI;

  // Step 1: command -v
  if (opts.commandVResult === undefined) {
    try {
      const found = execSync("command -v openshell", { encoding: "utf-8" }).trim();
      if (found.startsWith("/") && checkCLI(found)) return found;
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
    if (checkExecutable(p) && checkCLI(p)) return p;
  }

  return null;
}

module.exports = { resolveOpenshell, isOpenshellCLI };
