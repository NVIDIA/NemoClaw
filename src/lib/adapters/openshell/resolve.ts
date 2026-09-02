// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { buildSubprocessEnv, isSubprocessEnvNameAllowed } from "../../subprocess-env";

export interface ResolveOpenshellOptions {
  /** Mock result for `command -v` (undefined = run real command). */
  commandVResult?: string | null;
  /** Override executable check (default: fs.accessSync X_OK). */
  checkExecutable?: (path: string) => boolean;
  /** HOME directory override. */
  home?: string;
  /** Environment used only for an explicitly authority-bound resolution. */
  env?: NodeJS.ProcessEnv;
}

/** Build the actionable diagnostic used when OpenShell cannot be resolved. */
export function openshellNotFoundDiagnosticLines(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const checked: string[] = [];
  const override = sourceEnv.NEMOCLAW_OPENSHELL_BIN;
  if (override) checked.push(`NEMOCLAW_OPENSHELL_BIN=${override}`);
  checked.push(
    sourceEnv.PATH
      ? `PATH=${sourceEnv.PATH} (via \`command -v openshell\`)`
      : "PATH=<unset> (via `command -v openshell`)",
  );
  if (sourceEnv.HOME?.startsWith("/")) {
    checked.push(`${sourceEnv.HOME}/.local/bin/openshell`);
  }
  checked.push(
    "/opt/homebrew/bin/openshell",
    "/usr/local/bin/openshell",
    "/usr/bin/openshell",
  );
  return [
    "  openshell binary not found. Checked:",
    ...checked.map((location) => `    - ${location}`),
    "  Install OpenShell (https://github.com/NVIDIA/OpenShell) or set NEMOCLAW_OPENSHELL_BIN to an absolute, executable path.",
  ];
}

/**
 * Resolve the openshell binary path.
 *
 * Checks `command -v` first (must return an absolute path to prevent alias
 * injection), then falls back to common installation directories.
 */
export function resolveOpenshell(opts: ResolveOpenshellOptions = {}): string | null {
  const sourceEnv = opts.env ?? process.env;
  const home = opts.home ?? sourceEnv.HOME;
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

  const override = sourceEnv.NEMOCLAW_OPENSHELL_BIN;
  if (override?.startsWith("/") && checkExecutable(override)) {
    return override;
  }

  // Step 1: command -v
  if (opts.commandVResult === undefined) {
    try {
      const resolutionEnv = Object.fromEntries(
        Object.entries(sourceEnv).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && isSubprocessEnvNameAllowed(entry[0]),
        ),
      );
      const found = execSync("command -v openshell", {
        encoding: "utf-8",
        env: buildSubprocessEnv(resolutionEnv),
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
