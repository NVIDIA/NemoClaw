// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildDockerDriverGatewayEnv } from "./docker-driver-gateway-env";

describe("buildDockerDriverGatewayEnv", () => {
  it("sets Docker-driver gateway networking from NemoClaw configuration", () => {
    const env = buildDockerDriverGatewayEnv({
      platform: "linux",
      stateDir: "/tmp/nemoclaw-gateway",
      getDockerSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:0.0.37",
      resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
    });

    expect(env).toMatchObject({
      OPENSHELL_DRIVERS: "docker",
      OPENSHELL_BIND_ADDRESS: "127.0.0.1",
      OPENSHELL_SERVER_PORT: "8080",
      OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
      OPENSHELL_LOCAL_TLS_DIR: "/tmp/nemoclaw-gateway/tls",
      OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
      OPENSHELL_SSH_GATEWAY_PORT: "8080",
      OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
      OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor:0.0.37",
      OPENSHELL_DOCKER_SUPERVISOR_BIN: "/usr/bin/openshell-sandbox",
      OPENSHELL_GATEWAY_CONFIG: "/tmp/nemoclaw-gateway/openshell-gateway.toml",
    });
    expect(env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
  });

  it("uses the Docker driver on macOS without VM helper state", () => {
    const env = buildDockerDriverGatewayEnv({
      platform: "darwin",
      stateDir: "/tmp/nemoclaw-gateway",
      getDockerSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:0.0.37",
      resolveSandboxBin: () => "/usr/local/bin/openshell-sandbox",
    });

    expect(env).toMatchObject({
      OPENSHELL_DRIVERS: "docker",
      OPENSHELL_BIND_ADDRESS: "127.0.0.1",
      OPENSHELL_SERVER_PORT: "8080",
      OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
      OPENSHELL_LOCAL_TLS_DIR: "/tmp/nemoclaw-gateway/tls",
      OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
      OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor:0.0.37",
      OPENSHELL_GATEWAY_CONFIG: "/tmp/nemoclaw-gateway/openshell-gateway.toml",
    });
    expect(env.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBeUndefined();
    expect(env.OPENSHELL_VM_DRIVER_STATE_DIR).toBeUndefined();
    expect(env.OPENSHELL_DRIVER_DIR).toBeUndefined();
  });
});
