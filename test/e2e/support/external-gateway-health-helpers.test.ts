// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { exactGatewayRelease } from "../fixtures/openshell-v0116-qualification.ts";
import { externalGatewayHealthConfig } from "../fixtures/external-gateway-health-config.ts";
import { getDockerDriverGatewayLocalTlsBundle } from "../../../src/lib/onboard/docker-driver-gateway-local-tls.ts";

describe("external gateway release qualification", () => {
  it("renders v2 public-health TLS without sandbox user credentials (#12603)", () => {
    const tls = getDockerDriverGatewayLocalTlsBundle('/private/health "fixture"');
    expect(externalGatewayHealthConfig("192.0.2.10", 4433, tls)).toBe(
      String.raw`[openshell]
version = 2

[openshell.gateway]
bind_address = "192.0.2.10:4433"
compute_driver = "docker"
disable_tls = false
guest_tls_ca = "/private/health \"fixture\"/tls/ca.crt"

[openshell.gateway.tls]
cert_path = "/private/health \"fixture\"/tls/server/tls.crt"
key_path = "/private/health \"fixture\"/tls/server/tls.key"

[openshell.gateway.auth]
allow_unauthenticated_users = true
`,
    );
  });

  it.each([
    ["openshell-gateway 0.1.5\n", "0.1.5"],
    ["openshell-gateway v0.1.5\n", "0.1.5"],
    ["openshell-gateway 0.1.5-dev.1\n", "0.1.5-dev.1"],
    ["diagnostic 0.1.2\nopenshell-gateway 0.1.5\n", null],
    ["openshell-gateway 0.1.2\n", "0.1.2"],
    ["openshell-gateway v0.1.2\n", "0.1.2"],
    ["openshell-gateway 0.1.2-dev.1\n", "0.1.2-dev.1"],
    ["diagnostic 0.0.116\nopenshell-gateway 0.1.2\n", null],
    ["openshell-gateway 0.0.116\n", "0.0.116"],
    ["openshell-gateway v0.0.116\n", "0.0.116"],
    ["openshell-gateway 0.0.116-dev.1\n", "0.0.116-dev.1"],
    ["diagnostic 0.0.115\nopenshell-gateway 0.0.116\n", null],
  ] as const)("extracts one complete release token from %j", (output, expected) => {
    expect(exactGatewayRelease(output)).toBe(expected);
  });
});
