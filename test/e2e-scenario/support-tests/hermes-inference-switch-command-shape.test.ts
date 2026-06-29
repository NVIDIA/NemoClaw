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
  hostedInstallModel,
  inferenceLocalMaxTokens,
  installHermes,
  mockAnthropicEndpointUrl,
  openshellGatewayName,
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

  it("advertises the mock through the OpenShell host alias", () => {
    expect(mockAnthropicEndpointUrl(18_766, {})).toBe("http://host.openshell.internal:18766");
    expect(
      mockAnthropicEndpointUrl(18_766, {
        NEMOCLAW_SWITCH_MOCK_HOST: "host.openshell.internal",
      }),
    ).toBe("http://host.openshell.internal:18766");
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
});
