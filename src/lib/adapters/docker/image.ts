// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ROOT } from "../../runner";
import { dockerCapture, dockerRun, type DockerCaptureOptions, type DockerRunOptions } from "./run";

export function dockerBuild(
  dockerfilePath: string,
  tag: string,
  contextDir: string = ROOT,
  opts: DockerRunOptions = {},
) {
  // Dockerfile.base relies on `RUN --mount=type=bind`, which is BuildKit-only.
  // Hosts whose Docker daemon defaults to the legacy builder (e.g. fresh
  // Debian/Ubuntu Docker 29 without /etc/docker/daemon.json) abort the
  // sandbox-base local rebuild with "the --mount option requires BuildKit"
  // (#3583). Force-enable BuildKit for every `dockerBuild` callsite so the
  // rebuild path works regardless of daemon defaults.
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? {}) };
  if (env.DOCKER_BUILDKIT === undefined) env.DOCKER_BUILDKIT = "1";
  return dockerRun(["build", "-f", dockerfilePath, "-t", tag, contextDir], {
    ...opts,
    env,
  });
}

export function dockerRmi(imageRef: string, opts: DockerRunOptions = {}) {
  return dockerRun(["rmi", imageRef], opts);
}

export function dockerListImagesFormat(
  reference: string,
  format: string,
  opts: DockerCaptureOptions = {},
): string {
  return dockerCapture(["images", "--filter", `reference=${reference}`, "--format", format], opts);
}
