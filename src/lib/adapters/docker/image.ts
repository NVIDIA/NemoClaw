// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ROOT } from "../../runner";
import {
  type DockerCaptureOptions,
  type DockerRunOptions,
  type DockerRunResult,
  dockerCapture,
  dockerRun,
} from "./run";

export type DockerBuildOptions = DockerRunOptions & {
  labels?: Record<string, string>;
  quiet?: boolean;
};

export function dockerBuild(
  dockerfilePath: string,
  tag: string,
  contextDir: string = ROOT,
  opts: DockerBuildOptions = {},
): DockerRunResult {
  const { labels, quiet, ...rest } = opts;
  // Dockerfile.base relies on `RUN --mount=type=bind`, which is BuildKit-only.
  // Hosts whose Docker daemon defaults to the legacy builder (e.g. fresh
  // Debian/Ubuntu Docker 29 without /etc/docker/daemon.json) abort the
  // sandbox-base local rebuild with "the --mount option requires BuildKit"
  // (#3583). Force-enable BuildKit for every `dockerBuild` callsite so the
  // rebuild path works regardless of daemon defaults.
  const env: NodeJS.ProcessEnv = { ...(rest.env ?? {}) };
  if (env.DOCKER_BUILDKIT === undefined) env.DOCKER_BUILDKIT = "1";
  const args = [
    "build",
    ...(quiet ? ["--quiet"] : []),
    ...Object.entries(labels ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "-f",
    dockerfilePath,
    "-t",
    tag,
    contextDir,
  ];
  return dockerRun(args, { ...rest, env });
}

export function dockerRmi(imageRef: string, opts: DockerRunOptions = {}): DockerRunResult {
  return dockerRun(["rmi", imageRef], opts);
}

export function dockerTag(
  source: string,
  target: string,
  opts: DockerRunOptions = {},
): DockerRunResult {
  return dockerRun(["tag", source, target], opts);
}

export function dockerListImagesFormat(
  reference: string,
  format: string,
  opts: DockerCaptureOptions = {},
): string {
  return dockerCapture(["images", "--filter", `reference=${reference}`, "--format", format], opts);
}
