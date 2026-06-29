// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { ProviderClient, trustedProviderEndpoint } from "../fixtures/clients/provider.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";

const COMPAT_HELPER = path.join(
  import.meta.dirname,
  "..",
  "..",
  "e2e",
  "lib",
  "ci-compatible-inference.sh",
);

function secrets(values: Record<string, string | undefined>) {
  return {
    required: (name: string) => {
      const value = values[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
  };
}

type ProbeRunOptions = {
  env?: Record<string, string>;
  curlExitCode?: number;
  curlStatus?: string;
};

function runHostedProbe(options: ProbeRunOptions = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hosted-probe-"));
  const callsPath = path.join(tmpDir, "curl.calls");
  const curlPath = path.join(tmpDir, "curl");
  const scriptPath = path.join(tmpDir, "run-probe.sh");
  const curlExitCode = options.curlExitCode ?? 0;
  const curlStatus = options.curlStatus ?? "404";

  fs.writeFileSync(
    curlPath,
    `#!/bin/sh
for arg in "$@"; do
  printf 'ARG:%s\n' "$arg" >> ${JSON.stringify(callsPath)}
done
printf %s ${JSON.stringify(curlStatus)}
exit ${curlExitCode}
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
. ${JSON.stringify(COMPAT_HELPER)}
nemoclaw_e2e_probe_hosted_inference
`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
      NVIDIA_INFERENCE_API_KEY: "hosted-compatible-key",
      ...options.env,
    },
  });
  const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf-8") : "";
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { result, calls };
}

function parseKeyValueLines(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^([^=]*)=(.*)$/s);
        return match
          ? [match[1], match[2]]
          : (() => {
              throw new Error(`Expected key=value line, got: ${line}`);
            })();
      }),
  );
}

function shellResult(command: TrustedShellCommand): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [command.command, ...command.args],
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: "204",
    timedOut: false,
  };
}

function providerClientWithCalls(
  calls: Array<{ command: TrustedShellCommand; options?: ShellProbeRunOptions }>,
) {
  return new ProviderClient({
    run: async (command, options) => {
      calls.push({ command, options });
      return shellResult(command);
    },
  });
}

function runCompatibleConfigure(env: Record<string, string> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compatible-config-"));
  const scriptPath = path.join(tmpDir, "configure.sh");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
. ${JSON.stringify(COMPAT_HELPER)}
if nemoclaw_e2e_using_compatible_inference; then
  printf 'using=1\n'
else
  printf 'using=0\n'
fi
nemoclaw_e2e_configure_compatible_inference
printf 'provider=%s\n' "\${NEMOCLAW_PROVIDER:-}"
printf 'endpoint=%s\n' "\${NEMOCLAW_ENDPOINT_URL:-}"
printf 'model=%s\n' "\${NEMOCLAW_MODEL:-}"
printf 'compatModel=%s\n' "\${NEMOCLAW_COMPAT_MODEL:-}"
printf 'preferredApi=%s\n' "\${NEMOCLAW_PREFERRED_API:-}"
printf 'compatibleKey=%s\n' "\${COMPATIBLE_API_KEY:-}"
printf 'route=%s\n' "$(nemoclaw_e2e_expected_route_provider)"
printf 'modelFn=%s\n' "$(nemoclaw_e2e_hosted_inference_model)"
`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf-8",
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      NVIDIA_INFERENCE_API_KEY: "hosted-compatible-key",
      ...env,
    },
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { result, values: parseKeyValueLines(result.stdout) };
}

describe("hosted inference E2E config", () => {
  it("uses NVIDIA_INFERENCE_API_KEY as the hosted compatible endpoint source secret", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      {},
    );

    expect(cfg.sourceSecretName).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(cfg.provider).toBe("custom");
    expect(cfg.providerName).toBe("compatible-endpoint");
    expect(cfg.credentialEnv).toBe("COMPATIBLE_API_KEY");
    expect(cfg.env.COMPATIBLE_API_KEY).toBe("repo-hosted-key");
  });

  it("does not require an nvapi-prefixed source secret", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({
        NVIDIA_INFERENCE_API_KEY: "sk-compatible-key",
      }),
      {},
    );

    expect(cfg.apiKey).toBe("sk-compatible-key");
    expect(cfg.credentialEnv).toBe("COMPATIBLE_API_KEY");
  });

  it("preserves the hosted-compatible mode flag without passing source secrets by default", () => {
    const env = buildAvailabilityProbeEnv({
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NVIDIA_INFERENCE_API_KEY: "repo-hosted-key",
      RANDOM_NON_SECRET: "not-allowlisted",
    });

    expect(env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE).toBe("1");
    expect(env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(env).not.toHaveProperty("RANDOM_NON_SECRET");
  });

  it("builds provider reachability probes only from trusted endpoints", async () => {
    const calls: Array<{ command: TrustedShellCommand; options?: ShellProbeRunOptions }> = [];
    const provider = providerClientWithCalls(calls);

    const result = await provider.probeReachability(
      trustedProviderEndpoint("https://inference-api.nvidia.com/v1", {
        allowedHosts: ["inference-api.nvidia.com"],
      }),
      { artifactName: "probe" },
    );

    expect(result.stdout).toBe("204");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command.command).toBe("curl");
    expect(calls[0]?.command.args).toEqual([
      "-sS",
      "--connect-timeout",
      "10",
      "--max-time",
      "20",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "https://inference-api.nvidia.com/v1",
    ]);
  });

  it("rejects provider reachability endpoints with SSRF-shaped hosts", () => {
    expect(() => trustedProviderEndpoint("http://169.254.169.254/latest/meta-data")).toThrow(
      /private or link-local|blocked/,
    );
    expect(() =>
      trustedProviderEndpoint("https://metadata.google.internal/computeMetadata/v1"),
    ).toThrow(/blocked/);
  });

  it("uses a lightweight compatible reachability probe without API or auth requests", () => {
    const { result, calls } = runHostedProbe({
      env: {
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      },
    });

    expect(result.status).toBe(0);
    expect(calls).toContain("ARG:https://inference-api.nvidia.com/v1");
    expect(calls).not.toContain("chat/completions");
    expect(calls).not.toContain("/models");
    expect(calls).not.toContain("Authorization");
    expect(calls).not.toContain("Bearer");
  });

  it("uses a lightweight nvapi reachability probe without /models or auth", () => {
    const { result, calls } = runHostedProbe({
      env: {
        NVIDIA_INFERENCE_API_KEY: "nvapi-test-key",
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "",
        NEMOCLAW_PROVIDER: "cloud",
      },
    });

    expect(result.status).toBe(0);
    expect(calls).toContain("ARG:https://inference-api.nvidia.com/v1");
    expect(calls).not.toContain("/models");
    expect(calls).not.toContain("Authorization");
    expect(calls).not.toContain("Bearer");
  });

  it("fails hosted reachability when curl returns HTTP status 000", () => {
    const { result } = runHostedProbe({ curlStatus: "000" });

    expect(result.status).not.toBe(0);
  });

  it("fails hosted reachability when curl exits nonzero", () => {
    const { result } = runHostedProbe({ curlExitCode: 7, curlStatus: "" });

    expect(result.status).not.toBe(0);
  });

  it("configures the custom provider route for inference-api.nvidia.com", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      { NEMOCLAW_MODEL: "nvidia/custom-model" },
    );

    expect(cfg.env).toMatchObject({
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/custom-model",
      NEMOCLAW_COMPAT_MODEL: "nvidia/custom-model",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NVIDIA_INFERENCE_API_KEY: "repo-hosted-key",
      COMPATIBLE_API_KEY: "repo-hosted-key",
    });
  });

  it("preserves hosted Inference Hub model IDs and model precedence", () => {
    const defaultCfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      {},
    );
    const compatModelCfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      { NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/custom-compatible-model" },
    );
    const explicitModelCfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      {
        NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/custom-compatible-model",
        NEMOCLAW_MODEL: "nvidia/nvidia/explicit-model",
      },
      { model: "nvidia/nvidia/option-model" },
    );

    expect(defaultCfg.model).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(defaultCfg.model).not.toContain("nvidia/nvidia/nvidia/");
    expect(compatModelCfg.model).toBe("nvidia/nvidia/custom-compatible-model");
    expect(explicitModelCfg.model).toBe("nvidia/nvidia/explicit-model");
  });

  it("stages hosted-compatible shell env without requiring an nvapi key", () => {
    const { result, values } = runCompatibleConfigure({
      NVIDIA_INFERENCE_API_KEY: "sk-compatible-hosted-key",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(values).toMatchObject({
      using: "1",
      provider: "custom",
      endpoint: "https://inference-api.nvidia.com/v1",
      model: "nvidia/nvidia/nemotron-3-ultra",
      compatModel: "nvidia/nvidia/nemotron-3-ultra",
      preferredApi: "openai-completions",
      compatibleKey: "sk-compatible-hosted-key",
      route: "compatible-endpoint",
      modelFn: "nvidia/nvidia/nemotron-3-ultra",
    });
  });

  it("leaves public NVIDIA shell mode unstaged for nvapi keys", () => {
    const { result, values } = runCompatibleConfigure({
      NVIDIA_INFERENCE_API_KEY: "nvapi-public-key",
      NEMOCLAW_PROVIDER: "cloud",
      NEMOCLAW_MODEL: "nvidia/public-model",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(values).toMatchObject({
      using: "0",
      provider: "cloud",
      model: "nvidia/public-model",
      compatModel: "",
      preferredApi: "",
      compatibleKey: "",
      route: "nvidia-prod",
      modelFn: "nvidia/public-model",
    });
  });

  it("serves fake OpenAI-compatible chat and responses contracts", async () => {
    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: "fake-compatible-key",
      chatContent: "CHAT_OK",
      model: "nvidia/nvidia/fake-model",
      requireAuth: true,
      responseText: "RESP_OK",
    });

    try {
      const models = await fetch(`${fake.baseUrl}/models`);
      expect(models.status).toBe(200);
      expect(await models.json()).toMatchObject({
        data: [{ id: "nvidia/nvidia/fake-model" }],
      });

      const unauthenticatedChat = await fetch(`${fake.baseUrl}/chat/completions`, {
        body: JSON.stringify({ messages: [], model: "nvidia/nvidia/fake-model" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      expect(unauthenticatedChat.status).toBe(401);

      const chat = await fetch(`${fake.baseUrl}/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "nvidia/nvidia/fake-model",
        }),
        headers: {
          Authorization: "Bearer fake-compatible-key",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      expect(chat.status).toBe(200);
      expect(await chat.json()).toMatchObject({
        choices: [{ message: { content: "CHAT_OK" } }],
      });

      const responses = await fetch(`${fake.baseUrl}/responses`, {
        body: JSON.stringify({ input: "ping", model: "nvidia/nvidia/fake-model", stream: true }),
        headers: {
          Authorization: "Bearer fake-compatible-key",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      expect(responses.status).toBe(200);
      const responsesText = await responses.text();
      expect(responsesText).toContain("event: response.output_text.delta");
      expect(responsesText).toContain('data: {"delta":"RESP_OK"}');

      expect(fake.requests()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "GET", path: "/v1/models" }),
          expect.objectContaining({ auth: "missing", path: "/v1/chat/completions" }),
          expect.objectContaining({
            auth: "ok",
            model: "nvidia/nvidia/fake-model",
            path: "/v1/chat/completions",
            stream: false,
          }),
          expect.objectContaining({ auth: "ok", path: "/v1/responses", stream: true }),
        ]),
      );
    } finally {
      await fake.close();
    }
  });
});
