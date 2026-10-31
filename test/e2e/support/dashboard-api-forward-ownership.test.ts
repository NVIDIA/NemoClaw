// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";

const captured = vi.hoisted(() => ({
  register: vi.fn(),
  healthy: vi.fn(),
}));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: { for: () => captured.register, skip: { for: () => captured.register } },
}));
vi.mock("../../../src/lib/actions/sandbox/forward-recovery.ts", () => ({
  isSandboxPortForwardHealthy: captured.healthy,
  teardownSandboxDashboardForward: async () => true,
}));
vi.mock("../fixtures/hosted-inference.ts", () => ({
  requireHostedInferenceConfig: () => ({ apiKey: "fixture-key", env: {} }),
}));

import "../live/dashboard-remote-bind.test.ts";

const scenario = captured.register.mock.calls[0]![2] as (
  agent: "hermes",
  fixtures: E2ETargetFixtures,
) => Promise<void>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  captured.healthy.mockReset();
});

describe("Hermes remote dashboard API ownership", () => {
  it.each(["onboarding", "restart"] as const)(
    "rejects an unowned healthy API listener after %s",
    async (phase) => {
      vi.stubEnv("NEMOCLAW_E2E_REMOTE_HOST", "192.0.2.10");
      vi.stubEnv("NEMOCLAW_HERMES_API_PORT", "8642");
      vi.spyOn(os, "networkInterfaces").mockReturnValue({
        eth0: [
          {
            address: "192.0.2.10",
            family: "IPv4",
            internal: false,
            netmask: "255.255.255.0",
            mac: "00:00:00:00:00:00",
            cidr: "192.0.2.10/24",
          },
        ],
      });
      let apiObservations = 0;
      captured.healthy.mockImplementation((_name: string, port: number) => {
        apiObservations += Number(port === 8642);
        return port !== 8642 || (phase === "restart" && apiObservations === 1);
      });
      const commands: string[] = [];
      const command = vi.fn(async (_binary, _args, options) => {
        commands.push(options.artifactName);
        // Every HTTP/TCP probe succeeds: ownership must independently reject the listener.
        return { exitCode: 0, stdout: "nemoclaw openshell", stderr: "", timedOut: false };
      });
      const fixtures = {
        artifacts: { target: { declare: vi.fn() } },
        cleanup: { trackGateway: vi.fn(), trackDisposable: vi.fn(), trackSandbox: vi.fn() },
        host: { command, nemoclaw: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
        progress: { phase: vi.fn() },
        runtimeProvider: { requireAvailable: vi.fn() },
        sandbox: {
          cleanupSandbox: vi.fn(async () => undefined),
          openshell: vi.fn(async () => undefined),
        },
        secrets: {},
      } as unknown as E2ETargetFixtures;
      await expect(scenario("hermes", fixtures)).rejects.toThrow(/expected false to be true/);
      expect(apiObservations).toBe(phase === "onboarding" ? 1 : 2);
      expect(commands).not.toContain(
        phase === "onboarding"
          ? "dashboard-remote-bind-hermes-api-loopback"
          : "dashboard-remote-bind-hermes-api-loopback-after-restart",
      );
    },
  );
});
