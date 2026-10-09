// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { redactString } from "../fixtures/redaction.ts";
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

function sandboxForOpenClawConfig(config: object) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "switch-config-probe-"));
  disposables.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return {
    exec: vi.fn(async (_sandboxName: string, argv: string[]) => ({
      exitCode: 0,
      stdout: redactString(
        execFileSync(
          argv[0]!,
          argv
            .slice(1)
            .map((arg) => (arg === "/sandbox/.openclaw/openclaw.json" ? configPath : arg)),
          { encoding: "utf8" },
        ),
      ),
      stderr: "",
    })),
  };
}

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
    const sandbox = sandboxForOpenClawConfig(config);
    await assertOpenClawConfig(sandbox as never, "/tmp/switch-test-home", {
      model,
      inferenceApi,
      baseUrl,
      artifactName: "switched-config",
      nativeNvidia: provider === "nvidia-prod",
    });
  },
);

it("matches retained native Hermes metadata from the real same-provider route preparation", async () => {
  vi.resetModules();
  vi.stubEnv("NEMOCLAW_SWITCH_PROVIDER", "nvidia-prod");
  vi.stubEnv("NEMOCLAW_SWITCH_INFERENCE_API", "openai-completions");
  const { expectedHermesRegistryMetadata } =
    await import("../live/hermes-inference-switch.test.ts");
  const { prepareInferenceSetRoute } =
    await import("../../../src/lib/actions/inference-set-route-containment.ts");
  const baseline = {
    name: "hermes-switch",
    agent: "hermes",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    provider: "nvidia-prod",
    model: "nvidia/baseline",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-completions",
  };
  const prepared = prepareInferenceSetRoute({
    entry: baseline,
    sandboxName: baseline.name,
    provider: "nvidia-prod",
    model: "nvidia/nemotron-3-super-120b-a12b",
    customRoute: {},
    session: null,
    sandboxes: [baseline],
  });
  const expected = expectedHermesRegistryMetadata(null);
  expect(expected).toEqual({
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-completions",
  });
  expect(prepared.preliminaryRegistryMetadata).toMatchObject(expected);
});

it("keeps explicit Hermes Anthropic metadata independent of the native baseline", async () => {
  vi.resetModules();
  vi.stubEnv("NEMOCLAW_SWITCH_PROVIDER", "compatible-anthropic-endpoint");
  vi.stubEnv("NEMOCLAW_SWITCH_INFERENCE_API", "anthropic-messages");
  const { expectedHermesRegistryMetadata } =
    await import("../live/hermes-inference-switch.test.ts");
  const endpoint = "http://host.openshell.internal:19120/v1";
  expect(expectedHermesRegistryMetadata(endpoint)).toEqual({
    endpointUrl: endpoint,
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    preferredInferenceApi: "openai-completions",
  });
});

it.each(["unused", "nvapi-fixture-secret", "native", "${OTHER_API_KEY}", null])(
  "rejects an incorrect native OpenClaw credential value after redaction: %s",
  async (value) => {
    const { assertOpenClawConfig } = await import("../live/openclaw-inference-switch.test.ts");
    const model = "nvidia/nemotron-3-super-120b-a12b";
    const config: any = {};
    patchOpenClawInferenceConfig(config, "nvidia-prod", model, "openai-completions");
    config.models.providers.inference.apiKey = value;
    await expect(
      assertOpenClawConfig(sandboxForOpenClawConfig(config) as never, "/tmp/switch-home", {
        model,
        inferenceApi: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        artifactName: "invalid-native-credential",
        nativeNvidia: true,
      }),
    ).rejects.toThrow();
  },
);
