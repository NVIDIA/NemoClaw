// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { useOpenAiValidationTestServers } from "../inference/openai-validation-session.test-helpers";
import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";

const listen = useOpenAiValidationTestServers();
const resumableValidationExit = {
  code: 1,
  name: "OnboardDeferredExitError",
  preserveIncompleteSession: true,
};
const terminalValidationExit = {
  code: 1,
  name: "OnboardDeferredExitError",
  preserveIncompleteSession: false,
};

describe("inference selection validation", () => {
  it.each([
    {
      route: "native optimized transport",
      handleRequest: (request: http.IncomingMessage, response: http.ServerResponse) => {
        request.resume();
        response.end('{"choices":[{"message":{"content":"OK"}}]}');
      },
      expectedLegacyCalls: 0,
    },
    {
      route: "legacy fallback after a native failure",
      handleRequest: (request: http.IncomingMessage) => request.socket.destroy(),
      expectedLegacyCalls: 1,
    },
  ])("uses the default optimized probe through the public helper: $route", async (testCase) => {
    const server = http.createServer(testCase.handleRequest);
    const port = await listen(server);
    const spawnSyncImpl = vi.fn((_command: string, args: readonly string[]) => {
      const outputPath = args[args.indexOf("-o") + 1];
      fs.writeFileSync(outputPath, '{"choices":[{"message":{"content":"OK"}}]}');
      return {
        pid: 1,
        output: [],
        stdout: "200",
        stderr: "",
        status: 0,
        signal: null,
      };
    });
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });
    const probeOptions = {
      apiKey: "test-key",
      skipResponsesProbe: true,
      spawnSyncImpl,
      validationTiming: {
        connectTimeoutSeconds: 1,
        maxTimeSeconds: 1,
        source: "standard",
      },
      validationSessionOptions: {
        env: {},
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        allowPrivateAddressesForTesting: true,
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "Compatible endpoint",
          `http://provider.example.com:${port}/v1`,
          "model-a",
          null,
          undefined,
          undefined,
          probeOptions,
        ),
      ).resolves.toEqual({ ok: true, api: "openai-completions" });
      expect(spawnSyncImpl).toHaveBeenCalledTimes(testCase.expectedLegacyCalls);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    {
      variant: "NVIDIA",
      useNvidiaEndpointProbePayload: true,
      expectedBody: {
        model: "nvidia/nemotron-3-super-120b-a12b",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 16,
        temperature: 1,
        top_p: 0.95,
        chat_template_kwargs: { enable_thinking: false },
      },
    },
    {
      variant: "generic",
      useNvidiaEndpointProbePayload: false,
      expectedBody: {
        model: "nvidia/nemotron-3-super-120b-a12b",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 16,
      },
    },
  ])(
    "emits the $variant Nemotron request through selection validation (#10880)",
    async ({ useNvidiaEndpointProbePayload, expectedBody }) => {
      let observedBody = "";
      const server = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          observedBody = body;
          response.end('{"choices":[{"message":{"content":"OK"}}]}');
        });
      });
      const port = await listen(server);
      const helpers = createInferenceSelectionValidationHelpers({
        isNonInteractive: () => false,
        agentProductName: () => "OpenClaw",
        promptValidationRecovery: vi.fn(async () => "selection" as const),
      });
      const probeOptions = {
        apiKey: "test-key",
        skipResponsesProbe: true,
        validationTiming: {
          connectTimeoutSeconds: 1,
          maxTimeSeconds: 1,
          source: "standard" as const,
        },
        validationSessionOptions: {
          env: {},
          lookup: async () => [{ address: "127.0.0.1", family: 4 as const }],
          allowPrivateAddressesForTesting: true,
        },
      };
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        await expect(
          helpers.validateOpenAiLikeSelection(
            "NVIDIA Endpoints",
            `http://provider.example.com:${port}/v1`,
            "nvidia/nemotron-3-super-120b-a12b",
            null,
            undefined,
            undefined,
            { ...probeOptions, useNvidiaEndpointProbePayload },
          ),
        ).resolves.toEqual({ ok: true, api: "openai-completions" });
        expect(JSON.parse(observedBody)).toEqual(expectedBody);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("uses an explicit managed key without forwarding it as a probe option", async () => {
    const apiKey = "f".repeat(64);
    const getCredential = vi.fn(() => "ambient-key");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
      label: "Chat Completions API",
    }));
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential,
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      helpers.validateOpenAiLikeSelection(
        "Local vLLM",
        "http://10.40.0.1:8000/v1",
        "served/model",
        null,
        undefined,
        undefined,
        { apiKey, pinnedAddresses: [] },
      ),
    ).resolves.toEqual({ ok: true, api: "openai-completions" });
    expect(getCredential).not.toHaveBeenCalled();
    expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
      "http://10.40.0.1:8000/v1",
      "served/model",
      apiKey,
      { pinnedAddresses: [], calibrateTimeouts: true },
    );
    expect(log.mock.calls.flat().join("\n")).not.toContain(apiKey);
    log.mockRestore();
  });

  it("records a completed Chat Completions selection for the matching smoke check", async () => {
    const capabilityCache = new OnboardInferenceCapabilityCache();
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint: vi.fn(() => ({
        ok: true,
        api: "openai-completions",
        label: "Chat Completions API",
      })),
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "OpenAI",
          "https://api.example.test/v1/",
          "model-a",
          "OPENAI_API_KEY",
          undefined,
          undefined,
          { capabilityCache },
        ),
      ).resolves.toEqual({ ok: true, api: "openai-completions" });
      expect(
        capabilityCache.takeCompletedOpenAiChat({
          endpointUrl: "https://api.example.test/v1",
          model: "model-a",
        }),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("withholds OpenAI-like availability and capability caching when sandbox identity changes during the probe (#9833)", async () => {
    const capabilityCache = new OnboardInferenceCapabilityCache();
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint: vi.fn(async () => ({
        ok: true,
        api: "openai-completions",
        label: "Chat Completions API",
      })),
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "OpenAI",
          "https://api.example.test/v1",
          "model-a",
          "OPENAI_API_KEY",
          undefined,
          undefined,
          {
            capabilityCache,
            revalidateSandboxIdentity: () => {
              throw new Error("sandbox identity changed");
            },
          },
        ),
      ).rejects.toThrow("sandbox identity changed");
      expect(log.mock.calls.flat().join("\n")).not.toContain("available");
      expect(
        capabilityCache.takeCompletedOpenAiChat({
          endpointUrl: "https://api.example.test/v1",
          model: "model-a",
        }),
      ).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("withholds Anthropic availability when sandbox identity changes during the probe (#9833)", async () => {
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint: vi.fn(() => ({
        ok: true,
        api: "anthropic-messages",
        label: "Anthropic Messages API",
      })),
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateAnthropicSelectionWithRetryMessage(
          "Anthropic",
          "https://api.anthropic.example.test",
          "model-a",
          "ANTHROPIC_API_KEY",
          undefined,
          undefined,
          () => {
            throw new Error("sandbox identity changed");
          },
        ),
      ).rejects.toThrow("sandbox identity changed");
      expect(log.mock.calls.flat().join("\n")).not.toContain("available");
    } finally {
      log.mockRestore();
    }
  });

  it("distinguishes a Gemini runtime 404 from native model catalog validation (#9298)", async () => {
    const apiKey = "gemini-test-secret";
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 404, curlStatus: 0 }],
    }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => apiKey,
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "Google Gemini",
          "https://generativelanguage.googleapis.com/v1beta/openai",
          "gemini-2.5-flash",
          "GEMINI_API_KEY",
          undefined,
          undefined,
          { provider: "gemini-api", skipResponsesProbe: true },
        ),
      ).resolves.toEqual({ ok: false, retry: "selection" });
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
        "https://generativelanguage.googleapis.com/v1beta/openai",
        "gemini-2.5-flash",
        apiKey,
        { skipResponsesProbe: true, calibrateTimeouts: true },
      );
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain(
        "This 404 came from Google's OpenAI-compatible Chat Completions runtime route, not the native /v1beta/models catalog.",
      );
      expect(errorOutput).toContain("the sandbox uses that Chat Completions route at runtime");
      expect(errorOutput).not.toContain(apiKey);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("preserves non-zero exit signaling when non-interactive endpoint validation fails (#5721)", async () => {
    const originalExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const teardownOrphanManagedGatewayOnAbort = vi.fn(() => true);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "nvapi-invalid-key-12345",
      probeOpenAiLikeEndpoint: () => ({
        ok: false,
        failures: [{ name: "Chat Completions API", httpStatus: 403 }],
      }),
      teardownOrphanManagedGatewayOnAbort,
      promptValidationRecovery,
    });

    try {
      await expect(
        helpers.validateOpenAiLikeSelection(
          "NVIDIA Endpoints",
          "https://integrate.api.nvidia.com/v1",
          "meta/llama-3.3-70b-instruct",
          "NVIDIA_INFERENCE_API_KEY",
        ),
      ).rejects.toMatchObject(resumableValidationExit);
      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(promptValidationRecovery).not.toHaveBeenCalled();
      expect(teardownOrphanManagedGatewayOnAbort).toHaveBeenCalledOnce();
      expect(error.mock.calls.map((args) => args.join(" "))).toEqual([
        "  NVIDIA Endpoints endpoint validation failed.",
        "  Validation probe summary: Chat Completions API: HTTP 403.",
        "  Validation details were omitted to avoid exposing credentials.",
      ]);
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("fails reasoning-mode validation when Chat Completions fails (#3279)", async () => {
    vi.stubEnv("NEMOCLAW_REASONING", "yes");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 500 }],
    }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomOpenAiLikeSelection(
          "Custom endpoint",
          "https://compatible.example/v1",
          "reasoning-model",
          "COMPATIBLE_API_KEY",
        ),
      ).resolves.toEqual({ ok: false, retry: "selection" });
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
        "https://compatible.example/v1",
        "reasoning-model",
        "test-key",
        {
          calibrateTimeouts: true,
          requireResponsesToolCalling: false,
          skipResponsesProbe: true,
          probeStreaming: false,
          pinnedAddresses: ["93.184.216.34"],
        },
      );
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("refuses a custom OpenAI-like endpoint that resolves to a private address before probing (#6293)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "10.0.0.8", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomOpenAiLikeSelection(
          "Custom endpoint",
          "https://public-name.example/v1",
          "model-a",
          "COMPATIBLE_API_KEY",
        ),
      ).resolves.toEqual({ ok: false, retry: "selection" });
      expect(probeOpenAiLikeEndpoint).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("probes an exactly allowlisted private endpoint with DNS pinning (#6861)", async () => {
    vi.stubEnv("NEMOCLAW_TRUSTED_PRIVATE_HOSTS", "llm.corp.example");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const capabilityCache = new OnboardInferenceCapabilityCache();
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "10.0.0.8", family: 4 }],
    });

    try {
      const result = await helpers.validateCustomOpenAiLikeSelection(
        "Custom endpoint",
        "https://llm.corp.example/v1",
        "model-a",
        "COMPATIBLE_API_KEY",
        null,
        capabilityCache,
      );
      expect(result).toMatchObject({
        ok: true,
        api: "openai-completions",
        pinnedAddresses: ["10.0.0.8"],
      });
      expect(result.ok && result.trustedPrivateCapability?.addresses).toEqual(["10.0.0.8"]);
      expect(
        result.ok &&
          capabilityCache.takeCompletedOpenAiChat({
            endpointUrl: "https://llm.corp.example/v1",
            model: "model-a",
            pinnedAddresses: result.pinnedAddresses,
            trustedPrivateCapability: result.trustedPrivateCapability,
          }),
      ).toBe(false);
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
        "https://llm.corp.example/v1",
        "model-a",
        "test-key",
        expect.objectContaining({
          pinnedAddresses: ["10.0.0.8"],
          trustedPrivateCapability: expect.objectContaining({ addresses: ["10.0.0.8"] }),
        }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("operator-trusted private"));
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      runtimeSurface: "native Anthropic Messages",
      intendedApi: "anthropic-messages" as const,
      expectedEndpointUrl: "https://anthropic.corp.example",
      expectedProbeOptions: { probeStreaming: true },
    },
    {
      runtimeSurface: "managed Chat Completions (Hermes/DCode)",
      intendedApi: "openai-completions" as const,
      expectedEndpointUrl: "https://anthropic.corp.example/v1",
      expectedProbeOptions: { calibrateTimeouts: true, skipResponsesProbe: true },
    },
  ])(
    "probes an exactly allowlisted private Anthropic endpoint on its $runtimeSurface surface (#7037)",
    async ({ intendedApi, expectedEndpointUrl, expectedProbeOptions }) => {
      vi.stubEnv("NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS", "anthropic.corp.example");
      vi.stubEnv("NEMOCLAW_REASONING", "false");
      const probeEndpoint = vi.fn(() => ({
        ok: true,
        api: intendedApi,
        label: "Compatible API",
      }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const helpers = createInferenceSelectionValidationHelpers({
        isNonInteractive: () => false,
        agentProductName: () => "NemoClaw agent",
        getCredential: () => "test-key",
        probeAnthropicEndpoint: probeEndpoint,
        probeOpenAiLikeEndpoint: probeEndpoint,
        promptValidationRecovery: vi.fn(async () => "selection" as const),
        resolveEndpointHost: async () => [{ address: "10.0.0.8", family: 4 }],
      });

      try {
        const result = await helpers.validateCustomAnthropicSelection(
          "Custom Anthropic endpoint",
          "https://anthropic.corp.example",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          null,
          { intendedApi },
        );

        expect(result).toMatchObject({
          ok: true,
          api: intendedApi,
          pinnedAddresses: ["10.0.0.8"],
          trustedPrivateCapability: {
            host: "anthropic.corp.example",
            addresses: ["10.0.0.8"],
          },
        });
        expect(probeEndpoint).toHaveBeenCalledOnce();
        expect(probeEndpoint).toHaveBeenCalledWith(
          expectedEndpointUrl,
          "model-a",
          "test-key",
          expect.objectContaining({
            ...expectedProbeOptions,
            pinnedAddresses: ["10.0.0.8"],
            trustedPrivateCapability: expect.objectContaining({ addresses: ["10.0.0.8"] }),
          }),
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("operator-trusted private"));
      } finally {
        log.mockRestore();
        warn.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("honors an exactly allowlisted private endpoint during non-interactive validation (#6861)", async () => {
    vi.stubEnv("NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS", "llm.corp.example");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "10.0.0.8", family: 4 }],
    });

    try {
      const result = await helpers.validateCustomOpenAiLikeSelection(
        "Custom endpoint",
        "https://llm.corp.example/v1",
        "model-a",
        "COMPATIBLE_API_KEY",
      );

      expect(result).toMatchObject({
        ok: true,
        api: "openai-completions",
        pinnedAddresses: ["10.0.0.8"],
      });
      expect(result.ok && result.trustedPrivateCapability?.addresses).toEqual(["10.0.0.8"]);
      expect(promptValidationRecovery).not.toHaveBeenCalled();
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("routes an unreachable custom endpoint through transport recovery, not a silent loop (#6854)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const promptValidationRecovery = vi.fn(async () => "retry" as const);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => {
        throw new Error("getaddrinfo ENOTFOUND example.invalid");
      },
    });

    try {
      await expect(
        helpers.validateCustomOpenAiLikeSelection(
          "Custom endpoint",
          "https://example.invalid/v1",
          "model-a",
          "COMPATIBLE_API_KEY",
        ),
      ).resolves.toEqual({ ok: false, retry: "retry" });
      expect(probeOpenAiLikeEndpoint).not.toHaveBeenCalled();
      expect(promptValidationRecovery).toHaveBeenCalledWith(
        "Custom endpoint",
        expect.objectContaining({ kind: "transport", retry: "retry" }),
        "COMPATIBLE_API_KEY",
        null,
        undefined,
      );
    } finally {
      error.mockRestore();
    }
  });

  it.each(["http://127.0.0.1:8000/v1", "https://inference.local/v1", "https://93.184.216.34/v1"])(
    "carries the approved no-pin capability to probes for %s (#6293)",
    async (endpointUrl) => {
      const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
      const resolveEndpointHost = vi.fn(async () => [{ address: "10.0.0.8", family: 4 }]);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const helpers = createInferenceSelectionValidationHelpers({
        isNonInteractive: () => false,
        agentProductName: () => "OpenClaw",
        getCredential: () => "test-key",
        probeOpenAiLikeEndpoint,
        promptValidationRecovery: vi.fn(async () => "selection" as const),
        resolveEndpointHost,
      });

      try {
        await expect(
          helpers.validateCustomOpenAiLikeSelection(
            "Custom endpoint",
            endpointUrl,
            "model-a",
            "COMPATIBLE_API_KEY",
          ),
        ).resolves.toEqual({
          ok: true,
          api: "openai-completions",
          pinnedAddresses: [],
        });
        expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
          endpointUrl,
          "model-a",
          "test-key",
          expect.objectContaining({ pinnedAddresses: [] }),
        );
        expect(resolveEndpointHost).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it("exits non-interactively when a custom Anthropic endpoint resolves to link-local metadata, without probing (#6293)", async () => {
    const originalExitCode = process.exitCode;
    const probeAnthropicEndpoint = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "169.254.169.254", family: 4 }],
      teardownOrphanManagedGatewayOnAbort: vi.fn(() => true),
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic",
          "https://metadata-name.example/v1",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).rejects.toMatchObject(resumableValidationExit);
      expect(probeAnthropicEndpoint).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("tears down an orphan managed gateway before non-interactive validation exit (#8952)", async () => {
    const originalExitCode = process.exitCode;
    const teardownOrphanManagedGatewayOnAbort = vi.fn(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint: vi.fn(),
      teardownOrphanManagedGatewayOnAbort,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "169.254.169.254", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic",
          "https://metadata-name.example/v1",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).rejects.toMatchObject(resumableValidationExit);
      expect(teardownOrphanManagedGatewayOnAbort).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps validation exit terminal when abort teardown is incomplete (#9732)", async () => {
    const originalExitCode = process.exitCode;
    const teardownOrphanManagedGatewayOnAbort = vi.fn(() => false);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint: vi.fn(),
      teardownOrphanManagedGatewayOnAbort,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "169.254.169.254", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic",
          "https://metadata-name.example/v1",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).rejects.toMatchObject(terminalValidationExit);
      expect(teardownOrphanManagedGatewayOnAbort).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps validation exit terminal when abort teardown throws (#8952)", async () => {
    const originalExitCode = process.exitCode;
    const teardownOrphanManagedGatewayOnAbort = vi.fn(() => {
      throw new Error("teardown boom");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint: vi.fn(),
      teardownOrphanManagedGatewayOnAbort,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "169.254.169.254", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic",
          "https://metadata-name.example/v1",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).rejects.toMatchObject(terminalValidationExit);
      expect(teardownOrphanManagedGatewayOnAbort).toHaveBeenCalledTimes(1);
      expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("teardown boom");
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("probes a custom endpoint that resolves to a public address (#6293)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const capabilityCache = new OnboardInferenceCapabilityCache();
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    const result = await helpers.validateCustomOpenAiLikeSelection(
      "Custom endpoint",
      "https://vllm.public.test/v1",
      "model-a",
      "COMPATIBLE_API_KEY",
      null,
      capabilityCache,
    );
    expect(result).toEqual({
      ok: true,
      api: "openai-completions",
      pinnedAddresses: ["93.184.216.34"],
    });
    expect(probeOpenAiLikeEndpoint).toHaveBeenCalled();
    expect(
      capabilityCache.takeCompletedOpenAiChat({
        endpointUrl: "https://vllm.public.test/v1",
        model: "model-a",
        pinnedAddresses: ["93.184.216.34"],
      }),
    ).toBe(true);
  });

  it("requests streaming validation for OpenClaw custom Anthropic endpoints (#6289)", async () => {
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: true,
      api: "anthropic-messages",
      label: "Anthropic Messages API",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic endpoint",
          "https://compatible.example",
          "nvidia/nemotron-3-super-v3",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).resolves.toEqual({
        ok: true,
        api: "anthropic-messages",
        pinnedAddresses: ["93.184.216.34"],
      });
      expect(probeAnthropicEndpoint).toHaveBeenCalledWith(
        "https://compatible.example",
        "nvidia/nemotron-3-super-v3",
        "test-key",
        {
          probeStreaming: true,
          requireStreamingToolCalling: true,
          pinnedAddresses: ["93.184.216.34"],
        },
      );
    } finally {
      log.mockRestore();
    }
  });

  it("validates Hermes custom Anthropic routes on their intended Chat Completions surface (#6289)", async () => {
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: false,
      message: "duplicate message_start",
      failures: [
        {
          name: "Anthropic Messages API (streaming)",
          httpStatus: 200,
          curlStatus: 0,
          message: "duplicate message_start",
        },
      ],
    }));
    const probeOpenAiLikeEndpoint = vi.fn(async () => ({
      ok: true,
      api: "openai-completions",
      label: "Chat Completions API",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "Hermes",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic endpoint",
          "https://compatible.example",
          "nvidia/nemotron-3-super-v3",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          null,
          { intendedApi: "openai-completions" },
        ),
      ).resolves.toEqual({
        ok: true,
        api: "openai-completions",
        pinnedAddresses: ["93.184.216.34"],
      });
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
        "https://compatible.example/v1",
        "nvidia/nemotron-3-super-v3",
        "test-key",
        {
          calibrateTimeouts: true,
          skipResponsesProbe: true,
          pinnedAddresses: ["93.184.216.34"],
        },
      );
      expect(probeAnthropicEndpoint).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("skips Anthropic streaming validation in reasoning mode", async () => {
    vi.stubEnv("NEMOCLAW_REASONING", "yes");
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: true,
      api: "anthropic-messages",
      label: "Anthropic Messages API",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      await helpers.validateCustomAnthropicSelection(
        "Custom Anthropic endpoint",
        "https://compatible.example",
        "reasoning-model",
        "COMPATIBLE_ANTHROPIC_API_KEY",
      );
      expect(probeAnthropicEndpoint).toHaveBeenCalledWith(
        "https://compatible.example",
        "reasoning-model",
        "test-key",
        {
          probeStreaming: false,
          requireStreamingToolCalling: false,
          pinnedAddresses: ["93.184.216.34"],
        },
      );
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("pins the probe connection to the preflight-validated address against DNS rebinding (#6293)", async () => {
    // Orchestration proof: the SSRF preflight validates the endpoint host to a
    // PUBLIC address, then the probe must connect to exactly that address via
    // curl --resolve. The injected resolver would hand back a PRIVATE address on
    // a second lookup (a rebind), so if the probe re-resolved the name instead of
    // pinning, it would reach 10.0.0.5. Asserting the real probe's curl argv
    // carries --resolve <host>:<port>:93.184.216.34 proves the connection is
    // pinned to the validated public IP and cannot be rebound.
    vi.stubEnv("NEMOCLAW_REASONING", "yes");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pin-orchestration-"));
    const fakeBin = path.join(tmpDir, "bin");
    const argsPath = path.join(tmpDir, "args.txt");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${argsPath}"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$outfile" ]; then
  cat <<'JSON' > "$outfile"
{"choices":[{"message":{"content":"OK"}}]}
JSON
fi
printf '200'
exit 0
`,
      { mode: 0o755 },
    );

    let resolveCall = 0;
    const resolveEndpointHost = vi.fn(async () => {
      resolveCall += 1;
      // First lookup (the preflight) returns a public address; a hypothetical
      // second lookup would rebind to a private address.
      return resolveCall === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "10.0.0.5", family: 4 }];
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      // Use the public helper's production optimized default. A preflight pin
      // must take the bounded #6661 legacy path until native sessions enforce
      // the exact address set; --resolve proves that fallback cannot rebind.
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost,
    });

    try {
      await expect(
        helpers.validateCustomOpenAiLikeSelection(
          "Custom endpoint",
          "https://public-name.example/v1",
          "model-a",
          "COMPATIBLE_API_KEY",
        ),
      ).resolves.toEqual({
        ok: true,
        api: "openai-completions",
        pinnedAddresses: ["93.184.216.34"],
      });

      const recordedArgs = fs.readFileSync(argsPath, "utf8").split("\n");
      const resolveIdx = recordedArgs.indexOf("--resolve");
      expect(resolveIdx).toBeGreaterThanOrEqual(0);
      expect(recordedArgs[resolveIdx + 1]).toBe("public-name.example:443:93.184.216.34");
      // The rebound private address must never appear in the pin.
      expect(recordedArgs.join("\n")).not.toContain("10.0.0.5");
    } finally {
      process.env.PATH = originalPath;
      log.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps rejecting malformed native Anthropic streams for OpenClaw (#6289)", async () => {
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: false,
      message:
        "Anthropic Messages API (streaming): Anthropic Messages streaming on this endpoint " +
        "emits duplicate message_start (2 events for one request).",
      failures: [
        {
          name: "Anthropic Messages API (streaming)",
          httpStatus: 200,
          curlStatus: 0,
          message: "duplicate message_start",
          diagnosticCodes: ["anthropic-streaming-duplicate-message-start"],
        },
      ],
    }));
    const promptValidationRecovery = vi.fn(async () => "model" as const);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic endpoint",
          "https://compatible.example",
          "nvidia/nemotron-3-super-v3",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).resolves.toEqual({ ok: false, retry: "model" });
      expect(promptValidationRecovery).toHaveBeenCalledOnce();
      expect(error.mock.calls.map((args) => args.join(" ")).join("\n")).toContain(
        "Custom Anthropic endpoint endpoint validation failed.",
      );
      expect(error.mock.calls.map((args) => args.join(" ")).join("\n")).toContain(
        "Anthropic Messages API (streaming): duplicate message_start",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("suggests an OpenAI-compatible endpoint or OpenClaw when an Anthropic-only endpoint lacks Chat Completions (#6765)", async () => {
    const originalExitCode = process.exitCode;
    const probeOpenAiLikeEndpoint = vi.fn(async () => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 404 }],
    }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "Deep Agents",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
      teardownOrphanManagedGatewayOnAbort: vi.fn(() => true),
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Other Anthropic-compatible endpoint",
          "https://anthropic-only.example",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          null,
          { intendedApi: "openai-completions" },
        ),
      ).rejects.toMatchObject(resumableValidationExit);
      expect(exit).not.toHaveBeenCalled();
      expect(promptValidationRecovery).not.toHaveBeenCalled();
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain(
        "Other Anthropic-compatible endpoint endpoint validation failed.",
      );
      expect(errorOutput).toContain("OpenAI Chat Completions API (/v1/chat/completions)");
      expect(errorOutput).toContain("`nemoclaw onboard --agent openclaw`.");
      expect(errorOutput).not.toContain("nemohermes");
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("does not report a missing Chat Completions surface for a model-specific 404 (#6765)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(async () => ({
      ok: false,
      failures: [
        {
          name: "Chat Completions API",
          httpStatus: 404,
          message: "model model-a not found",
        },
      ],
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const promptValidationRecovery = vi.fn(async () => "model" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "Deep Agents",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Other Anthropic-compatible endpoint",
          "https://compatible.example",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          null,
          { intendedApi: "openai-completions" },
        ),
      ).resolves.toEqual({ ok: false, retry: "model" });
      expect(promptValidationRecovery).toHaveBeenCalledOnce();
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain(
        "Other Anthropic-compatible endpoint endpoint validation failed.",
      );
      expect(errorOutput).not.toContain("does not serve it");
      expect(errorOutput).not.toContain("switch to an Anthropic-native agent");
    } finally {
      error.mockRestore();
    }
  });

  it("does not suggest switching agents when a native Anthropic selection fails (#6765)", async () => {
    const probeAnthropicEndpoint = vi.fn(() => ({
      ok: false,
      failures: [{ name: "Anthropic Messages API", httpStatus: 404 }],
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const promptValidationRecovery = vi.fn(async () => "model" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeAnthropicEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic endpoint",
          "https://compatible.example",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).resolves.toEqual({ ok: false, retry: "model" });
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain("Custom Anthropic endpoint endpoint validation failed.");
      expect(errorOutput).not.toContain("nemoclaw onboard --agent openclaw");
    } finally {
      error.mockRestore();
    }
  });

  it("omits the agent-switch hint when the Chat Completions surface exists but rejects auth (#6765)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(async () => ({
      ok: false,
      failures: [{ name: "Chat Completions API", httpStatus: 403 }],
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const promptValidationRecovery = vi.fn(async () => "credential" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "Deep Agents",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Other Anthropic-compatible endpoint",
          "https://anthropic-only.example",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          null,
          { intendedApi: "openai-completions" },
        ),
      ).resolves.toEqual({ ok: false, retry: "credential" });
      const errorOutput = error.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(errorOutput).toContain(
        "Other Anthropic-compatible endpoint endpoint validation failed.",
      );
      expect(errorOutput).not.toContain("switch to an Anthropic-native agent");
    } finally {
      error.mockRestore();
    }
  });
});
