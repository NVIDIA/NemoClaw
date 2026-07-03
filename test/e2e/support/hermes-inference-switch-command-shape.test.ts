// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { DEFAULT_HOSTED_INFERENCE_MODEL } from "../fixtures/hosted-inference.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  API_KEY_SHAPE_PATTERN,
  apiKeyShapeCommand,
  cleanupHermesSwitch,
  compatibleHostedSwitchEnabled,
  ensureCompatibleHostedSwitchProvider,
  env,
  HOSTED_BASELINE_MODEL,
  hostedInstallModel,
  inferenceLocalMaxTokens,
  installHermes,
  mockAnthropicEndpointUrl,
  mockAnthropicSwitchEnabled,
  openshellGatewayName,
  parseInferenceRoute,
  runHermesInferenceSetWithRetry,
  runHermesPongWithRetry,
  SANDBOX_NAME,
} from "../live/hermes-inference-switch-helpers.ts";

describe("Hermes inference switch command shape", () => {
  afterEach(() => vi.unstubAllEnvs());

  function matchesApiKeyShape(line: string): boolean {
    return (
      spawnSync("grep", ["-Eq", API_KEY_SHAPE_PATTERN], {
        encoding: "utf8",
        input: `${line}\n`,
      }).status === 0
    );
  }

  it("uses direct single-line argv for the in-sandbox API-key probe", () => {
    const command = apiKeyShapeCommand();

    expect(command).toEqual(["grep", "-Eq", API_KEY_SHAPE_PATTERN, "/sandbox/.hermes/config.yaml"]);
    expect(command.every((argument) => !/[\r\n]/u.test(argument))).toBe(true);
  });

  it("accepts only complete sk-prefixed YAML scalars", () => {
    expect(
      ["  api_key: sk-value", '  api_key: "sk-value"', "  api_key: 'sk-value'"].every(
        matchesApiKeyShape,
      ),
    ).toBe(true);
    expect(
      [
        "  api_key: not-sk-value",
        "  api_key: sk-value trailing",
        '  api_key: "sk-value',
        '  api_key: sk-value"',
      ].some(matchesApiKeyShape),
    ).toBe(false);
  });

  it("keeps initial hosted onboarding independent from the switch target", () => {
    expect(hostedInstallModel({ NEMOCLAW_SWITCH_MODEL: "mock-anthropic-model" })).toBe(
      DEFAULT_HOSTED_INFERENCE_MODEL,
    );
    expect(
      hostedInstallModel({
        NEMOCLAW_MODEL: "initial-hosted-model",
        NEMOCLAW_SWITCH_MODEL: "target-switch-model",
      }),
    ).toBe("initial-hosted-model");
  });

  it("recognizes only the hosted OpenAI-compatible switch lane", () => {
    expect(
      compatibleHostedSwitchEnabled({
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_SWITCH_INFERENCE_API: "openai-completions",
        NEMOCLAW_SWITCH_PROVIDER: "compatible-endpoint",
      }),
    ).toBe(true);
    expect(
      compatibleHostedSwitchEnabled({
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
        NEMOCLAW_SWITCH_PROVIDER: "compatible-anthropic-endpoint",
      }),
    ).toBe(false);
    expect(compatibleHostedSwitchEnabled({})).toBe(false);
  });

  it("advertises the mock through the OpenShell host alias", () => {
    expect(mockAnthropicEndpointUrl(18_766, {})).toBe("http://host.openshell.internal:18766");
    expect(
      mockAnthropicEndpointUrl(18_766, {
        NEMOCLAW_SWITCH_MOCK_HOST: "host.openshell.internal",
      }),
    ).toBe("http://host.openshell.internal:18766");
  });

  it("enables local baseline inference only for the mock Anthropic lane", () => {
    const mockAnthropic = {
      NEMOCLAW_SWITCH_PROVIDER: "compatible-anthropic-endpoint",
      NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
      NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "1",
    };
    expect(mockAnthropicSwitchEnabled(mockAnthropic)).toBe(true);
    expect(
      mockAnthropicSwitchEnabled({
        ...mockAnthropic,
        NEMOCLAW_SWITCH_PROVIDER: "compatible-endpoint",
      }),
    ).toBe(false);
    expect(
      mockAnthropicSwitchEnabled({ ...mockAnthropic, NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "0" }),
    ).toBe(false);
    expect(mockAnthropicSwitchEnabled({})).toBe(false);
  });

  it("retries live PONG probes before returning the final result", async () => {
    const probeResult = (stdout: string): ShellProbeResult =>
      ({ exitCode: 0, stdout, stderr: "" }) as ShellProbeResult;
    const run = vi
      .fn()
      .mockResolvedValueOnce(probeResult('{"error":"no compatible inference route available"}'))
      .mockResolvedValueOnce(probeResult('{"content":[{"type":"text","text":"PONG"}]}'));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(runHermesPongWithRetry({ delay, run })).resolves.toMatchObject({ exitCode: 0 });
    expect(run.mock.calls).toEqual([[1], [2]]);
    expect(delay).toHaveBeenCalledWith(5_000);
  });

  it("parses exact provider and model values from an inference route", () => {
    expect(
      parseInferenceRoute(
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      ),
    ).toEqual({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
  });

  it("parses Provider and Model labels wrapped in OpenShell ANSI styling", () => {
    expect(
      parseInferenceRoute(
        "Gateway inference:\n  \u001b[2mProvider:\u001b[0m \u001b[36mcompatible-endpoint\u001b[0m\n  \u001b[2mModel:\u001b[0m \u001b[36mnvidia/nvidia/nemotron-3-ultra\u001b[0m\n",
      ),
    ).toEqual({
      provider: "compatible-endpoint",
      model: "nvidia/nvidia/nemotron-3-ultra",
    });
  });

  it("keeps the Anthropic direct probe within the frozen E2E token budget", () => {
    expect(inferenceLocalMaxTokens("anthropic-messages")).toBe(32);
    expect(inferenceLocalMaxTokens("openai-completions")).toBe(100);
  });

  it("discards failed onboarding state before an install attempt", async () => {
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    await installHermes({ command } as unknown as HostCliClient, "hosted-key");

    expect(command.mock.calls[0]?.[1]).toEqual([
      "install.sh",
      "--non-interactive",
      "--fresh",
      "--yes-i-accept-third-party-software",
    ]);
  });

  it("passes an authenticated local baseline only to the requested install", async () => {
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const baselineEnv = {
      COMPATIBLE_API_KEY: "fixture-key",
      NEMOCLAW_ENDPOINT_URL: "http://127.0.0.1:34567/v1",
      NEMOCLAW_MODEL: "fixture-model",
      NEMOCLAW_PROVIDER: "custom",
    };

    await installHermes({ command } as unknown as HostCliClient, "fixture-key", baselineEnv);

    expect(command.mock.calls[0]?.[2]).toMatchObject({
      env: baselineEnv,
      redactionValues: ["fixture-key"],
    });
  });

  it("installs the hosted lane from a public NVIDIA baseline without staging compatible credentials", async () => {
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const baselineEnv = {
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "0",
      NEMOCLAW_MODEL: HOSTED_BASELINE_MODEL,
      NEMOCLAW_PROVIDER: "build",
    };

    await installHermes(
      { command } as unknown as HostCliClient,
      "nvapi-public-baseline-key",
      baselineEnv,
      { stageCompatibleHosted: false },
    );

    expect(command.mock.calls[0]?.[2]).toMatchObject({
      env: {
        ...baselineEnv,
        NVIDIA_INFERENCE_API_KEY: "nvapi-public-baseline-key",
      },
      redactionValues: ["nvapi-public-baseline-key"],
    });
    expect(command.mock.calls[0]?.[2]?.env).not.toHaveProperty("COMPATIBLE_API_KEY");
    expect(command.mock.calls[0]?.[2]?.env).not.toHaveProperty("NEMOCLAW_ENDPOINT_URL");
  });

  it("registers the hosted compatible target with its own endpoint and credential", async () => {
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await expect(
      ensureCompatibleHostedSwitchProvider(
        { command } as unknown as HostCliClient,
        "hosted-compatible-key",
        {
          NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
          NEMOCLAW_SWITCH_INFERENCE_API: "openai-completions",
          NEMOCLAW_SWITCH_PROVIDER: "compatible-endpoint",
        },
      ),
    ).resolves.toBe("https://inference-api.nvidia.com/v1");

    const [program, args, options] = command.mock.calls[0]!;
    expect(program).toBe("bash");
    expect(args[1]).toContain("provider create -g nemoclaw --name compatible-endpoint");
    expect(args[1]).toContain("provider update -g nemoclaw compatible-endpoint");
    expect(args[1]).toContain("OPENAI_BASE_URL=${SWITCH_ENDPOINT_URL}");
    expect(options).toMatchObject({
      env: {
        COMPATIBLE_API_KEY: "hosted-compatible-key",
        SWITCH_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      },
      redactionValues: ["hosted-compatible-key"],
    });
    expect(options.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
  });

  it("can suppress hosted-compatible staging for a public NVIDIA child env", () => {
    const childEnv = env(
      "nvapi-public-baseline-key",
      { NEMOCLAW_PROVIDER: "build" },
      { stageCompatibleHosted: false },
    );

    expect(childEnv.NVIDIA_INFERENCE_API_KEY).toBe("nvapi-public-baseline-key");
    expect(childEnv.COMPATIBLE_API_KEY).toBeUndefined();
    expect(childEnv.NEMOCLAW_ENDPOINT_URL).toBeUndefined();
  });

  it("resets the sandbox and gateway before each isolated attempt", async () => {
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const openshell = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await cleanupHermesSwitch(
      { command } as unknown as HostCliClient,
      { openshell } as unknown as SandboxClient,
    );

    expect(command.mock.calls[0]?.[1]).toEqual([
      expect.stringContaining("nemoclaw.js"),
      SANDBOX_NAME,
      "destroy",
      "--yes",
      "--cleanup-gateway",
    ]);
    expect(openshell.mock.calls.map(([args]) => args)).toEqual([
      ["sandbox", "delete", SANDBOX_NAME],
    ]);
  });

  it("passes the configured OpenShell gateway to cleanup", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "alternate-gateway");
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const openshell = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await cleanupHermesSwitch(
      { command } as unknown as HostCliClient,
      { openshell } as unknown as SandboxClient,
    );

    expect(openshellGatewayName()).toBe("alternate-gateway");
    expect(command.mock.calls[0]?.[2]).toMatchObject({
      env: { OPENSHELL_GATEWAY: "alternate-gateway" },
    });
  });

  it("falls back to no-verify only after transient route verification fails", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "failed to verify inference endpoint: failed to connect",
        stdout: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });

    await expect(
      runHermesInferenceSetWithRetry(
        { command } as unknown as HostCliClient,
        "hosted-key",
        ["--inference-api", "anthropic-messages"],
        { attempts: 1, delay: async () => {} },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(command.mock.calls[0]?.[1]).not.toContain("--no-verify");
    expect(command.mock.calls[1]?.[1]).toContain("--no-verify");
  });

  it("passes a hosted switch key only through COMPATIBLE_API_KEY", async () => {
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await runHermesInferenceSetWithRetry(
      { command } as unknown as HostCliClient,
      "hosted-switch-key",
      [
        "--endpoint-url",
        "https://inference-api.nvidia.com/v1",
        "--credential-env",
        "COMPATIBLE_API_KEY",
        "--inference-api",
        "openai-completions",
      ],
      { attempts: 1, credentialEnv: "COMPATIBLE_API_KEY", delay: async () => {} },
    );

    const childEnv = command.mock.calls[0]?.[2]?.env;
    expect(childEnv).toMatchObject({ COMPATIBLE_API_KEY: "hosted-switch-key" });
    expect(childEnv).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
  });
});
