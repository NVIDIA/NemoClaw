// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getDockerDriverGatewayTargetIdentityDrift,
  hasDockerDriverGatewayEnvironment,
  isDockerDriverGatewayProcessIdentity,
} from "./docker-driver-gateway-process-identity";
import { resolveOpenShellGatewayProcessTarget } from "./gateway-process-target-identity";

const normalizeGatewayExecutablePath = (value: string | null | undefined) => value ?? null;

describe("Docker-driver gateway target identity", () => {
  it("recovers canonical targets from annotated argv0 and explicit flags", () => {
    expect(
      resolveOpenShellGatewayProcessTarget("openshell-gateway[nemoclaw=nemoclaw-8081;port=8081]"),
    ).toEqual({ name: "nemoclaw-8081", port: 8081 });
    expect(
      resolveOpenShellGatewayProcessTarget("/opt/openshell-gateway --name nemoclaw --port 8080"),
    ).toEqual({ name: "nemoclaw", port: 8080 });
  });

  it("rejects ambiguous or noncanonical explicit targets", () => {
    expect(
      resolveOpenShellGatewayProcessTarget(
        "/opt/openshell-gateway --name nemoclaw --port 8080 --port 8081",
      ),
    ).toBeNull();
    expect(
      resolveOpenShellGatewayProcessTarget(
        "/opt/openshell-gateway --name nemoclaw-8081 --port 8080",
      ),
    ).toBeNull();
  });

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
