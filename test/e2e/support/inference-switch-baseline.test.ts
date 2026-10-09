// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { patchOpenClawInferenceConfig } from "../../../src/lib/actions/inference-set.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";

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
});

it("keeps the OpenClaw native switch credential out of the authenticated baseline", async () => {
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
  const nemoclaw = vi.fn(async (_args: string[], _options: { env: NodeJS.ProcessEnv }) => {
    throw stop;
  });
  await import("../live/openclaw-inference-switch.test.ts");
  const { startTestProgress } = await import("../fixtures/progress.ts");
  const progress = startTestProgress(
    "baseline wiring",
    captured.test.mock.calls[0]![1].meta.e2ePhases,
    { logLine: () => undefined },
  );
  disposables.push(() => progress.stop());
  const run = captured.test.mock.calls[0]![2] as (input: object) => Promise<void>;
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
      secrets: { required: vi.fn(() => "nvapi-public-fixture-key") },
    }),
  ).rejects.toBe(stop);
  const environment = nemoclaw.mock.calls[0]![1].env;
  expect(environment.NEMOCLAW_PROVIDER).toBe("custom");
  expect(environment.NEMOCLAW_ENDPOINT_URL).toMatch(/^http:\/\/host\.openshell\.internal:\d+\/v1$/);
  expect(environment.NEMOCLAW_MODEL).toBe("openclaw-switch-baseline-model");
  expect(environment.COMPATIBLE_API_KEY).toBe("openclaw-switch-baseline-credential");
  expect(environment.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
});

it("requests structured route output instead of aligned terminal columns", async () => {
  const { getRouteOutput } = await import("../live/openclaw-inference-switch.test.ts");
  const command = vi.fn(async (_command: string, args: string[]) => ({
    exitCode: 0,
    stderr: "",
    stdout: args.includes("--json")
      ? JSON.stringify({ provider: "compatible-anthropic-endpoint", model: "mock-anthropic-model" })
      : "Provider: compatible-anthropic-endpoint\nModel:    mock-anthropic-model\n",
  }));
  const result = await getRouteOutput(
    { command } as unknown as HostCliClient,
    "/tmp/switch-test-home",
  );
  expect(JSON.parse(result.stdout)).toEqual({
    provider: "compatible-anthropic-endpoint",
    model: "mock-anthropic-model",
  });
});

it.each([
  [
    "nvidia-prod",
    "nvidia/nemotron-3-super-120b-a12b",
    "openai-completions",
    "https://integrate.api.nvidia.com/v1",
  ],
  [
    "compatible-anthropic-endpoint",
    "mock-anthropic-model",
    "anthropic-messages",
    "https://inference.local",
  ],
])(
  "checks the actual switched model budget for %s",
  async (provider, model, inferenceApi, baseUrl) => {
    const { assertOpenClawConfig } = await import("../live/openclaw-inference-switch.test.ts");
    const config = {};
    patchOpenClawInferenceConfig(config, provider, model, inferenceApi);
    const sandbox = {
      exec: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(config), stderr: "" })),
    };
    await assertOpenClawConfig(sandbox as never, "/tmp/switch-test-home", {
      model,
      inferenceApi,
      baseUrl,
      artifactName: "switched-config",
    });
  },
);
