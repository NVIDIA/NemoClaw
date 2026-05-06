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
  return dockerRun(["build", "-f", dockerfilePath, "-t", tag, contextDir], opts);
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
