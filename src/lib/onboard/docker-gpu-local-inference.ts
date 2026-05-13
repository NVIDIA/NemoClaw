// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getLocalProviderValidationBaseUrl,
  LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV,
} from "../inference/local";
import { getDockerGpuPatchNetworkMode, shouldApplyDockerGpuPatch } from "./docker-gpu-patch";

const {
  LOCAL_INFERENCE_PROVIDERS,
}: { LOCAL_INFERENCE_PROVIDERS: string[] } = require("./providers");

type DockerGpuLocalInferenceConfig = {
  sandboxGpuEnabled: boolean;
  sandboxGpuDevice?: string | null;
};

type DockerGpuLocalInferenceOptions = {
  dockerDriverGateway: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

export function shouldUseDockerGpuPatchHostNetwork(
  config: DockerGpuLocalInferenceConfig,
  options: DockerGpuLocalInferenceOptions,
): boolean {
  return (
    shouldApplyDockerGpuPatch(config, { dockerDriverGateway: options.dockerDriverGateway }) &&
    getDockerGpuPatchNetworkMode(options.env ?? process.env) === "host"
  );
}

export function configureLocalInferenceForDockerGpuHostNetwork(
  config: DockerGpuLocalInferenceConfig,
  options: DockerGpuLocalInferenceOptions & { note: (message: string) => void },
): void {
  const env = options.env ?? process.env;
  if (!shouldUseDockerGpuPatchHostNetwork(config, options)) return;
  if (!env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV]) {
    env[LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV] = "http://127.0.0.1";
    options.note(
      "  Docker-driver GPU patch will use host networking; local inference providers will use sandbox loopback.",
    );
    return;
  }
  options.note(
    `  Docker-driver GPU patch will use host networking; local inference providers will use ${LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV}.`,
  );
}

export function dockerGpuPatchHostNetworkInferenceBaseUrl(
  config: DockerGpuLocalInferenceConfig,
  provider: string | null | undefined,
  options: DockerGpuLocalInferenceOptions,
): string | null {
  if (!shouldUseDockerGpuPatchHostNetwork(config, options)) return null;
  if (!provider || !LOCAL_INFERENCE_PROVIDERS.includes(provider)) return null;
  const baseUrl = getLocalProviderValidationBaseUrl(provider);
  if (baseUrl) {
    options.log?.(
      `  Docker-driver GPU host networking: OpenClaw local inference will use direct sandbox URL ${baseUrl}.`,
    );
  }
  return baseUrl;
}
