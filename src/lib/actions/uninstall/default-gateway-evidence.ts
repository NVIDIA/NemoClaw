// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_GATEWAY_PORT } from "../../core/ports";
import { resolveGatewayStateDirForPort } from "../../onboard/gateway-binding";
import { DOCKER_DRIVER_GATEWAY_CONFIG_NAME } from "../../onboard/docker-driver-gateway-config";
import { readGatewayRegistryFile, registryEntryGatewayPort } from "../../state/gateway-registry";

/** Evidence that the shared state root actually owns a default-port gateway. */
export function hasDefaultGatewayEvidence(home: string): boolean {
  const registry = readGatewayRegistryFile(home, path.join(home, ".nemoclaw", "sandboxes.json"));
  if (
    registry &&
    Object.values(registry.sandboxes).some(
      (entry) => registryEntryGatewayPort(entry) === DEFAULT_GATEWAY_PORT,
    )
  ) {
    return true;
  }
  const stateDir = resolveGatewayStateDirForPort({ home, port: DEFAULT_GATEWAY_PORT });
  return (
    fs
      .lstatSync(path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME), {
        throwIfNoEntry: false,
      })
      ?.isFile() === true
  );
}
