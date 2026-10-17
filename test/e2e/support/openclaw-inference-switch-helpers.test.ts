// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { redactString } from "../fixtures/redaction.ts";
import { nativeLocalIdentity } from "../../../src/lib/inference/native-local/contract.ts";
import { patchOpenClawInferenceConfig } from "../../../src/lib/actions/inference-set.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { captureNativeRestart503Diagnostic } from "../fixtures/inference-routing-openclaw-native.ts";

import { startTestProgress } from "../fixtures/progress.ts";

import {
  getRouteOutput,
  readOpenClawConfig,
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
  it.each([
    { reply: "PONG", accepted: true },
    { reply: "ok", accepted: false },
  ])("requires the baseline reply token ($reply)", ({ reply, accepted }) => {
    expect(agentReplyContainsToken(reply, "PONG")).toBe(accepted);
  });

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

const disposables: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("requests structured route output instead of aligned terminal columns", async () => {
  const command = vi.fn(async (_command: string, args: string[]) => ({
    exitCode: 0,
    stderr: "",
    stdout: args.includes("--json")
      ? JSON.stringify({ provider: "compatible-anthropic-endpoint", model: "mock-anthropic-model" })
      : "Provider: compatible-anthropic-endpoint\nModel:    mock-anthropic-model\n",
  }));
  const result = await getRouteOutput({ command } as unknown as HostCliClient, {
    env: { HOME: "/tmp/switch-test-home" },
    timeoutMs: 1000,
  });
  expect(JSON.parse(result.stdout)).toEqual({
    provider: "compatible-anthropic-endpoint",
    model: "mock-anthropic-model",
  });
});

async function probeOpenClawConfig(
  sandbox: Parameters<typeof readOpenClawConfig>[0],
  home: string,
  expected: {
    model: string;
    inferenceApi: string;
    artifactName: string;
    nativeNvidia?: boolean;
    nativeCustomEndpoint?: string;
  },
) {
  const result = await readOpenClawConfig(sandbox, "switch-test", {
    artifactName: expected.artifactName,
    env: { HOME: home },
    timeoutMs: 1000,
    nativeNvidia: expected.nativeNvidia,
    nativeCustomApi: expected.nativeCustomEndpoint ? expected.inferenceApi : undefined,
  });
  expect(result.exitCode).toBe(0);
  const config = JSON.parse(result.stdout);
  const providerKey = expected.inferenceApi === "anthropic-messages" ? "anthropic" : "inference";
  const provider = config.models.providers[providerKey];
  expect(config.agents.defaults.model.primary).toBe(`${providerKey}/${expected.model}`);
  expect(provider.api).toBe(expected.inferenceApi);
  expect(provider.apiKey).toBe(
    expected.nativeNvidia || expected.nativeCustomEndpoint ? undefined : "unused",
  );
  const model = provider.models.find((entry: { id: string }) => entry.id === expected.model);
  expect(
    expected.inferenceApi === "anthropic-messages"
      ? model.maxTokens > 0
      : model.maxTokens === undefined,
  ).toBe(true);
}

const scopedNativeHandle = "openshell:resolve:env:v1_NVIDIA_INFERENCE_API_KEY";

function sandboxForOpenClawConfig(config: object, handle = scopedNativeHandle) {
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
            .map((arg) => arg.replaceAll("/sandbox/.openclaw/openclaw.json", configPath)),
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NVIDIA_INFERENCE_API_KEY: handle,
              COMPATIBLE_ANTHROPIC_API_KEY: handle,
              COMPATIBLE_API_KEY: handle,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        ),
      ),
      stderr: "",
    })),
  };
}

it("checks the actual switched native model budget with a materialized handle", async () => {
  const model = "nvidia/nemotron-3-super-120b-a12b";
  const config: any = {};
  patchOpenClawInferenceConfig(config, "nvidia-prod", model, "openai-completions");
  config.models.providers.inference.apiKey = scopedNativeHandle;
  await probeOpenClawConfig(sandboxForOpenClawConfig(config) as never, "/tmp/switch-home", {
    model,
    inferenceApi: "openai-completions",
    artifactName: "switched-native-config",
    nativeNvidia: true,
  });
});

it("checks the actual switched Anthropic model budget", async () => {
  const model = "mock-anthropic-model";
  const config = {};
  patchOpenClawInferenceConfig(
    config,
    "compatible-anthropic-endpoint",
    model,
    "anthropic-messages",
  );
  await probeOpenClawConfig(sandboxForOpenClawConfig(config) as never, "/tmp/switch-home", {
    model,
    inferenceApi: "anthropic-messages",
    artifactName: "switched-anthropic-config",
  });
});

it.each([
  ["anthropic-messages", true],
  ["anthropic-messages", false],
  ["openai-completions", true],
  ["openai-completions", false],
] as const)(
  "checks native custom %s credentials before redaction (valid=%s)",
  async (api, valid) => {
    const model = "mock-anthropic-model";
    const endpoint = "http://10.20.30.40:3000";
    const provider =
      api === "anthropic-messages" ? "compatible-anthropic-endpoint" : "compatible-endpoint";
    const providerKey = api === "anthropic-messages" ? "anthropic" : "inference";
    const credentialEnv =
      api === "anthropic-messages" ? "COMPATIBLE_ANTHROPIC_API_KEY" : "COMPATIBLE_API_KEY";
    const handle = `openshell:resolve:env:v7_${credentialEnv}`;
    const config: any = {};
    patchOpenClawInferenceConfig(
      config,
      provider,
      model,
      api,
      undefined,
      provider,
      { effort: null, explicit: false },
      false,
      endpoint,
      true,
    );
    config.models.providers[providerKey].apiKey = valid ? handle : "synthetic-raw-credential";
    const result = probeOpenClawConfig(
      sandboxForOpenClawConfig(config, handle) as never,
      "/tmp/switch-home",
      {
        model,
        inferenceApi: api,
        artifactName: "native-anthropic-config",
        nativeCustomEndpoint: endpoint,
      },
    );
    await expect(
      result.then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(valid);
  },
);

it.each([
  "unused",
  "nvapi-fixture-secret",
  "native",
  "${OTHER_API_KEY}",
  "${NVIDIA_INFERENCE_API_KEY}",
  "openshell:resolve:env:v2_NVIDIA_INFERENCE_API_KEY",
  "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY",
  null,
])("rejects an incorrect native OpenClaw credential value after redaction: %s", async (value) => {
  const model = "nvidia/nemotron-3-super-120b-a12b";
  const config: any = {};
  patchOpenClawInferenceConfig(config, "nvidia-prod", model, "openai-completions");
  config.models.providers.inference.apiKey = value;
  await expect(
    probeOpenClawConfig(sandboxForOpenClawConfig(config) as never, "/tmp/switch-home", {
      model,
      inferenceApi: "openai-completions",
      artifactName: "invalid-native-credential",
      nativeNvidia: true,
    }),
  ).rejects.toThrow();
});

it.each(["", "nvapi-fixture-secret", "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY"])(
  "rejects a missing or unscoped native handle even when config matches: %s",
  async (handle) => {
    const model = "nvidia/nemotron-3-super-120b-a12b";
    const config: any = {};
    patchOpenClawInferenceConfig(config, "nvidia-prod", model, "openai-completions");
    config.models.providers.inference.apiKey = handle;
    await expect(
      probeOpenClawConfig(sandboxForOpenClawConfig(config, handle) as never, "/tmp/switch-home", {
        model,
        inferenceApi: "openai-completions",
        artifactName: "invalid-native-handle",
        nativeNvidia: true,
      }),
    ).rejects.toThrow();
  },
);

describe("OpenClaw native restart diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  const binding = {
    provider: "llama-cpp-local",
    agent: "openclaw",
    endpointUrl: "http://host.openshell.internal:8081/v1",
    credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    authMode: "authenticated",
    gatewayName: "nemoclaw",
    sandboxName: "owner",
  } as const;
  const attachment = {
    ...binding,
    ...nativeLocalIdentity(binding),
    schemaVersion: 1 as const,
    providerId: "fixture-local-provider",
  };

  it("records bounded route recovery without changing the original start failure (#12975)", async () => {
    vi.useFakeTimers();
    const apiKey = "sk-native-test-not-real";
    const start = {
      exitCode: 1,
      stderr:
        "native local inference check failed: sandbox inference invocation probe returned HTTP 503",
    };
    const statuses = ["200", "503", "200", "200"];
    let requestCount = 0;
    const exec = vi.fn(async (_owner: string, _args: string[], _options: unknown) => {
      const stdout = statuses.shift()!;
      requestCount += Number(stdout === "200");
      return { exitCode: 0, stdout };
    });
    const referenceProbe = vi.fn(async () => {
      requestCount += 1;
      return { ok: true as const };
    });
    const requests = vi.fn(() => Array.from({ length: requestCount }, () => ({})));
    const nemoclaw = vi.fn(async () => ({ exitCode: 0 }));
    const writeJson = vi.fn(async () => "artifact");
    const diagnostic = captureNativeRestart503Diagnostic(start as never, {
      owner: "owner",
      model: "nemoclaw-openclaw-native-local",
      apiKey,
      attachment,
      referenceProbe,
      fake: { requests } as never,
      sandbox: { exec } as never,
      host: { nemoclaw } as never,
      artifacts: { writeJson } as never,
    });

    await vi.advanceTimersByTimeAsync(8_000);
    await diagnostic;
    expect(exec).toHaveBeenCalledTimes(4);
    expect(exec.mock.calls[0]?.[2]).toMatchObject({ redactionValues: [apiKey] });
    expect(exec.mock.calls[1]?.[2]).toMatchObject({ redactionValues: [apiKey] });
    expect(exec.mock.calls[2]?.[2]).toMatchObject({ redactionValues: [apiKey] });
    expect(exec.mock.calls[3]?.[2]).toMatchObject({ redactionValues: [apiKey] });
    expect(referenceProbe).toHaveBeenCalledTimes(2);
    expect(referenceProbe).toHaveBeenCalledWith(
      expect.objectContaining({ nativeLocalProviderAttachment: attachment }),
      {},
      20_000,
    );
    expect(exec.mock.calls[1]?.[1]).toContain("--output");
    expect(exec.mock.calls[1]?.[1]).toContain("/dev/null");
    expect(exec.mock.calls[1]?.[1]).toContain("--data-binary");
    expect(exec.mock.calls[1]?.[1]).toContain(
      "http://host.openshell.internal:8081/v1/chat/completions",
    );
    expect(nemoclaw).toHaveBeenCalledWith(["owner", "doctor"], expect.any(Object));
    expect(writeJson).toHaveBeenCalledWith("owner-restart-503-diagnostic.json", {
      immediate: { exitCode: 0, httpStatus: "200", reachedEndpoint: true },
      immediateChat: { exitCode: 0, httpStatus: "503", reachedEndpoint: false },
      immediateReference: { ok: true, httpStatus: null, reachedEndpoint: true },
      delayed: { exitCode: 0, httpStatus: "200", reachedEndpoint: true },
      delayedChat: { exitCode: 0, httpStatus: "200", reachedEndpoint: true },
      delayedReference: { ok: true, httpStatus: null, reachedEndpoint: true },
      doctorExitCode: 0,
    });
    expect(start.exitCode).toBe(1);
  });

  it("captures a native local HTTP 503 from the final start check (#12975)", async () => {
    vi.useFakeTimers();
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "200" }));
    const writeJson = vi.fn(async () => "artifact");
    const diagnostic = captureNativeRestart503Diagnostic(
      {
        exitCode: 1,
        stderr:
          "The sandbox started but inference is not usable: sandbox inference invocation probe returned HTTP 503",
      } as never,
      {
        owner: "owner",
        model: "nemoclaw-openclaw-native-local",
        apiKey: "sk-native-test-not-real",
        attachment,
        referenceProbe: vi.fn(async () => ({ ok: true as const })),
        fake: { requests: vi.fn(() => []) } as never,
        sandbox: { exec } as never,
        host: { nemoclaw: vi.fn(async () => ({ exitCode: 0 })) } as never,
        artifacts: { writeJson } as never,
      },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await diagnostic;
    expect(exec).toHaveBeenCalledTimes(4);
    expect(writeJson).toHaveBeenCalledOnce();
  });

  it("retains completed status evidence when a later direct probe rejects (#12975)", async () => {
    vi.useFakeTimers();
    const apiKey = "sk-native-test-not-real";
    const writeJson = vi.fn(async () => "artifact");
    const diagnostic = captureNativeRestart503Diagnostic(
      {
        exitCode: 1,
        stderr:
          "native local inference check failed: sandbox inference invocation probe returned HTTP 503",
      } as never,
      {
        owner: "owner",
        model: "nemoclaw-openclaw-native-local",
        apiKey,
        attachment,
        referenceProbe: vi.fn(async () => ({
          ok: false as const,
          httpStatus: 503,
          detail: "HTTP 503",
        })),
        fake: { requests: vi.fn(() => []) } as never,
        sandbox: {
          exec: vi
            .fn()
            .mockResolvedValueOnce({ exitCode: 0, stdout: "200" })
            .mockRejectedValueOnce(new Error("test probe failure"))
            .mockResolvedValue({ exitCode: 0, stdout: "200" }),
        } as never,
        host: { nemoclaw: vi.fn(async () => ({ exitCode: 0 })) } as never,
        artifacts: { writeJson } as never,
      },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await diagnostic;
    expect(writeJson).toHaveBeenCalledWith(
      "owner-restart-503-diagnostic.json",
      expect.objectContaining({
        immediate: { exitCode: 0, httpStatus: "200", reachedEndpoint: false },
        immediateChat: { error: "probe unavailable" },
        delayedReference: { ok: false, httpStatus: 503, reachedEndpoint: false },
        doctorExitCode: 0,
      }),
    );
    expect(JSON.stringify(writeJson.mock.calls)).not.toContain("test probe failure");
    expect(JSON.stringify(writeJson.mock.calls)).not.toContain(apiKey);
  });

  it("does not probe when restart did not fail with the native HTTP 503 signature (#12975)", async () => {
    const exec = vi.fn();
    await captureNativeRestart503Diagnostic({ exitCode: 1, stderr: "HTTP 401" } as never, {
      owner: "owner",
      model: "nemoclaw-openclaw-native-local",
      apiKey: "sk-native-test-not-real",
      attachment,
      fake: { requests: vi.fn() } as never,
      sandbox: { exec } as never,
      host: { nemoclaw: vi.fn() } as never,
      artifacts: { writeJson: vi.fn() } as never,
    });
    expect(exec).not.toHaveBeenCalled();
  });
});
