// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS } from "./docker-driver-gateway-config";
import {
  assertDockerDriverGatewayAuthConfigSafe,
  assertDockerDriverGatewayBindAddressSafe,
} from "./docker-driver-gateway-env";
import { prepareNativePodmanGatewayHostRuntime } from "./runtime-provider/podman-runtime-surfaces";
import { writeSafeGatewayAuthConfig } from "../../../test/support/docker-driver-gateway-env-test-support";

describe("Docker-driver gateway env config validation", () => {
  it("rejects wildcard gateway binds while gateway JWT auth is active", () => {
    expect(() =>
      assertDockerDriverGatewayBindAddressSafe({
        OPENSHELL_BIND_ADDRESS: "0.0.0.0",
        OPENSHELL_GATEWAY_CONFIG: "/tmp/openshell-gateway.toml",
      }),
    ).toThrow(/not supported for the OpenShell Docker-driver gateway/);
  });

  it("validates a wildcard bind against the explicit native Podman runtime", () => {
    const runtime = prepareNativePodmanGatewayHostRuntime({
      environment: { OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock" },
      platform: "linux",
    });
    const gatewayEnv = {
      OPENSHELL_BIND_ADDRESS: runtime.bindAddress,
      OPENSHELL_GRPC_ENDPOINT: `https://${runtime.grpcHost}:8080`,
      OPENSHELL_SERVER_PORT: "8080",
      OPENSHELL_SSH_GATEWAY_HOST: runtime.sshGatewayHost,
    };

    expect(() =>
      assertDockerDriverGatewayBindAddressSafe(
        gatewayEnv,
        { NEMOCLAW_GATEWAY_RUNTIME: "docker" },
        "linux",
        runtime,
      ),
    ).not.toThrow();
  });

  it("validates generated gateway auth config before runtime startup", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    try {
      const configPath = writeSafeGatewayAuthConfig(stateDir);

      expect(() =>
        assertDockerDriverGatewayAuthConfigSafe({
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
          OPENSHELL_GATEWAY_CONFIG: configPath,
        }),
      ).not.toThrow();

      fs.writeFileSync(
        configPath,
        fs
          .readFileSync(configPath, "utf-8")
          .replace("allow_unauthenticated_users = false", "allow_unauthenticated_users = true"),
      );
      expect(() =>
        assertDockerDriverGatewayAuthConfigSafe({
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
          OPENSHELL_GATEWAY_CONFIG: configPath,
        }),
      ).toThrow(/allow_unauthenticated_users=false/);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["signing_key_path", "public_key_path", "kid_path", "gateway_id", "ttl_secs"])(
    "rejects a config missing gateway_jwt.$key",
    (key) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
      try {
        const configPath = writeSafeGatewayAuthConfig(stateDir);
        const config = fs
          .readFileSync(configPath, "utf-8")
          .replace(new RegExp(`^${key} = .+\\n`, "m"), "");
        fs.writeFileSync(configPath, config);

        expect(() =>
          assertDockerDriverGatewayAuthConfigSafe({
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: configPath,
          }),
        ).toThrow(new RegExp(`gateway_jwt\\.${key}`));
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("rejects a gateway JWT TTL outside NemoClaw's bounded value", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    try {
      const configPath = writeSafeGatewayAuthConfig(stateDir);
      fs.writeFileSync(
        configPath,
        fs
          .readFileSync(configPath, "utf-8")
          .replace(`ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`, "ttl_secs = 7200"),
      );

      expect(() =>
        assertDockerDriverGatewayAuthConfigSafe({
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
          OPENSHELL_GATEWAY_CONFIG: configPath,
        }),
      ).toThrow(`gateway_jwt.ttl_secs=${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects gateway JWT paths whose referenced file is absent", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    try {
      const configPath = writeSafeGatewayAuthConfig(stateDir);
      fs.rmSync(path.join(stateDir, "jwt", "kid"));

      expect(() =>
        assertDockerDriverGatewayAuthConfigSafe({
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
          OPENSHELL_GATEWAY_CONFIG: configPath,
        }),
      ).toThrow(/gateway_jwt\.kid_path must reference an existing readable file/);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
