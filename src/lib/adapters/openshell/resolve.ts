// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { buildSubprocessEnv } from "../../subprocess-env";

export interface ResolveOpenshellOptions {
  /** Mock result for `command -v` (undefined = run real command). */
  commandVResult?: string | null;
  /** Override executable check (default: fs.accessSync X_OK). */
  checkExecutable?: (path: string) => boolean;
  /** HOME directory override. */
  home?: string;
}

/** Build the allowlisted environment for a receipt-owned direct OpenShell child. */
export function buildOpenShellSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const names = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TERM",
    "LANG",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CURL_CA_BUNDLE",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (names.has(entry[0]) || entry[0].startsWith("LC_") || entry[0].startsWith("XDG_")),
    ),
  );
}

/**
 * Resolve the openshell binary path.
 *
 * Checks `command -v` first (must return an absolute path to prevent alias
 * injection), then falls back to common installation directories.
 */
export function resolveOpenshell(opts: ResolveOpenshellOptions = {}): string | null {
  const home = opts.home ?? process.env.HOME;
  const checkExecutable =
    opts.checkExecutable ??
    ((p: string): boolean => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

  const override = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (override?.startsWith("/") && checkExecutable(override)) {
    return override;
  }

  // Step 1: command -v
  if (opts.commandVResult === undefined) {
    try {
      const found = execSync("command -v openshell", {
        encoding: "utf-8",
        env: buildSubprocessEnv(),
      }).trim();
      if (found.startsWith("/")) return found;
    } catch {
      /* ignored */
    }
  } else if (opts.commandVResult?.startsWith("/")) {
    return opts.commandVResult;
  }

  // Step 2: fallback candidates
  //
  // `/opt/homebrew/bin` is the Apple Silicon Homebrew prefix. It is frequently
  // absent from the non-interactive/login shell that drives onboarding (Homebrew
  // only adds it via `brew shellenv`, which many profiles source after the
  // non-interactive guard), so `command -v openshell` above can miss a perfectly
  // good Homebrew install. Probing the prefix directly keeps NemoClaw coherent
  // with a Homebrew-installed OpenShell instead of reporting "openshell not
  // found" while the binary sits in `/opt/homebrew/bin` (#5334).
  const candidates = [
    ...(home?.startsWith("/") ? [`${home}/.local/bin/openshell`] : []),
    "/opt/homebrew/bin/openshell",
    "/usr/local/bin/openshell",
    "/usr/bin/openshell",
  ];
  for (const p of candidates) {
    if (checkExecutable(p)) return p;
  }

  return null;
}
