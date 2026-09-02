// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { DOCKER_DRIVER_GATEWAY_CONFIG_NAME } from "../../onboard/docker-driver-gateway-config";
import { getDockerDriverGatewayRuntimeMarkerPath } from "../../onboard/docker-driver-gateway-runtime-marker";

const MAX_GATEWAY_IDENTITY_FILE_BYTES = 64 * 1024;

export interface PrivateGatewayRuntimeFile {
  path: string;
  bytes: Buffer;
}

function readPrivateGatewayRuntimeFile(filePath: string): PrivateGatewayRuntimeFile {
  const file = openRegularFileNoFollow(filePath);
  try {
    const state = file.stat();
    if ((state.mode & 0o077) !== 0) {
      throw new Error("file is not private");
    }
    return {
      path: filePath,
      bytes: file.readBytes(MAX_GATEWAY_IDENTITY_FILE_BYTES),
    };
  } finally {
    file.close();
  }
}

export function readPrivateGatewayConfig(stateDir: string): PrivateGatewayRuntimeFile {
  return readPrivateGatewayRuntimeFile(path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME));
}

export function readPrivateGatewayRuntimeMarker(stateDir: string): PrivateGatewayRuntimeFile {
  return readPrivateGatewayRuntimeFile(getDockerDriverGatewayRuntimeMarkerPath(stateDir));
}
