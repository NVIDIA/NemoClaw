// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getDockerDriverGatewayTargetIdentityDrift } from "./docker-driver-gateway-process-identity";

const normalizeGatewayExecutablePath = (value: string | null | undefined) => value ?? null;

describe("Docker-driver gateway target identity", () => {
  it("requires replacement of a legacy untagged gateway before reuse", () => {
    expect(
      getDockerDriverGatewayTargetIdentityDrift({
        gatewayBin: "/opt/openshell/openshell-gateway",
        gatewayPort: 8081,
        identity: "/opt/openshell/openshell-gateway",
        normalizeGatewayExecutablePath,
      })?.reason,
    ).toContain("lacks target-bound cleanup identity for nemoclaw-8081 on port 8081");
  });

  it("accepts the owned target-bound gateway launched after cutover", () => {
    expect(
      getDockerDriverGatewayTargetIdentityDrift({
        gatewayBin: "/opt/openshell/openshell-gateway",
        gatewayPort: 8081,
        identity: "openshell-gateway[nemoclaw=nemoclaw-8081;port=8081]",
        normalizeGatewayExecutablePath,
      }),
    ).toBeNull();
  });
});
