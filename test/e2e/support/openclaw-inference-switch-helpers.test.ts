// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { redactString } from "../fixtures/redaction.ts";
import { patchOpenClawInferenceConfig } from "../../../src/lib/actions/inference-set.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";

import { startTestProgress } from "../fixtures/progress.ts";

import {
  agentReplyContainsToken,
  anthropicToolCount,
  classifyExhaustedPostSwitchEvidence,
  classifyOpenClawPostSwitchInferenceAttempt,
  classifyUnavailableInitialProviderEvidence,
  MOCK_BASELINE_API_KEY,
  MOCK_BASELINE_MODEL,
  mockBaselineInference,
  parseOpenClawGatewayModelRun,
  startMockOpenClawBaselineProvider,
} from "../live/openclaw-inference-switch-helpers.ts";

describe("openclaw-inference-switch post-switch retry classification", () => {
  const attempt = {
    exitCode: 1,
    httpStatus: "000",
    malformed: false,
    output: "",
    productMatched: false,
  };

  it.each([6, 7, 28, 35, 52, 56])(
    "retries only explicit transport and HTTP failures [%s]",
    (exitCode) => {
      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode,
          output: "curl transport failed",
        }),
      ).toEqual({ outcome: "failed", failureClass: "transient-external" });

      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode: 0,
          httpStatus: "503",
          output: "service unavailable",
        }),
      ).toEqual({ outcome: "failed", failureClass: "transient-external" });
      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode: 2,
          output: "ETIMEDOUT",
        }),
      ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    },
  );

  it("keeps terminal and successful product mismatches out of retries", () => {
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        output: "HTTP 401 authentication failed after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authentication" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "HTTP 403 authorization failed after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authorization" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "denied by network policy after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "policy-denial" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "invalid API key after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authentication" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 0,
        httpStatus: "200",
        output: "wrong model after ETIMEDOUT",
      }),
    ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 0,
        httpStatus: "429",
        output: "invalid JSON after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "malformed-input" });
  });

  it("fails closed when required native-provider evidence exhausts retries", () => {
    expect(
      classifyExhaustedPostSwitchEvidence({
        required: true,
        lastFailure: "HTTP 503: unavailable",
      }),
    ).toEqual({
      outcome: "failed",
      message:
        "Required native provider evidence failed: Sandbox inference transient failure after switch; route/config checks already passed: HTTP 503: unavailable",
    });

    expect(
      classifyExhaustedPostSwitchEvidence({
        required: false,
        lastFailure: "HTTP 503: unavailable",
      }),
    ).toEqual({
      outcome: "skipped",
      reason:
        "Sandbox inference transient failure after switch; route/config checks already passed: HTTP 503: unavailable",
    });
  });

  it("fails closed when required native-provider validation is unavailable during onboarding", () => {
    expect(
      classifyUnavailableInitialProviderEvidence({
        required: true,
        detail: "HTTP 429: rate limited",
      }),
    ).toEqual({
      outcome: "failed",
      message:
        "Required native provider evidence failed: External provider validation was unavailable during onboarding: HTTP 429: rate limited",
    });

    expect(
      classifyUnavailableInitialProviderEvidence({
        required: false,
        detail: "HTTP 429: rate limited",
      }),
    ).toEqual({
      outcome: "skipped",
      reason:
        "External provider validation was unavailable during onboarding: HTTP 429: rate limited",
    });
  });
});

describe("openclaw-inference-switch agent reply matching", () => {
  it("tolerates wrapped PONG", () => {
    expect(agentReplyContainsToken("P\nO N G", "PONG")).toBe(true);
    expect(agentReplyContainsToken("wrapped: p o\nng", "PONG")).toBe(false);
    expect(agentReplyContainsToken("the answer is PONG", "PONG")).toBe(false);
    expect(agentReplyContainsToken("PONG because the route works", "PONG")).toBe(false);
    expect(agentReplyContainsToken("PANG", "PONG")).toBe(false);
    expect(agentReplyContainsToken("SPONGE", "PONG")).toBe(false);
    expect(agentReplyContainsToken("pingpong", "PONG")).toBe(false);
  });
});

describe("openclaw-inference-switch Anthropic tool evidence", () => {
  it("distinguishes tool-free requests from malformed tool metadata", () => {
    expect(anthropicToolCount(undefined)).toBe(0);
    expect(anthropicToolCount([])).toBe(0);
    expect(anthropicToolCount([{ name: "shell" }])).toBe(1);
    expect(anthropicToolCount({ name: "shell" })).toBeNull();
    expect(anthropicToolCount("invalid")).toBeNull();
  });
});

describe("openclaw-inference-switch gateway model-run output", () => {
  it("accepts the stable gateway inference envelope", () => {
    expect(
      parseOpenClawGatewayModelRun(
        JSON.stringify({
          ok: true,
          capability: "model.run",
          transport: "gateway",
          provider: "anthropic",
          model: "mock-anthropic-model",
          attempts: [],
          outputs: [{ text: "PONG", mediaUrl: null }],
        }),
      ),
    ).toEqual({
      model: "mock-anthropic-model",
      provider: "anthropic",
      text: "PONG",
      transport: "gateway",
    });
  });

  it.each([
    "not json",
    JSON.stringify({ ok: false, capability: "model.run", transport: "gateway", outputs: [] }),
    JSON.stringify({
      ok: true,
      capability: "model.run",
      transport: "local",
      provider: "anthropic",
      model: "mock-anthropic-model",
      outputs: [{ text: "PONG" }],
    }),
    JSON.stringify({
      ok: true,
      capability: "model.run",
      transport: "gateway",
      provider: "anthropic",
      model: "mock-anthropic-model",
      outputs: [{ mediaUrl: null }],
    }),
  ])("rejects malformed or non-gateway output", (raw) => {
    expect(parseOpenClawGatewayModelRun(raw)).toBeNull();
  });
});

describe("openclaw-inference-switch mock-Anthropic baseline", () => {
  it("serves authenticated PONG replies for the lifecycle gateway checks", async () => {
    const progress = startTestProgress("OpenClaw baseline", ["serve baseline", "verify baseline"], {
      logLine: () => undefined,
    });
    const baseline = await startMockOpenClawBaselineProvider(progress);
    try {
      const endpoint = new URL(`${baseline.baseUrl}/chat/completions`);
      expect(endpoint.hostname).toBe("host.openshell.internal");
      endpoint.hostname = "127.0.0.1";
      const payload = {
        model: MOCK_BASELINE_MODEL,
        messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
        stream: true,
      };
      const denied = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(denied.status).toBe(401);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MOCK_BASELINE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      const chunks = (await response.text())
        .split("\n\n")
        .filter((chunk) => chunk.startsWith("data: {"))
        .map((chunk) => JSON.parse(chunk.slice("data: ".length)));
      expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")).toBe("PONG");
      expect(baseline.requests()).toContainEqual(
        expect.objectContaining({
          auth: "ok",
          method: "POST",
          path: "/v1/chat/completions",
          model: MOCK_BASELINE_MODEL,
          stream: true,
        }),
      );
    } finally {
      await baseline.close();
      progress.stop();
    }
  });

  it("uses an authenticated local baseline with the compatible env wiring", () => {
    expect(mockBaselineInference("http://127.0.0.1:34567/v1")).toEqual({
      apiKey: MOCK_BASELINE_API_KEY,
      endpointUrl: "http://127.0.0.1:34567/v1",
      model: MOCK_BASELINE_MODEL,
      env: {
        COMPATIBLE_API_KEY: MOCK_BASELINE_API_KEY,
        NEMOCLAW_COMPAT_MODEL: MOCK_BASELINE_MODEL,
        NEMOCLAW_ENDPOINT_URL: "http://127.0.0.1:34567/v1",
        NEMOCLAW_MODEL: MOCK_BASELINE_MODEL,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
      },
    });
  });

  it("threads the endpoint URL into both the config and the env", () => {
    const baseline = mockBaselineInference("http://10.0.0.5:9000/v1");
    expect(baseline.endpointUrl).toBe("http://10.0.0.5:9000/v1");
    expect(baseline.env.NEMOCLAW_ENDPOINT_URL).toBe("http://10.0.0.5:9000/v1");
  });
});

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
