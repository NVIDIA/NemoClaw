// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertEndpointResolvesPublic } from "./endpoint-ssrf-preflight";
import {
  type OpenAiValidationSessionDeps,
  probeOpenAiLikeEndpointWithValidationSession,
} from "./openai-validation-session";
import {
  createOpenAiValidationTestDeps,
  useOpenAiValidationTestServers,
} from "./openai-validation-session.test-helpers";

const { probeOpenAiLikeEndpointOptimized } = require("./onboard-probes");

const listen = useOpenAiValidationTestServers();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI validation curl fallback", () => {
  it("recovers natively after transient HTTP failures", async () => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    const responsePlan = [
      [503, '{"error":{"message":"retry"}}'],
      [429, '{"error":{"message":"retry"}}'],
      [200, '{"choices":[{"message":{"content":"OK"}}]}'],
    ] as const;
    let requests = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      const [statusCode, body] = responsePlan[requests] ?? responsePlan.at(-1)!;
      requests += 1;
      response.statusCode = statusCode;
      response.end(body);
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(requests).toBe(3);
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });

  it("falls back once after transient HTTP retries are exhausted", async () => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    let requests = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      requests += 1;
      response.statusCode = 503;
      response.end('{"error":{"message":"still unavailable"}}');
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl retry diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl retry diagnostic" });
    expect(requests).toBe(4);
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("replays through curl after a terminal native failure", async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      response.statusCode = 401;
      response.end('{"error":{"message":"invalid key"}}');
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "bad-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl diagnostic" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("replays through curl once after a native connection reset", async () => {
    const server = http.createServer((request) => {
      request.socket.destroy();
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl connection diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl connection diagnostic" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("replays through curl when DNS pre-resolution exceeds its deadline", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl DNS diagnostic",
    }));
    const lookup = vi.fn(() => new Promise<Array<{ address: string; family: number }>>(() => {}));
    const harness = createOpenAiValidationTestDeps(legacyProbe);
    harness.sessionOptions = { env: {}, lookup, dnsTimeoutMs: 10 };

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "test-model",
      "test-key",
      {},
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl DNS diagnostic" });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("replays through curl after a connection reset during Responses streaming", async () => {
    const handleRequest = vi
      .fn()
      .mockImplementationOnce((_request, response) => {
        response.end('{"output":[{"type":"message"}]}');
      })
      .mockImplementationOnce((request) => {
        request.socket.destroy();
      });
    const server = http.createServer((request, response) => {
      request.resume();
      handleRequest(request, response);
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl streaming diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { probeStreaming: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl streaming diagnostic" });
    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });

  it("uses curl without DNS pre-resolution when a proxy is configured", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const lookup = vi.fn();
    const harness = createOpenAiValidationTestDeps(legacyProbe);
    harness.sessionOptions = {
      env: { HTTPS_PROXY: "http://proxy.example.test:8080" },
      lookup,
    };

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "test-model",
      "test-key",
      {},
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "CURL_CA_BUNDLE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])("uses curl without DNS pre-resolution when %s is configured", async (envName) => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const lookup = vi.fn();
    const harness = createOpenAiValidationTestDeps(legacyProbe);
    harness.sessionOptions = { env: { [envName]: "/tmp/provider-tls-config" }, lookup };

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "test-model",
      "test-key",
      {},
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps preflight-pinned endpoints on curl without native DNS", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "test-model",
      "test-key",
      { pinnedAddresses: ["203.0.113.10"] },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(harness.sessionOptions!.lookup).not.toHaveBeenCalled();
  });

  it("keeps trusted private IP literals on curl without native DNS", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);
    const preflight = await assertEndpointResolvesPublic("http://10.0.0.8/v1", async () => [], {
      trustedPrivateHosts: ["10.0.0.8"],
    });

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "http://10.0.0.8/v1",
      "test-model",
      "test-key",
      {
        pinnedAddresses: preflight.addresses,
        trustedPrivateCapability: preflight.trustedPrivateCapability,
      },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(legacyProbe).toHaveBeenCalledWith(
      "http://10.0.0.8/v1",
      "test-model",
      "test-key",
      expect.objectContaining({
        pinnedAddresses: [],
        trustedPrivateCapability: preflight.trustedPrivateCapability,
      }),
    );
    expect(harness.sessionOptions!.lookup).not.toHaveBeenCalled();
  });

  it("keeps DeepSeek V4 Pro on its specialized legacy streaming probe", async () => {
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      "https://provider.example.test/v1",
      "deepseek-ai/deepseek-v4-pro",
      "test-key",
      {},
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(legacyProbe).toHaveBeenCalledTimes(1);
    expect(harness.sessionOptions!.lookup).not.toHaveBeenCalled();
  });

  // Pins the shared transient policy from the native retry side: a status the
  // policy does not list must reach the fallback without spending retries
  // (#10709).
  it("does not retry a settled HTTP failure before falling back", async () => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    let requests = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      requests += 1;
      response.statusCode = 500;
      response.end('{"error":{"message":"internal"}}');
    });
    const port = await listen(server);
    const legacyProbe: OpenAiValidationSessionDeps["legacyProbe"] = vi.fn(() => ({
      ok: false,
      message: "curl settled diagnostic",
    }));
    const harness = createOpenAiValidationTestDeps(legacyProbe);

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      { skipResponsesProbe: true },
      harness,
    );

    expect(result).toEqual({ ok: false, message: "curl settled diagnostic" });
    expect(requests).toBe(1);
    expect(legacyProbe).toHaveBeenCalledTimes(1);
  });
});

describe("WSL2 advisory on native terminal failures (#10413)", () => {
  it.each([
    { label: "calibrated WSL floor", override: undefined, expectedTimeoutMs: 30_000 },
    { label: "validation override", override: "360", expectedTimeoutMs: 360_000 },
  ])("passes the $label to the native chat deadline", async (testCase) => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", testCase.override ?? "");
    const server = http.createServer((request, response) => {
      request.resume();
      response.end('{"choices":[{"message":{"content":"OK"}}]}');
    });
    const port = await listen(server);
    const spawnSyncImpl = vi.fn((_command: string, args: readonly string[]) => {
      const outputPath = args[args.indexOf("-o") + 1];
      fs.writeFileSync(outputPath, "{}");
      return { pid: 1, output: [], stdout: "200", stderr: "", status: 0, signal: null };
    });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = await probeOpenAiLikeEndpointOptimized(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      {
        skipResponsesProbe: true,
        calibrateTimeouts: true,
        isWsl: true,
        spawnSyncImpl,
        validationSessionOptions: {
          env: {},
          lookup: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
          allowPrivateAddressesForTesting: true,
        },
      },
    );

    expect({
      result,
      calibrationArgs: spawnSyncImpl.mock.calls[0]?.[1],
      nativeTimeouts: timeoutSpy.mock.calls.map((call) => call[1]),
    }).toMatchObject({
      result: { ok: true, api: "openai-completions" },
      calibrationArgs: expect.arrayContaining(["--connect-timeout", "3", "--max-time", "5"]),
      nativeTimeouts: expect.arrayContaining([testCase.expectedTimeoutMs]),
    });
  });

  async function probeUntilNativeTransportFailure(isWsl: boolean) {
    let requests = 0;
    // The reasoning-budget retry runs first, then the connection drops, which is
    // the native-session path that returns its own terminal failure.
    const replyPlan = [
      (response: http.ServerResponse) => {
        response.setHeader("content-type", "application/json");
        response.end(
          '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}',
        );
      },
    ];
    const dropConnection = (response: http.ServerResponse) => response.socket?.destroy();
    const server = http.createServer((request, response) => {
      request.resume();
      const reply = replyPlan[requests] ?? dropConnection;
      requests += 1;
      reply(response);
    });
    const port = await listen(server);
    return (await probeOpenAiLikeEndpointOptimized(
      `http://provider.example.test:${port}/v1`,
      "qwen3-vl:4b",
      "test-key",
      {
        skipResponsesProbe: true,
        requireChatCompletionsToolCalling: true,
        isWsl,
        validationSessionOptions: {
          env: {},
          lookup: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
          allowPrivateAddressesForTesting: true,
        },
      },
    )) as { ok: boolean; message?: string; advisory?: string };
  }

  it("carries the advisory when the reasoning retry ends in a transport failure", async () => {
    const result = await probeUntilNativeTransportFailure(true);

    expect(result.ok).toBe(false);
    expect(result.advisory).toContain("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS");
    expect(result.message).toContain("WSL2 detected");
  });

  it("omits the advisory off WSL2", async () => {
    const result = await probeUntilNativeTransportFailure(false);

    expect(result.ok).toBe(false);
    expect(result.advisory).toBeUndefined();
    expect(result.message).not.toContain("WSL2 detected");
  });
});
