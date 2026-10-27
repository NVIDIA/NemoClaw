// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseGatewayEnv } from "../../../test/support/openshell-gateway-config-helpers";
import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
} from "./docker-driver-gateway-config";
import { assertDockerDriverGatewayAuthConfigSafe } from "./docker-driver-gateway-env";
import { prepareNativePodmanGatewayHostRuntime } from "./runtime-provider/podman-runtime-surfaces";

const runtime = vi.hoisted(() => ({ version: "0.1.3" }));
vi.mock("./openshell-version", async (original) => ({
  ...(await original<typeof import("./openshell-version")>()),
  get SUPPORTED_OPENSHELL_FALLBACK_VERSION() {
    return runtime.version;
  },
}));

describe.each(["0.1.3", "0.1.5"])("OpenShell %s projection", (version) => {
  beforeEach(() => {
    runtime.version = version;
  });

  it.each(["docker", "podman"] as const)(
    "writes the projected gateway schema for %s without legacy credential fields",
    (driver) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-projected-"));
      try {
        const env = baseGatewayEnv(root);
        const runtime =
          driver === "podman"
            ? prepareNativePodmanGatewayHostRuntime({
                environment: { ...env, OPENSHELL_DRIVERS: "podman" },
                platform: "linux",
                socketPath: path.join(root, "podman.sock"),
              })
            : undefined;
        const toml = buildDockerDriverGatewayConfigToml(
          env,
          "/usr/bin/openshell-sandbox",
          ensureDockerDriverGatewayJwtBundle(root),
          "projected-gateway",
          runtime,
        );
        const configPath = path.join(root, "openshell-gateway.toml");
        fs.writeFileSync(configPath, toml);
        const validate = (environment: NodeJS.ProcessEnv = {}) =>
          assertDockerDriverGatewayAuthConfigSafe(
            { ...env, OPENSHELL_GATEWAY_CONFIG: configPath },
            environment,
            "linux",
            runtime,
          );
        expect(() => validate()).not.toThrow();
        expect(() => validate({ OPENSHELL_OIDC_ISSUER: "https://issuer.example" })).toThrow(
          "without OIDC overrides",
        );
        fs.writeFileSync(configPath, toml);
        const parsed = parse(toml) as unknown as {
          openshell: {
            version: number;
            gateway: Record<string, unknown>;
            drivers: Record<string, Record<string, unknown>>;
          };
        };
        expect(parsed.openshell).toMatchObject({
          version: 2,
          gateway: {
            compute_driver: driver,
            disable_tls: false,
            guest_tls_ca: path.join(root, "tls", "ca.crt"),
            mtls_auth: { enabled: true },
            auth: { allow_unauthenticated_users: false },
          },
        });
        expect(toml).not.toMatch(
          /compute_drivers|guest_tls_cert|guest_tls_key|require_client_auth|ttl_secs|sandbox_namespace/,
        );
        expect(parsed.openshell.drivers[driver]).toMatchObject({ allow_driver_config: true });
        expect(parsed.openshell.drivers[driver].network_name).toBe(
          driver === "podman" ? env.OPENSHELL_DOCKER_NETWORK_NAME : undefined,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["legacy schema", "version = 2", "version = 1", "openshell.version=2"],
    ["disabled TLS", "disable_tls = false", "disable_tls = true", "disable_tls=false"],
    ["disabled mTLS", "enabled = true", "enabled = false", "mtls_auth.enabled=true"],
    [
      "unauthenticated users",
      "allow_unauthenticated_users = false",
      "allow_unauthenticated_users = true",
      "allow_unauthenticated_users=false",
    ],
    [
      "retired client-auth switch",
      "[openshell.gateway.tls]",
      "[openshell.gateway.tls]\nrequire_client_auth = true",
      "without OIDC overrides",
    ],
    [
      "explicit TTL",
      "[openshell.gateway.gateway_jwt]",
      "[openshell.gateway.gateway_jwt]\nttl_secs = 0",
      "must omit gateway_jwt.ttl_secs",
    ],
    [
      "malformed OIDC issuer",
      "[openshell.gateway.tls]",
      '[openshell.gateway.oidc]\nissuer = ["invalid"]\n[openshell.gateway.tls]',
      "without OIDC overrides",
    ],
    [
      "quoted OIDC issuer",
      "[openshell.gateway.tls]",
      '[openshell.gateway.oidc] # alternate syntax\n"issuer" = "https://issuer.example"\n[openshell.gateway.tls]',
      "without OIDC overrides",
    ],
    [
      "quoted TTL",
      "[openshell.gateway.gateway_jwt]",
      '[openshell.gateway.gateway_jwt] # quoted field\n"ttl_secs" = 0',
      "must omit gateway_jwt.ttl_secs",
    ],
    [
      "relative client CA",
      /client_ca_path = "[^"\n]+"/,
      'client_ca_path = "relative.crt"',
      "must be an absolute TLS path",
    ],
  ] as const)("rejects projected gateway config with %s", (_label, source, replacement, error) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-auth-projected-"));
    try {
      const env = baseGatewayEnv(root);
      const toml = buildDockerDriverGatewayConfigToml(
        env,
        "/usr/bin/openshell-sandbox",
        ensureDockerDriverGatewayJwtBundle(root),
        "projected-gateway",
      );
      const invalid = toml.replace(source, replacement);
      expect(invalid).not.toBe(toml);
      const configPath = path.join(root, "openshell-gateway.toml");
      fs.writeFileSync(configPath, invalid);
      expect(() =>
        assertDockerDriverGatewayAuthConfigSafe(
          { ...env, OPENSHELL_GATEWAY_CONFIG: configPath },
          {},
          "linux",
        ),
      ).toThrow(error);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
