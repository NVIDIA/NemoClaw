// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DOCKERFILE = path.join(import.meta.dirname, "..", "..", "Dockerfile");

export const CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION = "2026.6.10";

export function dockerRunCommandBetween(startMarker: string, endMarker: string): string {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile block between ${startMarker} and ${endMarker}`);
  }
  const runIndex = dockerfile.indexOf("RUN ", start);
  if (runIndex === -1 || runIndex > end) {
    throw new Error(`Expected RUN instruction after ${startMarker}`);
  }
  return dockerfile
    .slice(runIndex, end)
    .trim()
    .replace(/^RUN\s+/, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .replace(/\\\s*$/, "");
}

function createSedWrapper(tmp: string): string {
  const fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const sedWrapper = path.join(fakeBin, "sed");
  fs.writeFileSync(
    sedWrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "-i" ]; then',
      "  extended=0",
      '  if [ "${2:-}" = "-E" ]; then',
      "    extended=1",
      "    expr=$3",
      "    shift 3",
      "  else",
      "    expr=$2",
      "    shift 2",
      "  fi",
      '  for file in "$@"; do',
      "    tmp=$(mktemp)",
      '    if [ "$extended" = "1" ]; then',
      '      /usr/bin/sed -E "$expr" "$file" > "$tmp"',
      "    else",
      '      /usr/bin/sed "$expr" "$file" > "$tmp"',
      "    fi",
      '    mv "$tmp" "$file"',
      "  done",
      "  exit 0",
      "fi",
      'exec /usr/bin/sed "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeBin;
}

export function runDockerfilePatchBlock(
  dist: string,
  tmp: string,
  endMarker: string,
  version = CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
) {
  const command = dockerRunCommandBetween(
    "# Patch OpenClaw media fetch for proxy-only sandbox",
    endMarker,
  ).replaceAll("/usr/local/lib/node_modules/openclaw/dist", dist);
  const scriptPath = path.join(tmp, "patch.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `openclaw() { if [ "\${1:-}" = "--version" ]; then printf 'OpenClaw ${version}\\n'; else return 127; fi; }`,
      command,
    ].join("\n"),
    { mode: 0o700 },
  );
  const fakeBin = createSedWrapper(tmp);
  return spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    timeout: 10000,
  });
}

export function runFetchGuardPatchBlock(
  dist: string,
  tmp: string,
  version = CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
) {
  return runDockerfilePatchBlock(
    dist,
    tmp,
    "# --- Patch 3: follow symlinks in plugin-install path checks (#2203)",
    version,
  );
}
