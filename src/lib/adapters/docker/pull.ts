// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerRun, type DockerRunOptions, type DockerRunResult } from "./run";

export function dockerPull(imageRef: string, opts: DockerRunOptions = {}): DockerRunResult {
  return dockerRun(["pull", imageRef], opts);
}
