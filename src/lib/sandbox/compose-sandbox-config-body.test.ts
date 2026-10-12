// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";
import { NVIDIA_INFERENCE_PLACEHOLDER } from "../inference-credential";
import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "../inference/native-nvidia/contract";
import YAML from "yaml";

const {
  buildOpenClawNativeConfigBatchInvocation,
  buildOpenClawNativeConfigSetInvocation,
  composeSandboxConfigBody,
  hermesConfigAllowsPrivateUrls,
  runOpenClawNativeConfigBatchUntilHandleReady,
  writeSandboxConfig,
} = require("./config") as {
  buildOpenClawNativeConfigBatchInvocation: (
    sandboxName: string,
    updates: Array<{ dotpath: string; value: unknown }>,
    gateway?: string | OpenShellRuntimeSelection,
  ) => { args: string[]; input: string; env?: Record<string, string>; replaceEnv?: boolean };
  buildOpenClawNativeConfigSetInvocation: (
    sandboxName: string,
    dotpath: string,
    value: Record<string, unknown>,
    gateway?: string | OpenShellRuntimeSelection,
  ) => { args: string[]; input: string };
  composeSandboxConfigBody: (
    config: Record<string, unknown>,
    target: {
      agentName: string;
      configPath: string;
      configDir: string;
      format: string;
      configFile: string;
    },
  ) => string;
  hermesConfigAllowsPrivateUrls: (config: Record<string, unknown>) => boolean;
  runOpenClawNativeConfigBatchUntilHandleReady: (
    nativeNvidiaUpdate: boolean,
    run: () => { status: number; stderr: string; error?: Error; signal?: string },
    wait?: (ms: number) => void,
    warn?: (message: string) => void,
  ) => void;
  writeSandboxConfig: (
    sandboxName: string,
    target: typeof OPENCLAW_TARGET,
    config: Record<string, unknown>,
  ) => void;
};

const HERMES_TARGET = {
  agentName: "hermes",
  configPath: "/sandbox/.hermes/config.yaml",
  configDir: "/sandbox/.hermes",
  format: "yaml",
  configFile: "config.yaml",
};

const OPENCLAW_TARGET = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
};

describe("composeSandboxConfigBody", () => {
  it("prepends the upstream header and keeps the YAML body parseable for Hermes targets", () => {
    const config = {
      _nemoclaw_upstream: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      model: {
        default: "nvidia/nemotron-3-super-120b-a12b",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };

    const written = composeSandboxConfigBody(config, HERMES_TARGET);

    expect(written.startsWith("# Managed by NemoClaw")).toBe(true);
    expect(written).toContain("# Upstream provider: nvidia-prod");
    expect(written).toContain("# Upstream model: nvidia/nemotron-3-super-120b-a12b");

    const parsed = YAML.parse(written) as Record<string, unknown>;
    expect(parsed._nemoclaw_upstream).toEqual({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
    expect(parsed.model).toEqual({
      default: "nvidia/nemotron-3-super-120b-a12b",
      provider: "custom",
      base_url: "https://inference.local/v1",
    });
  });

  it("does not prepend the header for non-Hermes targets", () => {
    const config = { model: { id: "moonshotai/kimi-k2.6" } };
    const written = composeSandboxConfigBody(config, OPENCLAW_TARGET);
    expect(written.startsWith("#")).toBe(false);
    expect(JSON.parse(written)).toEqual(config);
  });

  it("refuses generic whole-file writes for OpenClaw", () => {
    expect(() => writeSandboxConfig("alpha", OPENCLAW_TARGET, {})).toThrow(
      /Refusing a whole-file OpenClaw config write/,
    );
  });

  it("streams native OpenClaw config values instead of exposing them in host argv", () => {
    const invocation = buildOpenClawNativeConfigSetInvocation(
      "alpha",
      "models.providers.inference",
      { apiKey: "sandbox-only-secret", models: [{ id: "model-a" }] },
    );

    expect(invocation.args.join(" ")).not.toContain("sandbox-only-secret");
    expect(invocation.args.join(" ")).toContain("openclaw config set --batch-file");
    expect(invocation.args.join(" ")).toContain("umask 077");
    expect(invocation.args.join(" ")).not.toContain("--batch-json");
    expect(invocation.args.join(" ")).not.toContain("models.providers.inference");
    expect(invocation.input).toContain("sandbox-only-secret");
    expect(JSON.parse(invocation.input)).toEqual([
      {
        path: "models.providers.inference",
        value: { apiKey: "sandbox-only-secret", models: [{ id: "model-a" }] },
      },
    ]);
  });

  it("sends related native OpenClaw config changes as one batch transaction", () => {
    const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
      { dotpath: "agents.defaults.model.primary", value: "inference/model-a" },
      {
        dotpath: "models.providers.inference",
        value: { apiKey: "sandbox-only-secret", models: [{ id: "model-a" }] },
      },
    ]);

    expect(invocation.args.join(" ")).toContain("openclaw config set --batch-file");
    expect(invocation.args.join(" ")).not.toContain("--batch-json");
    expect(invocation.args.join(" ")).not.toContain("sandbox-only-secret");
    expect(JSON.parse(invocation.input)).toEqual([
      { path: "agents.defaults.model.primary", value: "inference/model-a" },
      {
        path: "models.providers.inference",
        value: { apiKey: "sandbox-only-secret", models: [{ id: "model-a" }] },
      },
    ]);
  });

  it("gives a newly attached native NVIDIA handle to OpenClaw without exposing the raw key", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-config-"));
    try {
      const executable = path.join(directory, "openclaw");
      fs.writeFileSync(executable, '#!/bin/sh\ncat "$4"\n', { mode: 0o700 });
      const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
        { dotpath: "agents.defaults.model.primary", value: "inference/nvidia/model-a" },
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
            apiKey: NVIDIA_INFERENCE_PLACEHOLDER,
            api: "openai-completions",
            models: [{ id: "nvidia/model-a" }],
          },
        },
      ]);
      const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
      const handle = "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY";
      const run = (value: string | undefined) =>
        spawnSync(command[0]!, command.slice(1), {
          input: invocation.input,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            ...(value === undefined
              ? { NVIDIA_INFERENCE_API_KEY: undefined }
              : { NVIDIA_INFERENCE_API_KEY: value }),
          },
        });

      const success = run(handle);
      expect(success.status, `${success.error?.message ?? ""} ${success.stderr}`).toBe(0);
      const batch = JSON.parse(success.stdout) as Array<{ path: string; value: unknown }>;
      expect(batch).toEqual([
        { path: "agents.defaults.model.primary", value: "inference/nvidia/model-a" },
        {
          path: "models.providers.inference",
          value: {
            baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
            apiKey: handle,
            api: "openai-completions",
            models: [{ id: "nvidia/model-a" }],
          },
        },
      ]);
      expect(invocation.input).not.toContain(handle);
      expect(invocation.args.join(" ")).not.toContain(handle);
      expect(invocation.input).toContain(NVIDIA_INFERENCE_PLACEHOLDER);
      expect(invocation.input).toContain(NVIDIA_HOSTED_NATIVE_ENDPOINT);

      const wrongEndpoint = buildOpenClawNativeConfigBatchInvocation("alpha", [
        {
          dotpath: "models.providers.inference",
          value: {
            baseUrl: "https://other.example/v1",
            apiKey: NVIDIA_INFERENCE_PLACEHOLDER,
          },
        },
      ]);
      const wrongCommand = wrongEndpoint.args.slice(wrongEndpoint.args.indexOf("--") + 1);
      const refused = spawnSync(wrongCommand[0]!, wrongCommand.slice(1), {
        input: wrongEndpoint.input,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          NVIDIA_INFERENCE_API_KEY: handle,
        },
      });
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).toBe("");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { value: undefined, expectedStatus: 75 },
    { value: "nvapi-do-not-write", expectedStatus: 1 },
    { value: "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY", expectedStatus: 1 },
  ])(
    "refuses invalid native NVIDIA handle $value before config mutation",
    ({ value, expectedStatus }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-config-"));
      try {
        fs.writeFileSync(path.join(directory, "openclaw"), '#!/bin/sh\ncat "$4"\n', {
          mode: 0o700,
        });
        const invocation = buildOpenClawNativeConfigBatchInvocation("alpha", [
          {
            dotpath: "models.providers.inference",
            value: { baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT, apiKey: NVIDIA_INFERENCE_PLACEHOLDER },
          },
        ]);
        const command = invocation.args.slice(invocation.args.indexOf("--") + 1);
        const failed = spawnSync(command[0]!, command.slice(1), {
          input: invocation.input,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            NVIDIA_INFERENCE_API_KEY: value,
          },
        });
        expect(failed.status).toBe(expectedStatus);
        expect(failed.stdout).toBe("");
        expect(failed.stderr).not.toContain("nvapi-do-not-write");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("retries only a missing newly attached handle before OpenClaw mutates config", () => {
    const pending = { status: 75, stderr: "NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\n" };
    const succeeded = { status: 0, stderr: "" };
    const run = vi.fn().mockReturnValueOnce(pending).mockReturnValueOnce(succeeded);
    const wait = vi.fn();
    const warn = vi.fn();

    runOpenClawNativeConfigBatchUntilHandleReady(true, run, wait, warn);
    expect(run).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Native NVIDIA provider handle pending; config attempt 1/10",
    );

    const exhaustedRun = vi.fn().mockReturnValue(pending);
    const exhaustedWait = vi.fn();
    expect(() =>
      runOpenClawNativeConfigBatchUntilHandleReady(true, exhaustedRun, exhaustedWait, vi.fn()),
    ).toThrow("Native OpenClaw config command failed after 10 attempt(s)");
    expect(exhaustedRun).toHaveBeenCalledTimes(10);
    expect(exhaustedWait).toHaveBeenCalledTimes(9);
  });

  it.each([
    { status: 75, stderr: "unrelated failure" },
    { status: 1, stderr: "NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING" },
    { status: 1, stderr: "Native NVIDIA provider handle is unavailable or invalid" },
  ])("does not retry other native config failures: $status $stderr", (result) => {
    const failedRun = vi.fn().mockReturnValue(result);
    const wait = vi.fn();
    expect(() =>
      runOpenClawNativeConfigBatchUntilHandleReady(true, failedRun, wait, vi.fn()),
    ).toThrow("Native OpenClaw config command failed after 1 attempt(s)");
    expect(failedRun).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("pins native writes to the supplied gateway instead of the ambient selection (#11764)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "other-gateway");
    const invocation = buildOpenClawNativeConfigSetInvocation(
      "alpha",
      "models",
      {},
      "nemoclaw-9090",
    );
    expect(invocation.args.slice(0, 6)).toEqual([
      "-g",
      "nemoclaw-9090",
      "sandbox",
      "exec",
      "--name",
      "alpha",
    ]);
  });

  it("preserves authoritative workspace and TLS selection for native MCP writes (#11764)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "other-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.invalid");
    vi.stubEnv("OPENSHELL_WORKSPACE", "other-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/other/tls");
    const invocation = buildOpenClawNativeConfigBatchInvocation(
      "alpha",
      [{ dotpath: "tools.alsoAllow", value: ["bundle-mcp"] }],
      {
        gatewayName: "nemoclaw-9090",
        workspace: "recorded-workspace",
        localTlsDir: "/recorded/tls",
      },
    );
    expect(invocation.args.slice(0, 2)).toEqual(["-g", "nemoclaw-9090"]);
    expect(invocation.replaceEnv).toBe(true);
    expect(invocation.env).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw-9090",
      OPENSHELL_WORKSPACE: "recorded-workspace",
      OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
    });
    expect(invocation.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(process.env.OPENSHELL_GATEWAY).toBe("other-gateway");
  });

  it("does not prepend the header when the Hermes target writes JSON", () => {
    const written = composeSandboxConfigBody(
      { _nemoclaw_upstream: { provider: "nvidia-prod", model: "x" } },
      { ...HERMES_TARGET, format: "json", configFile: "config.json" },
    );
    expect(written.startsWith("#")).toBe(false);
  });

  it("rejects header breakout attempts via malicious upstream values", () => {
    const malicious = {
      _nemoclaw_upstream: {
        provider: "nvidia-prod\ngateway:\n  base_url: http://attacker",
        model: "victim\r\nmodel:\n  api_key: leaked",
      },
      model: { default: "victim", provider: "custom", base_url: "https://inference.local" },
    };

    const written = composeSandboxConfigBody(malicious, HERMES_TARGET);

    expect(
      written
        .split(/\r?\n/)
        .every((line) => !line || line.startsWith("#") || !line.startsWith("gateway")),
    ).toBe(true);
    const parsed = YAML.parse(written) as Record<string, unknown>;
    // Header-injected keys must NOT appear in the parsed document.
    expect(parsed.gateway).toBeUndefined();
    // The model block is the one written by the body, not the malicious smuggle.
    const model = parsed.model as Record<string, unknown>;
    expect(model.api_key).toBeUndefined();
    expect(model.base_url).toBe("https://inference.local");
  });

  it("omits the header when no upstream annotation is present", () => {
    const config = { model: { provider: "custom", base_url: "x" } };
    const written = composeSandboxConfigBody(config, HERMES_TARGET);
    expect(written.startsWith("#")).toBe(false);
    expect(YAML.parse(written)).toEqual(config);
  });

  it("keeps private URLs denied until Hermes explicitly opts in (#8614)", () => {
    expect(hermesConfigAllowsPrivateUrls({})).toBe(false);
    expect(hermesConfigAllowsPrivateUrls({ security: { allow_private_urls: false } })).toBe(false);
    expect(hermesConfigAllowsPrivateUrls({ security: { allow_private_urls: true } })).toBe(true);
  });
});
