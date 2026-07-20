// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";

describe("inference selection validation", () => {
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

  it("preserves non-zero exit signaling when non-interactive endpoint validation fails (#5721)", async () => {
    const originalExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "nvapi-invalid-key-12345",
      probeOpenAiLikeEndpoint: () => ({
        ok: false,
        failures: [{ name: "Chat Completions API", httpStatus: 403 }],
      }),
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
      ).rejects.toThrow("Non-interactive endpoint validation failed.");
      expect(exit).toHaveBeenCalledWith(1);
      expect(process.exitCode).toBe(1);
      expect(promptValidationRecovery).not.toHaveBeenCalled();
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
    vi.stubEnv("NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS", "llm.corp.example");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      );
      expect(result).toMatchObject({
        ok: true,
        api: "openai-completions",
        pinnedAddresses: ["10.0.0.8"],
      });
      expect(result.ok && result.trustedPrivateCapability?.addresses).toEqual(["10.0.0.8"]);
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
  ])("probes an exactly allowlisted private Anthropic endpoint on its $runtimeSurface surface (#7037)", async ({
    intendedApi,
    expectedEndpointUrl,
    expectedProbeOptions,
  }) => {
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
        trustedPrivateCapability: { addresses: ["10.0.0.8"] },
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
  });

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
      );
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    "http://127.0.0.1:8000/v1",
    "https://inference.local/v1",
    "https://93.184.216.34/v1",
  ])("carries the approved no-pin capability to probes for %s (#6293)", async (endpointUrl) => {
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
  });

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
    });

    try {
      await expect(
        helpers.validateCustomAnthropicSelection(
          "Custom Anthropic",
          "https://metadata-name.example/v1",
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        ),
      ).rejects.toThrow("Non-interactive endpoint validation failed.");
      expect(probeAnthropicEndpoint).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      process.exitCode = originalExitCode;
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("probes a custom endpoint that resolves to a public address (#6293)", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    await expect(
      helpers.validateCustomOpenAiLikeSelection(
        "Custom endpoint",
        "https://vllm.public.test/v1",
        "model-a",
        "COMPATIBLE_API_KEY",
      ),
    ).resolves.toEqual({
      ok: true,
      api: "openai-completions",
      pinnedAddresses: ["93.184.216.34"],
    });
    expect(probeOpenAiLikeEndpoint).toHaveBeenCalled();
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
        { probeStreaming: true, pinnedAddresses: ["93.184.216.34"] },
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
        { probeStreaming: false, pinnedAddresses: ["93.184.216.34"] },
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
      // Use the real probeOpenAiLikeEndpoint (no injection) so the full
      // preflight → pinnedAddresses → curl --resolve chain is exercised.
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
      ).rejects.toThrow("Non-interactive endpoint validation failed.");
      expect(exit).toHaveBeenCalledWith(1);
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
