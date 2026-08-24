// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "./clients/command.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";

export type DockerBuildGuard = {
  readonly env: NodeJS.ProcessEnv;
  readonly tracePath: string;
  readonly dispose: () => void;
};

export function createDockerBuildGuard(): DockerBuildGuard {
  const realDocker = execFileSync("bash", ["-lc", "command -v docker"], {
    encoding: "utf8",
    env: buildAvailabilityProbeEnv(),
    killSignal: "SIGKILL",
    timeout: 10_000,
  }).trim();
  if (!path.isAbsolute(realDocker) || !fs.statSync(realDocker).isFile()) {
    throw new Error("Docker build guard requires one absolute Docker CLI");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-build-guard-"));
  const tracePath = path.join(root, "docker-argv.log");
  const shimPath = path.join(root, "docker");
  fs.writeFileSync(
    shimPath,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      `trace=${shellQuote(tracePath)}`,
      'printf \'%q \' "$@" >>"$trace"',
      "printf '\\n' >>\"$trace\"",
      "previous=",
      'for argument in "$@"; do',
      '  if [[ "$argument" == build || ("$previous" == buildx && "$argument" == bake) ]]; then',
      "    echo 'Qualification attempted a forbidden Dockerfile build' >&2",
      "    exit 97",
      "  fi",
      '  previous="$argument"',
      "done",
      `exec ${shellQuote(realDocker)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const baseEnv = buildAvailabilityProbeEnv();
  return {
    env: { ...baseEnv, PATH: `${root}:${baseEnv.PATH ?? ""}` },
    tracePath,
    dispose: () => fs.rmSync(root, { force: true, recursive: true }),
  };
}

export function assertNoDockerfileBuild(trace: string): void {
  if (/(?:^|\s)build(?:\s|$)|(?:^|\s)buildx\s+bake(?:\s|$)/u.test(trace)) {
    throw new Error("Qualification used a forbidden Dockerfile build");
  }
}
