// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";

const endpoint = "https://inference.example.com:8443/v1";
const secret = "nvapi-" + "a".repeat(40);
const resolveMissingHost = async () => {
  throw new Error("getaddrinfo ENOTFOUND");
};

it.each([
  { name: "OpenAI connection refusal", curlStatus: 7 },
  { name: "OpenAI timeout", curlStatus: 28 },
  { name: "Anthropic connection refusal", curlStatus: 7, anthropic: true },
  { name: "Anthropic OpenAI surface", curlStatus: 7, anthropic: true, openAiSurface: true },
  { name: "OpenAI DNS failure", resolveEndpointHost: resolveMissingHost, expectedProbeCalls: 0 },
  {
    name: "Anthropic DNS failure",
    resolveEndpointHost: resolveMissingHost,
    expectedProbeCalls: 0,
    anthropic: true,
  },
  {
    name: "URL credentials",
    url: "https://user-canary:password-canary@inference.example.com:8443/v1/API_KEY=path-canary?api_key=query-canary&region=west#fragment-canary",
    expectedEndpoint:
      "https://inference.example.com:8443/%3CREDACTED%3E?api_key=%3CREDACTED%3E&region=west",
  },
  {
    name: "encoded token under an ordinary query name",
    url: `${endpoint}?model=%6e${secret.slice(1)}&%2561pi_key=nested-query-canary`,
  },
  {
    name: "literal and percent-encoded tokens in the path",
    url: `${endpoint}/${secret}/%6e%76%61%70%69%2d${"a".repeat(40)}`,
    expectedEndpoint: "https://inference.example.com:8443/%3CREDACTED%3E",
  },
  {
    name: "oversized endpoint",
    url: `${endpoint}/${"x".repeat(1000)}?api_key=query-canary`,
  },
  {
    name: "malformed URL with terminal controls",
    url: "https://[invalid/\u001b[31m\n?token=query-canary",
    expectedEndpoint: "<REDACTED>",
    expectedProbeCalls: 0,
  },
])("identifies a failed custom endpoint safely: $name (#11999)", async (testCase) => {
  const originalExitCode = process.exitCode;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const teardown = vi.fn(() => true);
  const recovery = vi.fn(async () => "retry" as const);
  const probe = vi.fn(() => ({
    ok: false,
    message: secret,
    failures: [
      {
        name: "Chat Completions API",
        httpStatus: 0,
        curlStatus: testCase.curlStatus ?? 7,
        body: secret,
      },
    ],
  }));
  const helpers = createInferenceSelectionValidationHelpers({
    isNonInteractive: () => true,
    agentProductName: () => "Hermes",
    getCredential: () => secret,
    resolveEndpointHost:
      testCase.resolveEndpointHost ?? (async () => [{ address: "93.184.216.34", family: 4 }]),
    probeOpenAiLikeEndpoint: probe,
    probeAnthropicEndpoint: probe,
    teardownOrphanManagedGatewayOnAbort: teardown,
    promptValidationRecovery: recovery,
  });
  try {
    const url = testCase.url ?? endpoint;
    const validation = testCase.anthropic
      ? helpers.validateCustomAnthropicSelection(
          "Custom endpoint",
          url,
          "model-a",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          null,
          { intendedApi: testCase.openAiSurface ? "openai-completions" : "anthropic-messages" },
        )
      : helpers.validateCustomOpenAiLikeSelection(
          "Custom endpoint",
          url,
          "model-a",
          "COMPATIBLE_API_KEY",
        );
    await expect(validation).rejects.toMatchObject({
      code: 1,
      name: "OnboardDeferredExitError",
      preserveIncompleteSession: true,
    });
    expect(process.exitCode).toBe(1);
    expect(teardown).toHaveBeenCalledOnce();
    expect(recovery).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(testCase.expectedProbeCalls ?? 1);
    const output = error.mock.calls.flat().join("\n");
    const endpointLine = error.mock.calls.flat().find((line) => line.startsWith("  Endpoint:"));
    expect(endpointLine).toBeDefined();
    expect(endpointLine).toContain(testCase.expectedEndpoint ?? endpoint);
    expect(endpointLine.length).toBeLessThan(300);
    expect(endpointLine).not.toMatch(/[\u0000-\u001f\u007f]/);
    const decodedOutput = decodeURIComponent(output);
    expect(decodedOutput).not.toContain(secret);
    expect(decodedOutput).not.toMatch(
      /user-canary|password-canary|path-canary|query-canary|fragment-canary/,
    );
    expect(log).not.toHaveBeenCalled();
  } finally {
    process.exitCode = originalExitCode;
    error.mockRestore();
    log.mockRestore();
  }
});
