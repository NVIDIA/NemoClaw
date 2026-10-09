// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ test: vi.fn() }));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: captured.test,
}));
vi.mock("../fixtures/managed-image-receipt.ts", () => ({
  selectedE2eManagedImageReference: () => "example.invalid/openclaw@sha256:" + "a".repeat(64),
}));

const disposables: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("../live/openclaw-inference-switch-helpers.ts");
});

it("keeps the public NVIDIA key out of the native switch baseline", async () => {
  vi.resetModules();
  captured.test.mockClear();
  vi.stubEnv("NEMOCLAW_SWITCH_PROVIDER", "nvidia-prod");
  vi.stubEnv("NEMOCLAW_SWITCH_MOCK_ANTHROPIC", "0");
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    String(file).endsWith("bin/nemoclaw.js") ? true : exists(file),
  );
  const result = { exitCode: 0, stdout: "", stderr: "" };
  const stop = new Error("onboarding captured");
  const nemoclaw = vi.fn(
    async (_args: string[], _options: { env: NodeJS.ProcessEnv; redactionValues: string[] }) => {
      throw stop;
    },
  );
  await import("../live/openclaw-inference-switch.test.ts");
  const { startTestProgress } = await import("../fixtures/progress.ts");
  const progress = startTestProgress(
    "native switch baseline",
    captured.test.mock.calls[0]![1].meta.e2ePhases,
    { logLine: () => undefined },
  );
  disposables.push(() => progress.stop());
  const run = captured.test.mock.calls[0]![2] as (input: object) => Promise<void>;
  const required = vi.fn((name: string) => {
    expect(name).toBe("NVIDIA_API_KEY");
    return "nvapi-public-fixture-key";
  });
  await expect(
    run({
      artifacts: { target: { declare: vi.fn() } },
      cleanup: {
        trackDisposable: (_name: string, dispose: () => unknown) => disposables.push(dispose),
        trackGateway: vi.fn(),
        trackSandbox: vi.fn(),
      },
      host: { nemoclaw, command: vi.fn(async () => result) },
      progress,
      runtimeProvider: { requireAvailable: vi.fn() },
      sandbox: { openshell: vi.fn(async () => result), cleanupSandbox: vi.fn() },
      secrets: { required },
    }),
  ).rejects.toBe(stop);
  expect(required).toHaveBeenCalledExactlyOnceWith("NVIDIA_API_KEY");
  const options = nemoclaw.mock.calls[0]![1];
  const environment = options.env;
  expect(environment.NEMOCLAW_PROVIDER).toBe("custom");
  expect(environment.NEMOCLAW_ENDPOINT_URL).toMatch(/^http:\/\/host\.openshell\.internal:\d+\/v1$/);
  expect(environment.NEMOCLAW_MODEL).toBe("openclaw-switch-baseline-model");
  expect(environment.COMPATIBLE_API_KEY).toBe("openclaw-switch-baseline-credential");
  expect(environment.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
  expect(environment.NVIDIA_API_KEY).toBeUndefined();
  expect(options.redactionValues).toContain("nvapi-public-fixture-key");
  expect(options.redactionValues).toContain("openclaw-switch-baseline-credential");
});

it("rejects an invalid NVIDIA key before starting the baseline provider", async () => {
  vi.resetModules();
  captured.test.mockClear();
  vi.stubEnv("NEMOCLAW_SWITCH_PROVIDER", "nvidia-prod");
  vi.stubEnv("NEMOCLAW_SWITCH_MOCK_ANTHROPIC", "0");
  const startBaseline = vi.fn();
  vi.doMock("../live/openclaw-inference-switch-helpers.ts", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../live/openclaw-inference-switch-helpers.ts")>()),
    startMockOpenClawBaselineProvider: startBaseline,
  }));
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    String(file).endsWith("bin/nemoclaw.js") ? true : exists(file),
  );

  await import("../live/openclaw-inference-switch.test.ts");
  const run = captured.test.mock.calls[0]![2] as (input: object) => Promise<void>;
  const required = vi.fn(() => "invalid-key");
  await expect(
    run({
      artifacts: { target: { declare: vi.fn() } },
      runtimeProvider: { requireAvailable: vi.fn() },
      secrets: { required },
    }),
  ).rejects.toThrow("NVIDIA_API_KEY must be a public NVIDIA Endpoints nvapi-* key");
  expect(required).toHaveBeenCalledExactlyOnceWith("NVIDIA_API_KEY");
  expect(startBaseline).not.toHaveBeenCalled();
});
