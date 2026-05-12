// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildDockerDriverGatewayEnv,
  buildDockerGatewayDebEnvFile,
} from "./docker-driver-gateway-env";

describe("buildDockerDriverGatewayEnv", () => {
  it("sets Docker-driver gateway networking from NemoClaw configuration", () => {
    expect(
      buildDockerDriverGatewayEnv({
        platform: "linux",
        stateDir: "/tmp/nemoclaw-gateway",
        getDockerSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:0.0.37",
        resolveVmDriverBin: () => null,
        resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
      }),
    ).toMatchObject({
      OPENSHELL_BIND_ADDRESS: "127.0.0.1",
      OPENSHELL_SERVER_PORT: "8080",
      OPENSHELL_GRPC_ENDPOINT: "http://127.0.0.1:8080",
      OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
      OPENSHELL_SSH_GATEWAY_PORT: "8080",
    });
  });
});

describe("buildDockerGatewayDebEnvFile", () => {
  it("replaces all managed gateway env keys and preserves unrelated values", () => {
    const next = buildDockerGatewayDebEnvFile(
      [
        "KEEP_ME=1",
        "OPENSHELL_BIND_ADDRESS=127.0.0.1",
        "OPENSHELL_SERVER_PORT=8080",
        "OPENSHELL_DOCKER_SUPERVISOR_IMAGE=old",
      ].join("\n"),
      {
        OPENSHELL_DRIVERS: "docker",
        OPENSHELL_BIND_ADDRESS: "0.0.0.0",
        OPENSHELL_SERVER_PORT: "8990",
        OPENSHELL_DISABLE_TLS: "true",
        OPENSHELL_DISABLE_GATEWAY_AUTH: "true",
        OPENSHELL_DB_URL: "sqlite:/tmp/openshell.db",
        OPENSHELL_GRPC_ENDPOINT: "http://127.0.0.1:8990",
        OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
        OPENSHELL_SSH_GATEWAY_PORT: "8990",
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "new",
      },
    );

    expect(next).toContain("KEEP_ME=1\n");
    expect(next).toContain("OPENSHELL_BIND_ADDRESS=0.0.0.0\n");
    expect(next).toContain("OPENSHELL_SERVER_PORT=8990\n");
    expect(next).toContain("OPENSHELL_DOCKER_SUPERVISOR_IMAGE=new\n");
    expect(next).not.toContain("OPENSHELL_BIND_ADDRESS=127.0.0.1");
    expect(next).not.toContain("OPENSHELL_DOCKER_SUPERVISOR_IMAGE=old");
  });
});
