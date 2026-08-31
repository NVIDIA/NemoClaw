// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const EMITTED_FILE_SUFFIXES = [".js", ".js.map", ".d.ts", ".d.ts.map"] as const;

const CLI_RETIRED_FILE_PREFIXES = [
  "dist/commands/deploy",
  "dist/lib/actions/deploy",
  "dist/lib/actions/sandbox/agent/connect-shields-relock-notice",
  "dist/lib/actions/sandbox/agent/passthrough-shields-warning",
  "dist/lib/actions/sandbox/backup-shields-window",
  "dist/lib/actions/sandbox/rebuild-shields-phase",
  "dist/lib/actions/sandbox/rebuild-shields",
  "dist/lib/domain/duration",
  "dist/lib/onboard/runtime-provider/container-state-mutation",
  "dist/lib/onboard/runtime-provider/docker-state-mutation",
  "dist/lib/onboard/runtime-provider/persisted-engine-lifecycle",
  "dist/lib/onboard/runtime-provider/podman-state-mutation",
  "dist/lib/onboard/runtime-provider/state-mutation",
  "dist/lib/state/mcp-lifecycle-lock/shields-timer-authority",
] as const;

const CLI_RETIRED_DIRECTORIES = [
  "dist/commands/sandbox/shields",
  "dist/lib/deploy",
  "dist/lib/shields",
] as const;

const PLUGIN_RETIRED_FILE_PREFIXES = ["dist/commands/shields-status"] as const;

function removeEmittedFiles(packageRoot: string, prefixes: readonly string[]): void {
  for (const prefix of prefixes) {
    for (const suffix of EMITTED_FILE_SUFFIXES) {
      fs.rmSync(path.join(packageRoot, `${prefix}${suffix}`), { force: true });
    }
  }
}

function pruneCli(packageRoot: string): void {
  removeEmittedFiles(packageRoot, CLI_RETIRED_FILE_PREFIXES);
  for (const directory of CLI_RETIRED_DIRECTORIES) {
    fs.rmSync(path.join(packageRoot, directory), { force: true, recursive: true });
  }
}

function prunePlugin(packageRoot: string): void {
  removeEmittedFiles(packageRoot, PLUGIN_RETIRED_FILE_PREFIXES);
}

const scope = process.argv[2];
if (scope === "cli") {
  pruneCli(process.cwd());
  prunePlugin(path.join(process.cwd(), "nemoclaw"));
} else if (scope === "plugin") {
  prunePlugin(process.cwd());
} else {
  throw new Error("usage: prune-retired-build-artifacts.mts <cli|plugin>");
}
