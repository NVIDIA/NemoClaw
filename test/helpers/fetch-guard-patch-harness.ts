// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "../../src/lib/core/shell-quote";
import { OPENCLAW_WORKER_PROXY_SOURCE } from "../fixtures/openclaw-worker-proxy";

const DOCKERFILE = path.join(import.meta.dirname, "..", "..", "Dockerfile");
const OPENCLAW_VERSION_EXTRACTOR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "extract-semver.sh",
);

export const CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION = "2026.9.5";

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
    .replace(/^(?:--[a-z-]+=[^\s]+\s+)+/u, "")
    .replace(/\\\s*$/, "")
    .replaceAll(
      "/usr/local/lib/nemoclaw/extract-semver",
      JSON.stringify(OPENCLAW_VERSION_EXTRACTOR),
    );
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

function prepareReviewedWorkerFixture(dist: string): void {
  // Legacy regular-module shapes still exercise the classifier independently;
  // the shipped patch block also requires the pinned 9.5 worker distribution.
  const worker = path.join(dist, "worker", "worker.mjs");
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  try {
    fs.writeFileSync(worker, OPENCLAW_WORKER_PROXY_SOURCE, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  const manifest = fs.openSync(
    path.join(dist, "..", "package.json"),
    fs.constants.O_RDWR | fs.constants.O_CREAT,
    0o600,
  );
  try {
    const source = fs.readFileSync(manifest, "utf8");
    const metadata = source ? JSON.parse(source) : {};
    const updated = Buffer.from(JSON.stringify({ ...metadata, version: "2026.9.5" }));
    fs.writeSync(manifest, updated, 0, updated.length, 0);
    fs.ftruncateSync(manifest, updated.length);
  } finally {
    fs.closeSync(manifest);
  }
}

export function runDockerfilePatchBlock(
  dist: string,
  tmp: string,
  endMarker: string,
  version = CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
) {
  prepareReviewedWorkerFixture(dist);
  const command = dockerRunCommandBetween(
    "# Patch OpenClaw media fetch for proxy-only sandbox",
    endMarker,
  )
    .replaceAll("/usr/local/lib/node_modules/openclaw/dist", dist)
    .replaceAll(
      "/usr/local/lib/nemoclaw/patch-openclaw-explicit-proxy.mts",
      shellQuote(
        path.join(import.meta.dirname, "../../scripts/lib/patch-openclaw-explicit-proxy.mts"),
      ),
    )
    .replaceAll(
      "/usr/local/lib/nemoclaw/patch-openclaw-worker-proxy.mts",
      JSON.stringify(
        path.join(import.meta.dirname, "../../scripts/lib/patch-openclaw-worker-proxy.mts"),
      ),
    );
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
