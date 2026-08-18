// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAgentInferenceApi } from "../../../src/lib/inference/config.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { compatibleAnthropicSwitchBinding } from "../fixtures/compatible-anthropic-switch.ts";
import { DEFAULT_HOSTED_INFERENCE_MODEL } from "../fixtures/hosted-inference.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  API_KEY_SHAPE_PATTERN,
  apiKeyShapeCommand,
  cleanupHermesSwitch,
  compatibleAnthropicMetadataArgs,
  expectAuthenticatedBaselineInventoryRequest,
  expectAuthenticatedProxyResolutionRequests,
  hasAuthenticatedProxyResolutionRequest,
  hostedInstallModel,
  inferenceLocalMaxTokens,
  installHermes,
  mockAnthropicSwitchEnabled,
  openAiSurfaceEndpointUrl,
  openshellGatewayName,
  parseInferenceRoute,
  runHermesInferenceSetWithRetry,
  runHermesCliPongWithRetry,
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


  it("preserves the requested frontend for other Hermes upstreams (#6289)", () => {
    expect(resolveAgentInferenceApi("hermes", "nvidia-prod", "openai-completions")).toBe(
      "openai-completions",
    );
  });

  it("omits the conflicting Anthropic frontend flag from Hermes switch metadata (#6289)", () => {
    expect(compatibleAnthropicMetadataArgs("http://host.openshell.internal:18766")).toEqual([
      "--endpoint-url",
      "http://host.openshell.internal:18766",
      "--credential-env",
      "COMPATIBLE_ANTHROPIC_API_KEY",
    ]);
  });

  it("normalizes the verified OpenAI surface URL for Hermes custom Anthropic routes (#6289)", () => {
    expect(openAiSurfaceEndpointUrl("https://inference-api.nvidia.com/")).toBe(
      "https://inference-api.nvidia.com/v1",
    );
    expect(openAiSurfaceEndpointUrl("https://inference-api.nvidia.com/v1")).toBe(
      "https://inference-api.nvidia.com/v1",
    );
  });

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

  it("uses authenticated model inventory as baseline readiness evidence", () => {
    expect(() =>
      expectAuthenticatedBaselineInventoryRequest({
        requests: () => [
          {
            auth: "ok",
            authorizationSent: true,
            bodyBytes: 0,
            method: "GET",
            path: "/v1/models",
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      expectAuthenticatedBaselineInventoryRequest({
        requests: () => [
          {
            auth: "ok",
            authorizationSent: true,
            bodyBytes: 0,
            method: "POST",
            path: "/v1/models",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts only authenticated proxy-resolution chat requests without secret markers", () => {
    expect(() =>
      expectAuthenticatedProxyResolutionRequests(
        {
          requests: () => [
            {
              auth: "ok",
              authorizationSent: true,
              bodyBytes: 64,
              forbiddenMarkerMatches: 0,
              method: "POST",
              model: "nvidia/nemotron",
              path: "/v1/chat/completions",
            },
          ],
        },
        0,
        "nvidia/nemotron",
      ),
    ).not.toThrow();

    expect(() =>
      expectAuthenticatedProxyResolutionRequests(
        {
          requests: () => [
            {
              auth: "ok",
              authorizationSent: true,
              bodyBytes: 64,
              forbiddenMarkerMatches: 1,
              method: "POST",
              model: "nvidia/nemotron",
              path: "/v1/chat/completions",
            },
          ],
        },
        0,
        "nvidia/nemotron",
      ),
    ).toThrow();
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

  it("does not retry a successful Hermes response from the wrong model", async () => {
    const probeResult = (stdout: string): ShellProbeResult =>
      ({ exitCode: 0, stdout, stderr: "" }) as ShellProbeResult;
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        probeResult('{"model":"baseline-model","choices":[{"message":{"content":"PONG"}}]}'),
      )
      .mockResolvedValueOnce(
        probeResult('{"model":"target-model","content":[{"type":"text","text":"PONG"}]}'),
      );
    const delay = vi.fn().mockResolvedValue(undefined);

    const result = await runHermesPongWithRetry({
      delay,
      expectedModel: "target-model",
      run,
    });
    expect(result.stdout).toContain("baseline-model");
    expect(run.mock.calls).toEqual([[1]]);
    expect(delay).not.toHaveBeenCalled();
  });

  it("retries an explicit Hermes transport failure and retains aggregate evidence", async () => {
    const transient = {
      exitCode: 1,
      stdout: "",
      stderr: "request failed: ECONNRESET",
    } as ShellProbeResult;
    const passed = {
      exitCode: 0,
      stdout: '{"model":"target-model","choices":[{"message":{"content":"PONG"}}]}',
      stderr: "",
    } as ShellProbeResult;
    const run = vi.fn().mockResolvedValueOnce(transient).mockResolvedValueOnce(passed);
    const delay = vi.fn().mockResolvedValue(undefined);
    const onEvidence = vi.fn();

    await expect(
      runHermesPongWithRetry({
        delay,
        expectedModel: "target-model",
        onEvidence,
        run,
      }),
    ).resolves.toBe(passed);
    expect(run.mock.calls).toEqual([[1], [2]]);
    expect(delay).toHaveBeenCalledWith(5_000);
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotence: "read-only",
        operation: "hermes-inference-switch.pong",
        outcome: "passed-after-retry",
      }),
    );
  });

  it("does not retry mixed Hermes authentication and transport evidence", async () => {
    const terminal = {
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 401 authentication failed after ECONNRESET",
    } as ShellProbeResult;
    const run = vi.fn().mockResolvedValue(terminal);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      runHermesPongWithRetry({ delay, expectedModel: "target-model", run }),
    ).resolves.toBe(terminal);
    expect(run).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it.each([
    "HTTP 403 authorization failed after ECONNRESET",
    "denied by network policy after timeout",
    "invalid JSON request after timeout",
  ])("does not retry terminal Hermes probe evidence: %s", async (stderr) => {
    const terminal = { exitCode: 1, stdout: "", stderr } as ShellProbeResult;
    const run = vi.fn().mockResolvedValue(terminal);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      runHermesPongWithRetry({ delay, expectedModel: "target-model", run }),
    ).resolves.toBe(terminal);
    expect(run).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("retries a Hermes CLI PONG until the selected route receives it", async () => {
    const requests: Array<{
      auth: string;
      authorizationSent: boolean;
      bodyBytes: number;
      forbiddenMarkerMatches: number;
      method: string;
      model: string;
      path: string;
    }> = [];
    const baseline = { requests: () => requests };
    const result = { exitCode: 0, stderr: "", stdout: "PONG\n" } as ShellProbeResult;
    const authenticatedRequest = (model: string) => ({
      auth: "ok",
      authorizationSent: true,
      bodyBytes: 64,
      forbiddenMarkerMatches: 0,
      method: "POST",
      model,
      path: "/v1/chat/completions",
    });
    const recordRouteAndReturnPong =
      (model: string) =>
      (_attempt: number): Promise<ShellProbeResult> => {
        requests.push(authenticatedRequest(model));
        return Promise.resolve(result);
      };
    const run = vi
      .fn(recordRouteAndReturnPong("selected-model"))
      .mockImplementationOnce(recordRouteAndReturnPong("stale-model"));
    const delay = vi.fn().mockResolvedValue(undefined);
    const onEvidence = vi.fn().mockResolvedValue(undefined);

    await expect(
      runHermesCliPongWithRetry({
        accept: () => hasAuthenticatedProxyResolutionRequest(baseline, 0, "selected-model"),
        delay,
        onEvidence,
        run,
      }),
    ).resolves.toBe(result);
    expect(requests).toEqual([
      authenticatedRequest("stale-model"),
      authenticatedRequest("selected-model"),
    ]);
    expect(run.mock.calls).toEqual([[1], [2]]);
    expect(delay).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(5_000);
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "hermes-inference-switch.cli-pong",
        outcome: "passed-after-retry",
        attempts: [
          expect.objectContaining({
            attempt: 1,
            failureClass: "transient-external",
            retryScheduled: true,
          }),
          expect.objectContaining({ attempt: 2, outcome: "passed", retryScheduled: false }),
        ],
      }),
    );
  });

  it.each(
    (
      [
        ["authentication failed", "authentication"],
        ["invalid credential", "authentication"],
        ["invalid API key", "authentication"],
        ["authorization failed", "authorization"],
        ["denied by network policy", "policy-denial"],
        ["malformed request", "malformed-input"],
      ] as const
    ).flatMap(([message, failureClass]) => [
      ["accepted route", message, true, failureClass] as const,
      ["pending route", message, false, failureClass] as const,
    ]),
  )(
    "does not accept or retry a CLI PONG with %s and %s",
    async (_routeState, message, accepted, failureClass) => {
      const result = { exitCode: 0, stderr: message, stdout: "PONG\n" } as ShellProbeResult;
      const run = vi.fn().mockResolvedValue(result);
      const delay = vi.fn().mockResolvedValue(undefined);
      const onEvidence = vi.fn().mockResolvedValue(undefined);

      await expect(
        runHermesCliPongWithRetry({ accept: () => accepted, delay, onEvidence, run }),
      ).resolves.toBe(result);
      expect(run).toHaveBeenCalledOnce();
      expect(delay).not.toHaveBeenCalled();
      expect(onEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed-no-retry",
          attempts: [expect.objectContaining({ failureClass, retryScheduled: false })],
        }),
      );
    },
  );

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
        "Gateway inference:\n  \u001b[2mProvider:\u001b[0m \u001b[36mcompatible-endpoint\u001b[0m\n  \u001b[2mModel:\u001b[0m \u001b[36mnvidia/nvidia/nemotron-3-super-120b-a12b\u001b[0m\n",
      ),
    ).toEqual({
      provider: "compatible-endpoint",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
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

  it("keeps a transient route verification exhaustion failed", async () => {
    const command = vi.fn().mockResolvedValueOnce({
      exitCode: 1,
      stderr: "failed to verify inference endpoint: failed to connect",
      stdout: "",
    });
    const writeJson = vi.fn().mockResolvedValue("inference-switch-retry-evidence.json");
    const compatibleBinding = compatibleAnthropicSwitchBinding(
      "http://host.openshell.internal:18766/v1",
      { COMPATIBLE_ANTHROPIC_API_KEY: "switch-key" },
    );

    await expect(
      runHermesInferenceSetWithRetry(
        { command } as unknown as HostCliClient,
        ["hosted-key", compatibleBinding.credentialValue],
        compatibleAnthropicMetadataArgs(compatibleBinding.endpointUrl),
        {
          artifacts: { writeJson },
          attempts: 1,
          compatibleBinding,
          delay: async () => {},
        },
      ),
    ).resolves.toMatchObject({ exitCode: 1 });

    expect(command.mock.calls[0]?.[1]).not.toContain("--no-verify");
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[2]).toMatchObject({
      env: { COMPATIBLE_ANTHROPIC_API_KEY: "switch-key" },
      redactionValues: ["hosted-key", "switch-key"],
    });
    expect(command.mock.calls[0]?.[2]?.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(writeJson).toHaveBeenCalledWith(
      "inference-switch-retry-evidence.json",
      expect.objectContaining({ outcome: "exhausted" }),
    );
  });

  it("retains recovered route verification evidence", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "failed to verify inference endpoint: timeout",
        stdout: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "route synced" });
    const writeJson = vi.fn().mockResolvedValue("inference-switch-retry-evidence.json");

    await expect(
      runHermesInferenceSetWithRetry({ command } as unknown as HostCliClient, ["hosted-key"], [], {
        artifacts: { writeJson },
        attempts: 2,
        delay: async () => {},
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(command).toHaveBeenCalledTimes(2);
    expect(writeJson).toHaveBeenCalledWith(
      "inference-switch-retry-evidence.json",
      expect.objectContaining({ outcome: "passed-after-retry" }),
    );
  });
});
