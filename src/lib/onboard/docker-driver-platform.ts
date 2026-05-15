// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function isLinuxDockerDriverGatewayEnabled(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  return platform === "linux" || (platform === "darwin" && arch === "arm64");
}

export function isLinuxDockerDriverGatewayPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux";
}
