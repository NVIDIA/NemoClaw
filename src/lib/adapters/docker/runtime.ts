// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { retryUntil } from "../../core/retry";
import { sleepMs } from "../../core/wait";
import type { ContainerRuntime } from "../../platform";
import { inferContainerRuntime } from "../../platform";
import { dockerInfo } from "./info";
import type { DockerCaptureOptions } from "./run";

export const DOCKER_INFO_RUNTIME_PROBE_ATTEMPTS = 3;
export const DOCKER_INFO_RUNTIME_PROBE_RETRY_DELAY_MS = 250;
export const DOCKER_INFO_RUNTIME_PROBE_TIMEOUT_MS = 5000;

type DockerInfoProbe = (opts: DockerCaptureOptions) => string;

export interface DetectContainerRuntimeOptions {
  attempts?: number;
  dockerInfoImpl?: DockerInfoProbe;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => void;
}

export function detectContainerRuntimeFromDockerInfo(
  opts: DetectContainerRuntimeOptions = {},
): ContainerRuntime {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? DOCKER_INFO_RUNTIME_PROBE_ATTEMPTS));
  const timeout = Math.max(1, Math.floor(opts.timeoutMs ?? DOCKER_INFO_RUNTIME_PROBE_TIMEOUT_MS));
  const probe = opts.dockerInfoImpl ?? dockerInfo;

  return retryUntil(() => inferContainerRuntime(probe({ ignoreError: true, timeout })), {
    accept: (runtime) => runtime !== "unknown",
    retryDelaysMs: Array.from(
      { length: attempts - 1 },
      () => DOCKER_INFO_RUNTIME_PROBE_RETRY_DELAY_MS,
    ),
    sleep: opts.sleep ?? sleepMs,
  });
}
