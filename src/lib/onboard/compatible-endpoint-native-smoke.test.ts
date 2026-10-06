// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shellQuote } from "../core/shell-quote";
import type { OpenShellSandboxBufferedCommandRequest } from "../adapters/openshell/sandbox-command";
import { describe, expect, it, vi } from "vitest";
import { nativeCompatibleEndpointIdentity } from "../inference/native-compatible/endpoint";
import {
  buildNativeCompatibleOpenClawConfigSmokeScript,
  verifyCompatibleEndpointSandboxSmoke,
} from "./compatible-endpoint-smoke";
const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../inference/native-compatible/profile", () => ({
  verifyNativeCompatibleProviderAttachment: verify,
}));

function fixture() {
  const identity = nativeCompatibleEndpointIdentity({
    endpointUrl: "https://api.example.com/v1",
    api: "openai-completions",
    addresses: ["93.184.216.34"],
  });
  const receipt = {
    schemaVersion: 1 as const,
    providerId: "owned",
    providerName: identity.providerName,
    profileId: identity.profileId,
    endpointUrl: identity.endpoint,
    api: identity.api,
    addresses: ["93.184.216.34"],
  };
  const runBuffered = vi.fn(async (_request: OpenShellSandboxBufferedCommandRequest) => ({
    outcome: { kind: "completed" as const, exitCode: 0 },
    stdout: _request.command.at(-1)?.includes("OPENCLAW_NATIVE_CONFIG_OK")
      ? "OPENCLAW_NATIVE_CONFIG_OK\n"
      : '200\n{"choices":[{"message":{"content":"PONG"}}]}',
    stderr: "",
  }));
  const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  const beforeSuccess = vi.fn();
  return {
    receipt,
    runBuffered,
    runOpenshell,
    beforeSuccess,
    options: {
      sandboxName: "selected",
      provider: "compatible-endpoint",
      model: "model-a",
      endpointUrl: identity.endpoint,
      nativeCompatibleProviderAttachment: receipt,
      sandboxCommandExecutor: { runBuffered },
      runOpenshell,
      redact: (value: string) => value,
      beforeSuccess,
    },
  };
}

describe("native compatible onboarding smoke", () => {
  it("observes attachment before invoking the native endpoint with its runtime handle", async () => {
    verify.mockReset().mockResolvedValue(undefined);
    const f = fixture();
    await verifyCompatibleEndpointSandboxSmoke(f.options);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "selected", expected: f.receipt }),
    );
    expect(f.runOpenshell).not.toHaveBeenCalled();
    expect(f.runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "selected",
        command: [
          "sh",
          "-lc",
          expect.stringContaining("https://api.example.com/v1/chat/completions"),
        ],
      }),
    );
    expect(f.runBuffered.mock.calls[1]?.[0]).toMatchObject({
      command: ["sh", "-lc", expect.stringContaining("NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY")],
    });
    expect(f.beforeSuccess).toHaveBeenCalledOnce();
  });
  it("does not mark an invalid native inference response successful", async () => {
    verify.mockReset().mockResolvedValue(undefined);
    const f = fixture();
    f.runBuffered
      .mockResolvedValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "OPENCLAW_NATIVE_CONFIG_OK\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "200\n{}",
        stderr: "",
      });
    await expect(verifyCompatibleEndpointSandboxSmoke(f.options)).rejects.toThrow(
      "invalid response body",
    );
    expect(f.beforeSuccess).not.toHaveBeenCalled();
  });

  it("does not invoke inference after attachment observation fails", async () => {
    verify.mockReset().mockRejectedValue(new Error("attachment mismatch"));
    const f = fixture();
    await expect(verifyCompatibleEndpointSandboxSmoke(f.options)).rejects.toThrow(
      "attachment mismatch",
    );
    expect(f.runBuffered).not.toHaveBeenCalled();
    expect(f.beforeSuccess).not.toHaveBeenCalled();
  });
  it("rejects a mismatched selected endpoint before gateway observation", async () => {
    verify.mockReset();
    const f = fixture();
    await expect(
      verifyCompatibleEndpointSandboxSmoke({
        ...f.options,
        endpointUrl: "https://other.example/v1",
      }),
    ).rejects.toThrow("selected endpoint");
    expect(verify).not.toHaveBeenCalled();
    expect(f.runBuffered).not.toHaveBeenCalled();
  });
});

const selectedRoute: Parameters<typeof buildNativeCompatibleOpenClawConfigSmokeScript>[0] = {
  providerKey: "inference",
  primaryModelRef: "inference/model-a",
  inferenceBaseUrl: "https://api.example.com/v1",
  inferenceApi: "openai-completions",
  inferenceCredentialEnv: "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY",
};
function openClawConfig() {
  return {
    models: {
      providers: {
        inference: {
          baseUrl: selectedRoute.inferenceBaseUrl,
          api: selectedRoute.inferenceApi,
          apiKey: "${NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY}",
        },
      },
    },
    agents: { defaults: { model: { primary: selectedRoute.primaryModelRef } } },
  };
}

const configCanary = "CONFIG-SECRET-MUST-NOT-BE-PRINTED";
type OpenClawConfigFixture = ReturnType<typeof openClawConfig>;
const nativeConfigCases: Array<{
  variant: string;
  mutate: (config: OpenClawConfigFixture) => void;
}> = [
  { variant: "valid", mutate: () => {} },
  {
    variant: "endpoint",
    mutate: (config) => {
      config.models.providers.inference.baseUrl = "https://inference.local/v1";
    },
  },
  {
    variant: "api",
    mutate: (config) => {
      config.models.providers.inference.api = "anthropic-messages";
    },
  },
  {
    variant: "credential",
    mutate: (config) => {
      config.models.providers.inference.apiKey = configCanary;
    },
  },
  {
    variant: "model",
    mutate: (config) => {
      config.agents.defaults.model.primary = "inference/stale-model";
    },
  },
  {
    variant: "provider-key",
    mutate: (config) => {
      Object.assign(config.models, { providers: { other: config.models.providers.inference } });
    },
  },
  {
    variant: "direct-provider",
    mutate: (config) => {
      Object.assign(config.models.providers, { deepinfra: { apiKey: configCanary } });
    },
  },
  { variant: "malformed", mutate: () => {} },
];
it.each(nativeConfigCases)(
  "executes native OpenClaw config verification without disclosing config ($variant)",
  ({ variant, mutate }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-openclaw-smoke-"));
    const configPath = path.join(directory, "openclaw.json");
    const config = openClawConfig();
    const canary = configCanary;
    mutate(config);
    fs.writeFileSync(configPath, variant === "malformed" ? canary : JSON.stringify(config));
    try {
      const result = spawnSync(
        "sh",
        ["-c", buildNativeCompatibleOpenClawConfigSmokeScript(selectedRoute, configPath)],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(variant === "valid" ? 0 : 1);
      expect(result.stdout).toBe(variant === "valid" ? "OPENCLAW_NATIVE_CONFIG_OK\n" : "");
      expect(result.stderr).toBe(
        variant === "valid"
          ? ""
          : "Native OpenClaw configuration does not match the selected inference route.\n",
      );
      expect(result.stdout + result.stderr).not.toContain(canary);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("refuses stale effective OpenClaw config before invoking curl or reporting success", async () => {
  verify.mockReset().mockResolvedValue(undefined);
  const f = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-openclaw-stale-"));
  const configPath = path.join(directory, "openclaw.json");
  const config = openClawConfig();
  config.models.providers.inference.baseUrl = "https://inference.local/v1";
  fs.writeFileSync(configPath, JSON.stringify(config));
  f.runBuffered.mockImplementation(async (request) => {
    const script = request.command.at(-1)!;
    expect(script).toContain("OPENCLAW_NATIVE_CONFIG_OK");
    const result = spawnSync(
      "sh",
      [
        "-c",
        script.replace(shellQuote("/sandbox/.openclaw/openclaw.json"), shellQuote(configPath)),
      ],
      { encoding: "utf8" },
    );
    return {
      outcome: { kind: "completed", exitCode: result.status ?? 1 },
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
  try {
    await expect(verifyCompatibleEndpointSandboxSmoke(f.options)).rejects.toThrow(
      "configuration does not match",
    );
    expect(f.runBuffered).toHaveBeenCalledTimes(1);
    expect(f.beforeSuccess).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("retains native invocation for non-OpenClaw agents without an OpenClaw config check", async () => {
  verify.mockReset().mockResolvedValue(undefined);
  const f = fixture();
  await verifyCompatibleEndpointSandboxSmoke({ ...f.options, agent: { name: "hermes" } });
  expect(f.runBuffered).toHaveBeenCalledTimes(1);
  expect(f.runBuffered.mock.calls[0]?.[0].command.at(-1)).not.toContain(
    "OPENCLAW_NATIVE_CONFIG_OK",
  );
  expect(f.beforeSuccess).toHaveBeenCalledOnce();
});
