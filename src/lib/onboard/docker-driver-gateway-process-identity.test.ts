// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getDockerDriverGatewayTargetIdentityDrift,
  hasDockerDriverGatewayEnvironment,
  isDockerDriverGatewayProcessIdentity,
} from "./docker-driver-gateway-process-identity";

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

  it("requires both gateway executable identity and Linux Docker-driver environment proof", () => {
    const input = {
      pid: 999_999,
      gatewayBin: "/opt/openshell/openshell-gateway",
      captureProcessArgs: () => "/opt/openshell/openshell-gateway --name nemoclaw --port 8080",
      processIdentityMatchesGatewayBinary: () => true,
      requireDockerDriverEnv: true,
      hasDockerDriverGatewayEnv: () => false,
    };

    expect(isDockerDriverGatewayProcessIdentity(input)).toBe(false);
    expect(
      isDockerDriverGatewayProcessIdentity({
        ...input,
        hasDockerDriverGatewayEnv: () => true,
      }),
    ).toBe(true);
    expect(
      isDockerDriverGatewayProcessIdentity({
        ...input,
        processIdentityMatchesGatewayBinary: () => false,
        hasDockerDriverGatewayEnv: () => true,
      }),
    ).toBe(false);
  });

  it("recognizes only documented Docker-driver environment markers", () => {
    expect(hasDockerDriverGatewayEnvironment({ OPENSHELL_DRIVERS: "docker" }, "tcp://x")).toBe(
      true,
    );
    expect(
      hasDockerDriverGatewayEnvironment({ OPENSHELL_GRPC_ENDPOINT: "tcp://x" }, "tcp://x"),
    ).toBe(true);
    expect(
      hasDockerDriverGatewayEnvironment({ OPENSHELL_GRPC_ENDPOINT: "tcp://other" }, "tcp://x"),
    ).toBe(false);
  });
});
