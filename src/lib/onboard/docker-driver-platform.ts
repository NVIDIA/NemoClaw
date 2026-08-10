// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveCurrentOpenShellComputePlan, usesManagedDockerGateway } from "./compute/plan";

export { resolveCurrentOpenShellComputePlan } from "./compute/plan";

export {
  type ExperimentalOnboardProfile,
  EXPERIMENTAL_PROFILE_ENV,
  isPortableExperimentalProfile,
  PORTABLE_EXPERIMENTAL_PROFILE,
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_LOCAL_REGISTRY,
  resolveExperimentalOnboardProfile,
} from "./experimental/portable-profile";

export function isLinuxDockerDriverGatewayEnabled(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  return usesManagedDockerGateway(resolveCurrentOpenShellComputePlan(platform, arch));
}
