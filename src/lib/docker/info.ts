// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, type DockerCaptureOptions } from "./run";

export function dockerInfo(opts: DockerCaptureOptions = {}): string {
  return dockerCapture(["info"], opts);
}

export function dockerInfoFormat(format: string, opts: DockerCaptureOptions = {}): string {
  return dockerCapture(["info", "--format", format], opts);
}
