// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { startPackageManagedDockerDriverGateway } from "./docker-driver-gateway-service";

const STATUS_CONNECTED = `
Server Status

Gateway: nemoclaw
Server: https://127.0.0.1:8080/
Connected
`;

const GATEWAY_INFO = `
Gateway Info

Gateway: nemoclaw
Gateway endpoint: https://127.0.0.1:8080/
`;

describe("docker-driver-gateway-service", () => {
  it("uses the package-managed service only after endpoint, metadata, and gRPC health are ready", async () => {
    const events: string[] = [];
    let registerCount = 0;
    const registerDockerDriverGatewayEndpoint = vi.fn(() => {
      events.push("register");
      registerCount += 1;
      return registerCount >= 2;
    });

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: () => events.push("clear"),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 3,
        healthPollInterval: 0,
        isDockerDriverGatewayReady: async () => {
          events.push("ready");
          return true;
        },
        registerDockerDriverGatewayEndpoint,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        sleepSeconds: () => events.push("sleep"),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          started: true,
        }),
        verifySandboxBridgeGatewayReachableOrExit: async () => {
          events.push("verify");
        },
      }),
    ).resolves.toBe(true);

    expect(events).toEqual(["register", "sleep", "register", "ready", "clear", "verify"]);
  });

  it("stops the package-managed service when the sandbox bridge is unreachable", async () => {
    const events: string[] = [];

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: () => events.push("clear"),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        healthPollInterval: 0,
        isDockerDriverGatewayReady: async () => true,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          started: true,
        }),
        stopOpenShellGatewayUserService: () => {
          events.push("stop-service");
          return { attempted: true, stopped: true };
        },
        verifySandboxBridgeGatewayReachableOrExit: async (_exitOnFailure, options) => {
          events.push("verify");
          await options?.onUnreachable?.();
          throw new Error("Docker-driver sandbox-bridge unreachable (tcp_failed)");
        },
      }),
    ).rejects.toThrow("sandbox-bridge unreachable");

    expect(events).toEqual(["clear", "verify", "stop-service"]);
  });

  it("falls back to standalone when package-managed service startup is unavailable", async () => {
    const registerDockerDriverGatewayEndpoint = vi.fn(() => true);

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        registerDockerDriverGatewayEndpoint,
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: true,
          reason: "user manager unavailable",
          started: false,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(registerDockerDriverGatewayEndpoint).not.toHaveBeenCalled();
  });

  it("keeps standalone runtime breadcrumbs when service health never becomes ready", async () => {
    const clearDockerDriverGatewayRuntimeFiles = vi.fn();

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles,
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        isDockerDriverGatewayReady: async () => false,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          fallbackAllowed: false,
          started: true,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("did not become healthy");

    expect(clearDockerDriverGatewayRuntimeFiles).not.toHaveBeenCalled();
  });
});
