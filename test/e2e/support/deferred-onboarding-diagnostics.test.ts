// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";

const state = vi.hoisted(() => ({
  run: undefined as unknown as (fixtures: E2ETargetFixtures) => Promise<void>,
  registered: false,
  agent: "",
  receipt: vi.fn(),
}));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: (_name: string, _options: unknown, run: typeof state.run) => {
    state.run = run;
  },
}));
vi.mock("../../../src/lib/state/registry.ts", () => ({
  getSandbox: () => (state.registered ? { agent: state.agent } : null),
}));
vi.mock("../../../src/lib/state/onboard-session.ts", () => ({
  loadSession: () =>
    state.registered ? { status: "complete", sandboxName: "owned-deferred" } : null,
}));
vi.mock("../fixtures/managed-image-receipt.ts", () => ({
  assertStockManagedImageReceipt: state.receipt,
}));

beforeAll(async () => {
  vi.stubEnv("NEMOCLAW_SANDBOX_NAME", "owned-deferred");
  await import("../live/deferred-onboarding.test.ts");
});
afterEach(() => vi.unstubAllEnvs());

function fixtures(agent: string, exitCode: number) {
  state.registered = false;
  state.agent = agent;
  state.receipt.mockClear();
  vi.stubEnv("NEMOCLAW_AGENT", agent);
  vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "docker");
  const success = { exitCode: 0, timedOut: false, signal: null, stdout: "", stderr: "" };
  const command = vi
    .fn()
    .mockResolvedValueOnce(success)
    .mockImplementationOnce(async () => {
      state.registered = exitCode === 0;
      return { ...success, exitCode, stderr: exitCode === 0 ? "" : "fixture onboarding failure" };
    })
    .mockRejectedValue(new Error("diagnostic source unavailable"));
  const target = {
    host: { command, openshellCommandPath: "/reviewed/openshell" },
    artifacts: { target: { declare: vi.fn() } },
    cleanup: { trackDisposable: vi.fn() },
    lifecycle: { trackInstallerGatewayUserService: vi.fn() },
    runtimeProvider: { requireAvailable: vi.fn() },
    sandbox: { openshell: vi.fn(async () => ({ ...success, stdout: "[]" })) },
    secrets: { required: () => "fixture-key", redactionValues: () => ["fixture-key"] },
    progress: { phase: vi.fn() },
  } as unknown as E2ETargetFixtures;
  return { target, command };
}

describe.each(["hermes", "langchain-deepagents-code"])(
  "deferred %s onboarding diagnostics",
  (agent) => {
    it("captures scoped evidence before retaining onboarding failure even when diagnostics fail", async () => {
      const { target, command } = fixtures(agent, 17);
      await expect(state.run(target)).rejects.toThrow("fixture onboarding failure");
      expect(command).toHaveBeenCalledWith(
        "/reviewed/openshell",
        ["logs", "owned-deferred", "-n", "200", "--source", "all", "--since", "2m"],
        expect.objectContaining({
          artifactName: "deferred-onboard-failure-supervisor-logs",
          redactionValues: ["fixture-key"],
          captureLimitBytes: 32_768,
          timeoutMs: 30_000,
        }),
      );
      expect(command).toHaveBeenCalledWith(
        "cat",
        [expect.stringMatching(/gateway\.log$/u)],
        expect.objectContaining({
          artifactName: "deferred-onboard-failure-gateway-log",
          redactionValues: ["fixture-key"],
          captureLimitBytes: 32_768,
          timeoutMs: 5_000,
        }),
      );
      expect(command).toHaveBeenCalledWith(
        "docker",
        [
          "container",
          "ps",
          "--all",
          "--no-trunc",
          "--filter",
          "label=openshell.ai/sandbox-name=owned-deferred",
          "--format",
          "{{.ID}}",
        ],
        expect.objectContaining({ artifactName: "deferred-onboard-failure-container-identity" }),
      );
      expect(command).toHaveBeenCalledTimes(5);
      expect(state.receipt).not.toHaveBeenCalled();
    });

    it("leaves successful onboarding free of diagnostic commands and checks its receipt", async () => {
      const { target, command } = fixtures(agent, 0);
      await state.run(target);
      expect(command).toHaveBeenCalledTimes(2);
      expect(state.receipt).toHaveBeenCalledExactlyOnceWith({
        environment: expect.objectContaining({
          NEMOCLAW_AGENT: agent,
          NVIDIA_INFERENCE_API_KEY: "fixture-key",
        }),
        expectedAgent: agent,
        sandboxName: "owned-deferred",
      });
    });
  },
);
