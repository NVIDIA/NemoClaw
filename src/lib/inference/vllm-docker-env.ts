// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildSubprocessEnv } from "../subprocess-env";

const DOCKER_CLIENT_ENV_NAMES = [
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
] as const;

/**
 * Use one Docker client selection for every managed-vLLM subprocess while
 * retaining the repository's child-process environment sanitization.
 */
export function buildVllmDockerEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const dockerEnv: Record<string, string> = {};
  for (const name of DOCKER_CLIENT_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) dockerEnv[name] = value;
  }
  const env = buildSubprocessEnv({ ...dockerEnv, ...extra });
  for (const name of DOCKER_CLIENT_ENV_NAMES) {
    if (source[name] === undefined && extra[name] === undefined) delete env[name];
  }
  return env;
}
