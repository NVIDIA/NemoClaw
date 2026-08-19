// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_DOCKER_DRIVER_NETWORK_NAME } from "./docker-network-authority";

export const EXPERIMENTAL_PROFILE_ENV = "NEMOCLAW_EXPERIMENTAL_PROFILE";
export const PORTABLE_EXPERIMENTAL_PROFILE = "portable";
export const PORTABLE_HOST_GATEWAY_IP = "169.254.1.2";
export const PORTABLE_REGISTRY_IP = "169.254.1.3";
export const PORTABLE_DOCKER_NETWORK_NAME = DEFAULT_DOCKER_DRIVER_NETWORK_NAME;
export const PORTABLE_DOCKER_NETWORK_SUBNET = "169.254.1.0/24";
export const PORTABLE_LOCAL_REGISTRY = "localhost:5000";

export type ExperimentalOnboardProfile = typeof PORTABLE_EXPERIMENTAL_PROFILE;

export function resolveExperimentalOnboardProfile(
  env: NodeJS.ProcessEnv = process.env,
): ExperimentalOnboardProfile | null {
  return env[EXPERIMENTAL_PROFILE_ENV] === PORTABLE_EXPERIMENTAL_PROFILE
    ? PORTABLE_EXPERIMENTAL_PROFILE
    : null;
}

export function isPortableExperimentalProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveExperimentalOnboardProfile(env) === PORTABLE_EXPERIMENTAL_PROFILE;
}
