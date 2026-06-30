// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS } from "../../src/lib/onboard/docker-driver-gateway-config";

export function writeSafeGatewayAuthConfig(dir: string): string {
  const configPath = path.join(dir, "openshell-gateway.toml");
  const jwtDir = path.join(dir, "jwt");
  const signingKeyPath = path.join(jwtDir, "signing.pem");
  const publicKeyPath = path.join(jwtDir, "public.pem");
  const kidPath = path.join(jwtDir, "kid");
  fs.mkdirSync(jwtDir, { recursive: true, mode: 0o700 });
  for (const [filePath, value] of [
    [signingKeyPath, "test signing key\n"],
    [publicKeyPath, "test public key\n"],
    [kidPath, "test-kid\n"],
  ]) {
    fs.writeFileSync(filePath, value, { mode: 0o600 });
  }
  fs.writeFileSync(
    configPath,
    [
      "[openshell.gateway]",
      "disable_tls = false",
      "",
      "[openshell.gateway.tls]",
      "require_client_auth = true",
      "",
      "[openshell.gateway.mtls_auth]",
      "enabled = true",
      "",
      "[openshell.gateway.gateway_jwt]",
      `signing_key_path = ${JSON.stringify(signingKeyPath)}`,
      `public_key_path = ${JSON.stringify(publicKeyPath)}`,
      `kid_path = ${JSON.stringify(kidPath)}`,
      'gateway_id = "nemoclaw-test"',
      `ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`,
      "",
      "[openshell.gateway.auth]",
      "allow_unauthenticated_users = false",
      "",
    ].join("\n"),
  );
  return configPath;
}
