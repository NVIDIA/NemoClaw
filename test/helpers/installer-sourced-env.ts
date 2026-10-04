// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Path to the sourced installer payload (`scripts/install.sh`). */
export const INSTALLER_PAYLOAD = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "install.sh",
);

/**
 * Build a private PATH mirroring /usr/bin and /bin, excluding node/npm/npx
 * and any requested commands. Tests prepend their own command stubs to exercise
 * missing-tool branches consistently. Each call owns an independent directory.
 */
export function buildIsolatedSystemPath(additionalExclusions: readonly string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-sysbin-"));
  const EXCLUDE = new Set(["node", "npm", "npx", ...additionalExclusions]);
  for (const sysDir of ["/usr/bin", "/bin"]) {
    if (!fs.existsSync(sysDir)) continue;
    for (const name of fs.readdirSync(sysDir)) {
      if (EXCLUDE.has(name)) continue;
      try {
        fs.symlinkSync(path.join(sysDir, name), path.join(dir, name));
      } catch (err) {
        // Only swallow EEXIST — the expected case is when /bin is a symlink
        // to /usr/bin (modern Linux) and we already linked the same name on
        // the first pass. Any other error (EPERM, EACCES, EINVAL, ENOENT…)
        // would leave TEST_SYSTEM_PATH partially populated and turn into a
        // confusing downstream test failure, so re-throw it.
        const code =
          typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
        if (code === "EEXIST") continue;
        throw err;
      }
    }
  }
  return dir;
}

/** Shared default command path; use a new path for fixture-specific exclusions. */
export const TEST_SYSTEM_PATH = buildIsolatedSystemPath();

export function readShellConstant(file: string, name: string) {
  const source = fs.readFileSync(file, "utf-8");
  const match = new RegExp(`^${name}="([^"]+)"`, "m").exec(source);
  const value = match?.[1];
  if (!value) throw new Error(`Unable to read ${name} from ${file}`);
  return value;
}

export function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}
