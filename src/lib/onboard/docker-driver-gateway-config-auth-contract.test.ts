// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { prepareDockerDriverGatewayConfigEnv } from "./docker-driver-gateway-config";

import {
  jwtBundlePaths,
  mintOpenShellStyleSandboxJwt,
  parseTomlString,
  validateOpenShellStyleSandboxJwt,
  writeGatewayConfig,
} from "../../../test/support/openshell-gateway-config-helpers";

describe("docker-driver-gateway auth contract", () => {
  it("permits existing create-plan JSON without granting external attachments or host binds", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-admission-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const parsed = parseToml(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8")) as {
        openshell: { drivers: { docker: Record<string, unknown> } };
      };
      const driver = parsed.openshell.drivers.docker;
      expect(driver.allow_driver_config).toBe(true);
      expect(driver.enable_bind_mounts).toBeUndefined();
      // No override: pinned OpenShell keeps admission enabled with its required labels.
      expect(driver.resource_admission).toBeUndefined();
      expect(env.NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS).toBeUndefined();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
  it.each(["disabled driver JSON", "disabled resource admission"])(
    "does not adopt a noncanonical config with %s",
    (change) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-admission-"));
      try {
        const env = writeGatewayConfig(stateDir);
        const before = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8");
        const changed =
          change === "disabled driver JSON"
            ? before.replace("allow_driver_config = true", "allow_driver_config = false")
            : before + "\n[openshell.drivers.docker.resource_admission]\nenabled = false\n";
        fs.writeFileSync(env.OPENSHELL_GATEWAY_CONFIG, changed);
        expect(() =>
          prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
        ).toThrow("the config does not match NemoClaw's generated form");
        expect(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8")).toBe(changed);
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );
  it("emits an OpenShell 0.1.2 sandbox JWT bundle with non-expiring sessions", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const toml = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");
      const signingKeyPath = parseTomlString(toml, "signing_key_path");
      const publicKeyPath = parseTomlString(toml, "public_key_path");
      const kidPath = parseTomlString(toml, "kid_path");
      const gatewayId = parseTomlString(toml, "gateway_id");
      const parsed = parseToml(toml) as {
        openshell: { gateway: { gateway_jwt: Record<string, unknown> } };
      };
      const kid = fs.readFileSync(kidPath, "utf-8").trim();
      const now = Math.floor(Date.now() / 1000);
      const sandboxId = "sandbox-contract";

      expect(toml).toContain("[openshell.gateway.gateway_jwt]");
      expect(toml).toContain("[openshell.gateway.auth]");
      expect(toml).toContain("allow_unauthenticated_users = false");
      expect(env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      expect(parsed.openshell.gateway.gateway_jwt.ttl_secs).toBeUndefined();

      const token = mintOpenShellStyleSandboxJwt({
        signingKeyPath,
        kid,
        gatewayId,
        sandboxId,
        iat: now,
        exp: 0,
      });

      const payload = validateOpenShellStyleSandboxJwt({
        token,
        publicKeyPath,
        kid,
        gatewayId,
        now,
        expectedSandboxId: sandboxId,
      });
      expect(payload).toMatchObject({
        sandbox_id: sandboxId,
        iss: `openshell-gateway:${gatewayId}`,
        aud: `openshell-gateway:${gatewayId}`,
      });
      expect(payload?.exp).toBe(0);
      expect(() =>
        validateOpenShellStyleSandboxJwt({
          token,
          publicKeyPath,
          kid,
          gatewayId,
          now,
          expectedSandboxId: `${sandboxId}-other`,
        }),
      ).toThrow("OpenShell-style sandbox JWT sandbox binding");

      expect(
        validateOpenShellStyleSandboxJwt({
          token,
          publicKeyPath,
          kid: "wrong-kid",
          gatewayId,
          now,
          expectedSandboxId: sandboxId,
        }),
      ).toBeNull();
      expect(() =>
        validateOpenShellStyleSandboxJwt({
          token,
          publicKeyPath,
          kid,
          gatewayId: "wrong-gateway",
          now,
          expectedSandboxId: sandboxId,
        }),
      ).toThrow("expected");

      const expired = mintOpenShellStyleSandboxJwt({
        signingKeyPath,
        kid,
        gatewayId,
        sandboxId,
        iat: now - 7200,
        exp: now - 3600,
      });
      expect(() =>
        validateOpenShellStyleSandboxJwt({
          token: expired,
          publicKeyPath,
          kid,
          gatewayId,
          now,
          expectedSandboxId: sandboxId,
        }),
      ).toThrow("OpenShell-style sandbox JWT expiry");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("emits the OpenShell 0.1.2 gateway authentication schema", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const toml = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");

      expect(toml).toContain("[openshell.gateway.tls]");
      expect(toml).toContain("version = 2");
      expect(toml).toContain("client_ca_path = ");
      expect(toml).not.toContain("require_client_auth");
      expect(toml).not.toContain("[openshell.gateway.oidc]");
      expect(toml).toContain("[openshell.gateway.mtls_auth]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain("[openshell.gateway.gateway_jwt]");
      expect(toml).toContain("signing_key_path = ");
      expect(toml).toContain("public_key_path = ");
      expect(toml).toContain("kid_path = ");
      expect(toml).toContain("gateway_id = ");
      expect(toml).not.toContain("ttl_secs =");
      expect(toml).toContain("[openshell.gateway.auth]");
      expect(toml).toContain("allow_unauthenticated_users = false");
      expect(toml).toContain("guest_tls_ca = ");
      expect(toml).toContain("guest_tls_cert = ");
      expect(toml).toContain("guest_tls_key = ");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a sandbox JWT minted for a different gateway config", () => {
    const stateDirA = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-a-"));
    const stateDirB = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-b-"));
    try {
      const envA = writeGatewayConfig(stateDirA);
      const envB = writeGatewayConfig(stateDirB);
      const tomlA = fs.readFileSync(envA.OPENSHELL_GATEWAY_CONFIG, "utf-8");
      const tomlB = fs.readFileSync(envB.OPENSHELL_GATEWAY_CONFIG, "utf-8");
      const pathsA = jwtBundlePaths(stateDirA);
      const pathsB = jwtBundlePaths(stateDirB);
      const gatewayIdA = parseTomlString(tomlA, "gateway_id");
      const gatewayIdB = parseTomlString(tomlB, "gateway_id");
      const kidA = fs.readFileSync(pathsA.kidPath, "utf-8").trim();
      const kidB = fs.readFileSync(pathsB.kidPath, "utf-8").trim();
      const now = Math.floor(Date.now() / 1000);
      const sandboxIdA = "sandbox-a";

      const token = mintOpenShellStyleSandboxJwt({
        signingKeyPath: pathsA.signingKeyPath,
        kid: kidA,
        gatewayId: gatewayIdA,
        sandboxId: sandboxIdA,
        iat: now,
        exp: 0,
      });

      expect(
        validateOpenShellStyleSandboxJwt({
          token,
          publicKeyPath: pathsB.publicKeyPath,
          kid: kidB,
          gatewayId: gatewayIdB,
          now,
          expectedSandboxId: "sandbox-b",
        }),
      ).toBeNull();
      expect(() =>
        validateOpenShellStyleSandboxJwt({
          token,
          publicKeyPath: pathsA.publicKeyPath,
          kid: kidA,
          gatewayId: gatewayIdB,
          now,
          expectedSandboxId: sandboxIdA,
        }),
      ).toThrow("expected");
    } finally {
      fs.rmSync(stateDirA, { recursive: true, force: true });
      fs.rmSync(stateDirB, { recursive: true, force: true });
    }
  });
});
