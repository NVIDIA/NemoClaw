// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  NEMOCLAW_DOCKER_GATEWAY_NAME,
  OPENSHELL_PACKAGED_GATEWAY_ENDPOINT,
  OPENSHELL_PACKAGED_GATEWAY_NAME,
  getManagedGatewayName,
  getOpenShellGatewayMode,
  getPackagedGatewayEndpoint,
  isPackagedGatewayMode,
  usesDockerManagedGateway,
} from "../src/lib/openshell-gateway-mode.js";

describe("openshell-gateway-mode", () => {
  it("defaults to the existing Docker-managed NemoClaw gateway", () => {
    const env = {};
    expect(getOpenShellGatewayMode(env)).toBe("docker");
    expect(getManagedGatewayName(env)).toBe(NEMOCLAW_DOCKER_GATEWAY_NAME);
    expect(usesDockerManagedGateway(env)).toBe(true);
    expect(isPackagedGatewayMode(env)).toBe(false);
  });

  it("uses the OpenShell packaged local gateway for dev/deb modes", () => {
    for (const env of [
      { NEMOCLAW_OPENSHELL_GATEWAY_MODE: "packaged" },
      { NEMOCLAW_OPENSHELL_GATEWAY_MODE: "deb" },
      { NEMOCLAW_OPENSHELL_CHANNEL: "dev" },
    ]) {
      expect(getOpenShellGatewayMode(env)).toBe("packaged");
      expect(getManagedGatewayName(env)).toBe(OPENSHELL_PACKAGED_GATEWAY_NAME);
      expect(getPackagedGatewayEndpoint(env)).toBe(OPENSHELL_PACKAGED_GATEWAY_ENDPOINT);
      expect(isPackagedGatewayMode(env)).toBe(true);
    }
  });

  it("allows explicit gateway name and endpoint overrides", () => {
    const env = {
      NEMOCLAW_OPENSHELL_GATEWAY_MODE: "packaged",
      NEMOCLAW_OPENSHELL_GATEWAY_NAME: "spark",
      NEMOCLAW_OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:19000",
    };
    expect(getManagedGatewayName(env)).toBe("spark");
    expect(getPackagedGatewayEndpoint(env)).toBe("http://127.0.0.1:19000");
  });
});
