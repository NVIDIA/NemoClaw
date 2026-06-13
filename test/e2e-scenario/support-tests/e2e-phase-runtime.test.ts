// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ProviderClient,
  SandboxClient,
  trustedProviderEndpoint,
  type CommandRunner,
} from "../fixtures/clients/index.ts";
import type { E2EScenarioFixtures } from "../fixtures/e2e-test.ts";
import {
  inferenceRouteUrl,
  RuntimePhaseFixture,
  type NemoClawInstance,
} from "../fixtures/phases/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

function shellResult(exitCode: number, stdout = "", stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: {
      stdout: "/tmp/stdout.txt",
      stderr: "/tmp/stderr.txt",
      result: "/tmp/result.json",
    },
  };
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly responses: ShellProbeResult[] = [];

  enqueue(response: ShellProbeResult): void {
    this.responses.push(response);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({
      command: command.command,
      args: [...command.args],
      options,
    });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(
        `FakeRunner response missing for command: ${command.command} ${command.args.join(" ")}`,
      );
    }
    return response;
  }
}

function instance(overrides: Partial<NemoClawInstance> = {}): NemoClawInstance {
  return {
    onboarding: "cloud-openclaw",
    sandboxName: "e2e-ubuntu-repo-cloud-openclaw",
    agent: "openclaw",
    provider: "nvidia",
    providerEnv: "cloud",
    gatewayUrl: "http://127.0.0.1:18789",
    result: shellResult(0),
    ...overrides,
  };
}

function fixture(runner: FakeRunner): RuntimePhaseFixture {
  return new RuntimePhaseFixture(new SandboxClient(runner), new ProviderClient(runner));
}

describe("runtime phase fixture", () => {
  it("is available through the Vitest E2E fixture context", () => {
    expectTypeOf<E2EScenarioFixtures["runtime"]>().toEqualTypeOf<RuntimePhaseFixture>();
  });

  it("normalizes inference route slugs to the sandbox DNS hostname", () => {
    expect(inferenceRouteUrl()).toBe("https://inference.local/v1/models");
    expect(inferenceRouteUrl("inference-local", "v1/chat/completions")).toBe(
      "https://inference.local/v1/chat/completions",
    );
    expect(inferenceRouteUrl("inference.local", "/v1/models")).toBe(
      "https://inference.local/v1/models",
    );
  });

  it("checks inference.local models from inside the sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, '{"data":[{"id":"nvidia/model"}]}'));

    const result = await fixture(runner).expectInferenceLocalModels(instance());

    expect(result.endpoint).toBe("https://inference.local/v1/models");
    expect(runner.calls).toEqual([
      {
        command: "openshell",
        args: [
          "sandbox",
          "exec",
          "-n",
          "e2e-ubuntu-repo-cloud-openclaw",
          "--",
          "curl",
          "-fsS",
          "--max-time",
          "20",
          "https://inference.local/v1/models",
        ],
        options: {
          artifactName: "runtime-inference-local-models",
          env: expect.objectContaining({ PATH: expect.any(String) }),
          redactionValues: [],
          timeoutMs: 60_000,
        },
      },
    ]);
  });

  it("accepts Ollama-style inference.local model lists", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, '{"models":[{"name":"llama3"}]}'));

    await expect(fixture(runner).expectInferenceLocalModels(instance())).resolves.toMatchObject({
      endpoint: "https://inference.local/v1/models",
    });
  });

  it("rejects inference.local model probes without compatible model data", async () => {
    const invalidJson = new FakeRunner();
    invalidJson.enqueue(shellResult(0, "not-json"));

    await expect(fixture(invalidJson).expectInferenceLocalModels(instance())).rejects.toThrow(
      "inference.local models response was not JSON",
    );

    const missingModels = new FakeRunner();
    missingModels.enqueue(shellResult(0, '{"error":"unavailable"}'));

    await expect(fixture(missingModels).expectInferenceLocalModels(instance())).rejects.toThrow(
      "inference.local models response missing model data",
    );
  });

  it("posts an OpenAI-compatible chat completion to inference.local without shell interpolation", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, JSON.stringify({ choices: [{ message: { content: "ok" } }] })));

    await fixture(runner).expectInferenceLocalChatCompletion(instance(), {
      artifactName: "custom-chat",
      maxTokens: 12,
      model: "default",
      prompt: "Reply with ok",
    });

    const call = runner.calls[0];
    expect(call?.command).toBe("openshell");
    expect(call?.args).toEqual([
      "sandbox",
      "exec",
      "-n",
      "e2e-ubuntu-repo-cloud-openclaw",
      "--",
      "curl",
      "-fsS",
      "--max-time",
      "20",
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      expect.any(String),
      "https://inference.local/v1/chat/completions",
    ]);
    expect(call?.args).not.toContain("sh");
    const payload = JSON.parse(call?.args[12] ?? "{}");
    expect(payload).toEqual({
      model: "default",
      messages: [{ role: "user", content: "Reply with ok" }],
      max_tokens: 12,
    });
    expect(call?.options?.artifactName).toBe("custom-chat");
  });

  it("retries inference.local PONG chat completions and accepts reasoning content", async () => {
    const runner = new FakeRunner();
    runner.enqueue(
      shellResult(0, JSON.stringify({ choices: [{ message: { content: "not yet" } }] })),
    );
    runner.enqueue(
      shellResult(
        0,
        JSON.stringify({
          choices: [{ message: { reasoning_content: "PONG" } }],
        }),
      ),
    );

    const result = await fixture(runner).expectInferenceLocalPong(instance(), {
      artifactName: "pong-probe",
      attempts: 2,
      retryDelayMs: 1,
    });

    expect(result.result.stdout).toContain("PONG");
    expect(runner.calls.map((call) => call.options?.artifactName)).toEqual([
      "pong-probe-1",
      "pong-probe-2",
    ]);
  });

  it("accepts configured status codes for auth-proxy and route-health checks", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "403"));

    await fixture(runner).expectInferenceLocalStatus(instance(), {
      allowedStatusCodes: [401, 403],
      headers: ["Authorization: Bearer local-proxy-token"],
      redactionValues: ["local-proxy-token"],
    });

    expect(runner.calls[0]).toMatchObject({
      command: "openshell",
      args: [
        "sandbox",
        "exec",
        "-n",
        "e2e-ubuntu-repo-cloud-openclaw",
        "--",
        "curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "20",
        "-H",
        "Authorization: Bearer local-proxy-token",
        "https://inference.local/v1/models",
      ],
      options: {
        artifactName: "runtime-inference-local-status",
        redactionValues: expect.arrayContaining([
          "Authorization: Bearer local-proxy-token",
          "Bearer local-proxy-token",
          "local-proxy-token",
        ]),
        timeoutMs: 60_000,
      },
    });
  });

  it("calls a trusted compatible provider endpoint with request artifacts and redaction", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, JSON.stringify({ choices: [{ message: { content: "pong" } }] })));
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/chat/completions", {
      allowedHosts: ["api.example.test"],
    });

    const result = await fixture(runner).expectProviderChatCompletion(endpoint, {
      apiKey: "provider-secret",
      model: "nvidia/model",
      prompt: "Reply with pong",
    });

    expect(result.endpoint).toBe("https://api.example.test/v1/chat/completions");
    expect(runner.calls[0]).toEqual({
      command: "curl",
      args: [
        "-fsS",
        "--max-time",
        "20",
        "-H",
        "Content-Type: application/json",
        "-H",
        "Authorization: Bearer provider-secret",
        "--data-raw",
        JSON.stringify({
          model: "nvidia/model",
          messages: [{ role: "user", content: "Reply with pong" }],
          max_tokens: 8,
        }),
        "https://api.example.test/v1/chat/completions",
      ],
      options: {
        artifactName: "curl-https-api.example.test-v1-chat-completions",
        redactionValues: ["provider-secret"],
        timeoutMs: 60_000,
      },
    });
  });

  it("accepts Ollama-style compatible provider model lists", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, JSON.stringify({ models: ["llama3"] })));
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/models", {
      allowedHosts: ["api.example.test"],
    });

    await expect(fixture(runner).expectProviderModels(endpoint)).resolves.toMatchObject({
      endpoint: "https://api.example.test/v1/models",
    });
  });

  it("redacts sensitive custom headers and honors provider curl max time", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, JSON.stringify({ data: [{ id: "nvidia/model" }] })));
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/models", {
      allowedHosts: ["api.example.test"],
    });

    await fixture(runner).expectProviderModels(endpoint, {
      curlMaxTimeSeconds: 7,
      headers: ["Authorization: Bearer custom-provider-token"],
    });

    expect(runner.calls[0]).toMatchObject({
      command: "curl",
      args: [
        "-fsS",
        "--max-time",
        "7",
        "-H",
        "Authorization: Bearer custom-provider-token",
        "https://api.example.test/v1/models",
      ],
      options: {
        artifactName: "curl-https-api.example.test-v1-models",
        redactionValues: expect.arrayContaining([
          "Authorization: Bearer custom-provider-token",
          "Bearer custom-provider-token",
          "custom-provider-token",
        ]),
        timeoutMs: 60_000,
      },
    });
  });

  it("rejects invalid curl max time values before runtime probe execution", async () => {
    for (const curlMaxTimeSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const runner = new FakeRunner();

      await expect(
        fixture(runner).expectInferenceLocalModels(instance(), {
          curlMaxTimeSeconds,
        }),
      ).rejects.toThrow("inference request curlMaxTimeSeconds must be a finite positive number");
      expect(runner.calls).toEqual([]);
    }
  });

  it("rejects provider model probes without compatible model data", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, JSON.stringify({ error: "unavailable" })));
    const endpoint = trustedProviderEndpoint("https://api.example.test/v1/models", {
      allowedHosts: ["api.example.test"],
    });

    await expect(fixture(runner).expectProviderModels(endpoint)).rejects.toThrow(
      "provider models response missing model data",
    );
  });

  it("fails chat probes on malformed compatible responses without echoing the body", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "not json with provider-secret"));

    await expect(
      fixture(runner).expectInferenceLocalChatCompletion(instance(), {
        redactionValues: ["provider-secret"],
      }),
    ).rejects.toThrow("inference.local chat completion response was not JSON");
  });
});
