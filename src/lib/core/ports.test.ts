// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import source directly so tests cannot pass against a stale build.
import {
  parseGatewayPort,
  parsePort,
  validateLlamaCppPortReservation,
  validateRuntimeAdapterPort,
} from "./ports";

const GATEWAY_VALIDATION_OPTIONS = {
  dashboardPort: 18789,
  dashboardRangeStart: 18789,
  dashboardRangeEnd: 18799,
  gatewayPort: 8080,
  vllmPort: 8000,
  ollamaPort: 11434,
  ollamaProxyPort: 11435,
  bedrockRuntimeAdapterPort: 11436,
  openrouterRuntimeAdapterPort: 11437,
  httpsPinRuntimeAdapterPort: 11438,
};

describe("parsePort", () => {
  const ENV_KEY = "TEST_PORT";

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it.each([
    ["an unset env var", undefined, 8080],
    ["an empty env var", "", 8080],
    ["a valid port", "9000", 9000],
    ["surrounding whitespace", "  3000  ", 3000],
    ["the lower bound", "1024", 1024],
    ["the upper bound", "65535", 65535],
  ] as const)("parses %s", (_label, value, expected) => {
    if (value !== undefined) {
      process.env[ENV_KEY] = value;
    }

    expect(parsePort(ENV_KEY, 8080)).toBe(expected);
  });

  it.each([
    ["non-numeric input", "abc", "Invalid port"],
    ["mixed alphanumeric input", "80a80", "Invalid port"],
    ["a port below 1024", "80", "1024 and 65535"],
    ["a port above 65535", "70000", "1024 and 65535"],
    ["special characters that could break pgrep patterns", ".*", "Invalid port"],
  ] as const)("rejects %s", (_label, value, expectedMessage) => {
    process.env[ENV_KEY] = value;
    expect(() => parsePort(ENV_KEY, 8080)).toThrow(expectedMessage);
  });
});

describe("parseGatewayPort", () => {
  const ENV_KEY = "TEST_GATEWAY_PORT";

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("allows the default gateway port when no override is set", () => {
    expect(parseGatewayPort(ENV_KEY, 8080, GATEWAY_VALIDATION_OPTIONS)).toBe(8080);
  });

  it("rejects the default gateway port when another service is configured there", () => {
    expect(() =>
      parseGatewayPort(ENV_KEY, 8080, {
        ...GATEWAY_VALIDATION_OPTIONS,
        vllmPort: 8080,
      }),
    ).toThrow("NEMOCLAW_VLLM_PORT");
  });

  it("accepts a non-conflicting gateway port override", () => {
    process.env[ENV_KEY] = "8990";
    expect(parseGatewayPort(ENV_KEY, 8080, GATEWAY_VALIDATION_OPTIONS)).toBe(8990);
  });

  it("rejects the dashboard auto-allocation range", () => {
    process.env[ENV_KEY] = "18790";
    expect(() => parseGatewayPort(ENV_KEY, 8080, GATEWAY_VALIDATION_OPTIONS)).toThrow(
      "18789-18799",
    );
  });

  it("rejects overlap with the configured dashboard port", () => {
    process.env[ENV_KEY] = "19000";
    expect(() =>
      parseGatewayPort(ENV_KEY, 8080, {
        ...GATEWAY_VALIDATION_OPTIONS,
        dashboardPort: 19000,
      }),
    ).toThrow("NEMOCLAW_DASHBOARD_PORT");
  });

  it("rejects overlap with a configured non-default service port", () => {
    process.env[ENV_KEY] = "19001";
    expect(() =>
      parseGatewayPort(ENV_KEY, 8080, {
        ...GATEWAY_VALIDATION_OPTIONS,
        vllmPort: 19001,
      }),
    ).toThrow("NEMOCLAW_VLLM_PORT");
  });

  it.each([
    ["8000", "vLLM / NIM inference"],
    ["11434", "Ollama inference"],
    ["11435", "Ollama auth proxy"],
    ["11436", "Bedrock Runtime adapter"],
    ["11437", "OpenRouter Runtime adapter"],
    ["11438", "HTTPS Pin Runtime adapter"],
  ])("rejects overlap with default port %s", (port, label) => {
    process.env[ENV_KEY] = port;
    expect(() => parseGatewayPort(ENV_KEY, 8080, GATEWAY_VALIDATION_OPTIONS)).toThrow(label);
  });

  it("rejects overlap with a configured Bedrock Runtime adapter port", () => {
    process.env[ENV_KEY] = "19002";
    expect(() =>
      parseGatewayPort(ENV_KEY, 8080, {
        ...GATEWAY_VALIDATION_OPTIONS,
        bedrockRuntimeAdapterPort: 19002,
      }),
    ).toThrow("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT");
  });

  it("rejects overlap with a configured OpenRouter Runtime adapter port", () => {
    process.env[ENV_KEY] = "19003";
    expect(() =>
      parseGatewayPort(ENV_KEY, 8080, {
        ...GATEWAY_VALIDATION_OPTIONS,
        openrouterRuntimeAdapterPort: 19003,
      }),
    ).toThrow("NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT");
  });

  it("rejects overlap with a configured HTTPS Pin Runtime adapter port", () => {
    process.env[ENV_KEY] = "19004";
    expect(() =>
      parseGatewayPort(ENV_KEY, 8080, {
        ...GATEWAY_VALIDATION_OPTIONS,
        httpsPinRuntimeAdapterPort: 19004,
      }),
    ).toThrow("NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT");
  });
});

describe("validateLlamaCppPortReservation", () => {
  it.each([
    "gatewayPort",
    "dashboardPort",
    "vllmPort",
    "ollamaPort",
    "ollamaProxyPort",
    "bedrockRuntimeAdapterPort",
    "openrouterRuntimeAdapterPort",
    "httpsPinRuntimeAdapterPort",
  ] as const)("rejects configured %s collision with fixed port 8081 (#8161)", (field) => {
    expect(() =>
      validateLlamaCppPortReservation({
        ...GATEWAY_VALIDATION_OPTIONS,
        [field]: 8081,
      }),
    ).toThrow(/fixed llama\.cpp inference port \(8081\)/);
  });
});

describe("validateRuntimeAdapterPort", () => {
  const ADAPTER_OWNERS = [
    ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT", 11436, "Bedrock Runtime adapter"],
    ["NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT", 11437, "OpenRouter Runtime adapter"],
    ["NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT", 11438, "HTTPS Pin Runtime adapter"],
  ] as const;

  const SHARED_CONFLICTS = [
    [8080, "NEMOCLAW_GATEWAY_PORT"],
    [8000, "vLLM / NIM inference"],
    [11434, "Ollama inference"],
    [11435, "Ollama auth proxy"],
    [18790, "18789-18799"],
  ] as const;

  it.each(ADAPTER_OWNERS)("allows the default port owned by %s", (ownerEnvVar, defaultPort) => {
    expect(() =>
      validateRuntimeAdapterPort(ownerEnvVar, defaultPort, GATEWAY_VALIDATION_OPTIONS),
    ).not.toThrow();
  });

  it.each(
    ADAPTER_OWNERS.flatMap(([ownerEnvVar, defaultPort]) =>
      [
        ...SHARED_CONFLICTS,
        ...ADAPTER_OWNERS.filter(([, otherPort]) => otherPort !== defaultPort).map(
          ([, otherPort, otherLabel]) => [otherPort, otherLabel] as const,
        ),
      ].map(([port, expectedMessage]) => [ownerEnvVar, port, expectedMessage] as const),
    ),
  )("rejects %s on %d because it overlaps %s", (ownerEnvVar, port, expectedMessage) => {
    expect(() => validateRuntimeAdapterPort(ownerEnvVar, port, GATEWAY_VALIDATION_OPTIONS)).toThrow(
      expectedMessage,
    );
  });

  it.each(ADAPTER_OWNERS)("rejects %s on a configured non-default service port", (ownerEnvVar) => {
    expect(() =>
      validateRuntimeAdapterPort(ownerEnvVar, 19001, {
        ...GATEWAY_VALIDATION_OPTIONS,
        vllmPort: 19001,
      }),
    ).toThrow("NEMOCLAW_VLLM_PORT");
  });

  it("validates against the live port configuration when no options are injected", () => {
    expect(() =>
      validateRuntimeAdapterPort("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT", 11434),
    ).toThrow("Ollama inference");
  });
});
