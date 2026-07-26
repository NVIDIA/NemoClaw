// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  writeGatewayConfig,
} from "../../../test/support/openshell-gateway-config-helpers";

describe("docker-driver-gateway config TOML", () => {
  it("writes OpenShell 0.0.72 gateway JWT config into the managed state dir", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const configPath = path.join(stateDir, "openshell-gateway.toml");
      const signingKeyPath = path.join(stateDir, "jwt", "signing.pem");
      const publicKeyPath = path.join(stateDir, "jwt", "public.pem");
      const kidPath = path.join(stateDir, "jwt", "kid");
      const toml = fs.readFileSync(configPath, "utf-8");

      expect(env.OPENSHELL_GATEWAY_CONFIG).toBe(configPath);
      expect(env.OPENSHELL_GRPC_ENDPOINT).toBe("https://127.0.0.1:8080");
      expect(toml).toContain("[openshell.gateway.gateway_jwt]");
      expect(toml).toContain(`signing_key_path = "${signingKeyPath}"`);
      expect(toml).toContain(`public_key_path = "${publicKeyPath}"`);
      expect(toml).toContain(`kid_path = "${kidPath}"`);
      expect(toml).toContain('gateway_id = "nemoclaw-');
      expect(toml).toContain(`ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`);
      expect(toml).toContain("disable_tls = false");
      expect(toml).toContain("[openshell.gateway.tls]");
      expect(toml).toContain(`cert_path = "${path.join(stateDir, "tls", "server", "tls.crt")}"`);
      expect(toml).toContain(`key_path = "${path.join(stateDir, "tls", "server", "tls.key")}"`);
      expect(toml).toContain(`client_ca_path = "${path.join(stateDir, "tls", "ca.crt")}"`);
      expect(toml).toContain("[openshell.gateway.mtls_auth]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain("[openshell.gateway.auth]");
      expect(toml).toContain("allow_unauthenticated_users = false");
      expect(toml).toContain('compute_drivers = ["docker"]');
      expect(toml).toContain('grpc_endpoint = "https://127.0.0.1:8080"');
      expect(toml).toContain(`guest_tls_ca = "${path.join(stateDir, "tls", "ca.crt")}"`);
      expect(toml).toContain(
        `guest_tls_cert = "${path.join(stateDir, "tls", "client", "tls.crt")}"`,
      );
      expect(toml).toContain(
        `guest_tls_key = "${path.join(stateDir, "tls", "client", "tls.key")}"`,
      );
      expect(toml).toContain('supervisor_bin = "/usr/bin/openshell-sandbox"');
      expect(env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(stateDir, "jwt")).mode & 0o777).toBe(0o700);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(signingKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(publicKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(kidPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
