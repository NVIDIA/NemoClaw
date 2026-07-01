// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  GATEWAY_AUTH_REVIEW_NOTE,
  jwtBundlePaths,
  mintOpenShellStyleSandboxJwt,
  parseTomlInteger,
  parseTomlString,
  validateOpenShellStyleSandboxJwt,
  writeGatewayConfig,
} from "../../../test/support/openshell-gateway-config-helpers";

describe("docker-driver-gateway auth contract", () => {
  it("records the audited OpenShell 0.0.71 source revision", () => {
    const reviewNote = fs.readFileSync(GATEWAY_AUTH_REVIEW_NOTE, "utf-8");

    expect(reviewNote).toContain("NVIDIA/OpenShell@v0.0.71");
    expect(reviewNote).toContain("a242f84bb367d6df7d4d133e95a93857406c67f7");
  });

  it("emits an OpenShell 0.0.71-compatible sandbox JWT bundle and TTL contract", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const toml = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");
      const signingKeyPath = parseTomlString(toml, "signing_key_path");
      const publicKeyPath = parseTomlString(toml, "public_key_path");
      const kidPath = parseTomlString(toml, "kid_path");
      const gatewayId = parseTomlString(toml, "gateway_id");
      const ttlSecs = parseTomlInteger(toml, "ttl_secs");
      const kid = fs.readFileSync(kidPath, "utf-8").trim();
      const now = Math.floor(Date.now() / 1000);
      const sandboxId = "sandbox-contract";

      expect(toml).toContain("[openshell.gateway.gateway_jwt]");
      expect(toml).toContain("[openshell.gateway.auth]");
      expect(toml).toContain("allow_unauthenticated_users = false");
      expect(env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      expect(ttlSecs).toBe(DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS);

      const token = mintOpenShellStyleSandboxJwt({
        signingKeyPath,
        kid,
        gatewayId,
        sandboxId,
        iat: now,
        exp: now + ttlSecs,
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
      expect(payload?.exp).toBe(now + ttlSecs);
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
        iat: now - ttlSecs * 2,
        exp: now - ttlSecs,
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

  it("emits the complete OpenShell 0.0.71 gateway auth TOML schema", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const toml = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");

      expect(toml).toContain("[openshell.gateway.tls]");
      expect(toml).toContain("require_client_auth = true");
      expect(toml).toContain("[openshell.gateway.mtls_auth]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain("[openshell.gateway.gateway_jwt]");
      expect(toml).toContain("signing_key_path = ");
      expect(toml).toContain("public_key_path = ");
      expect(toml).toContain("kid_path = ");
      expect(toml).toContain("gateway_id = ");
      expect(toml).toContain(`ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`);
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
        exp: now + DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
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
