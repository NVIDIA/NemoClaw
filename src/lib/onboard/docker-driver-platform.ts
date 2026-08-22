// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveCurrentOpenShellComputePlan, usesManagedLocalGateway } from "./compute/plan";

export { resolveCurrentOpenShellComputePlan } from "./compute/plan";

export {
  DEFAULT_DOCKER_DRIVER_NETWORK_NAME,
  type DockerNetworkIpamEntry,
  DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
  parseDockerNetworkIpamEntries,
  resolveDockerDriverNetworkName,
} from "./experimental/docker-network-authority";

export {
  type ExperimentalOnboardProfile,
  EXPERIMENTAL_PROFILE_ENV,
  isPortableExperimentalProfile,
  PORTABLE_DOCKER_NETWORK_NAME,
  PORTABLE_DOCKER_NETWORK_SUBNET,
  PORTABLE_EXPERIMENTAL_PROFILE,
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_LOCAL_REGISTRY,
  PORTABLE_REGISTRY_IP,
  resolveExperimentalOnboardProfile,
} from "./experimental/portable-profile";

export function isLinuxDockerDriverGatewayEnabled(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  return usesManagedLocalGateway(resolveCurrentOpenShellComputePlan(platform, arch));
}
