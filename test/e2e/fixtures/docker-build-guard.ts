// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "./clients/command.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";

export type ContainerBuildGuard = {
  readonly env: NodeJS.ProcessEnv;
  readonly tracePath: string;
  readonly dispose: () => void;
};

export type DockerBuildGuard = ContainerBuildGuard;

type GuardedContainerEngine = "docker" | "podman";

const LOCAL_IMAGE_BUILD_PATTERN = /(?:^|\s)build(?:\s|$)|(?:^|\s)buildx\s+bake(?:\s|$)/u;

export function createContainerBuildGuard(
  containerEngine: GuardedContainerEngine,
): ContainerBuildGuard {
  const realExecutable = execFileSync(
    "bash",
    ["-lc", 'command -v "$1"', "nemoclaw-container-build-guard", containerEngine],
    {
      encoding: "utf8",
      env: buildAvailabilityProbeEnv(),
      killSignal: "SIGKILL",
      timeout: 10_000,
    },
  ).trim();
  if (!path.isAbsolute(realExecutable) || !fs.statSync(realExecutable).isFile()) {
    throw new Error(
      `${containerEngine === "docker" ? "Docker" : "Podman"} build guard requires one absolute CLI`,
    );
  }
  const guardParent = containerEngine === "podman" ? fs.realpathSync(os.homedir()) : os.tmpdir();
  const root = fs.mkdtempSync(path.join(guardParent, `.nemoclaw-${containerEngine}-build-guard-`));
  const tracePath = path.join(root, `${containerEngine}-argv.log`);
  const shimPath = path.join(root, containerEngine);
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
      `    echo 'Qualification attempted a forbidden ${containerEngine} image build' >&2`,
      "    exit 97",
      "  fi",
      '  previous="$argument"',
      "done",
      `exec ${shellQuote(realExecutable)} "$@"`,
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

export function createDockerBuildGuard(): DockerBuildGuard {
  return createContainerBuildGuard("docker");
}

export function countLocalImageBuildCommands(trace: string): number {
  return trace.split("\n").filter((line) => LOCAL_IMAGE_BUILD_PATTERN.test(line)).length;
}

export function assertNoLocalImageBuild(
  trace: string,
  containerEngine: GuardedContainerEngine,
): void {
  if (countLocalImageBuildCommands(trace) > 0) {
    throw new Error(`Qualification used a forbidden ${containerEngine} image build`);
  }
}

export function assertNoDockerfileBuild(trace: string): void {
  if (countLocalImageBuildCommands(trace) > 0) {
    throw new Error("Qualification used a forbidden Dockerfile build");
  }
}
