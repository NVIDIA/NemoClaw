// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
    optional: (name: string) => values[name],
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

  it("prefers the hosted public fallback secret when the canonical secret is not hosted", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({
        NVIDIA_INFERENCE_API_KEY: "build-only-key",
        NVIDIA_API_KEY: "nvapi-hosted-key",
      }),
      {},
    );

    expect(cfg.apiKey).toBe("nvapi-hosted-key");
    expect(cfg.sourceSecretName).toBe("NVIDIA_API_KEY");
    expect(cfg.env.COMPATIBLE_API_KEY).toBe("nvapi-hosted-key");
  });

  it("keeps the canonical hosted secret when both hosted aliases are available", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({
        NVIDIA_INFERENCE_API_KEY: "nvapi-canonical-hosted-key",
        NVIDIA_API_KEY: "nvapi-public-hosted-key",
      }),
      {},
    );

    expect(cfg.apiKey).toBe("nvapi-canonical-hosted-key");
    expect(cfg.sourceSecretName).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(cfg.env.COMPATIBLE_API_KEY).toBe("nvapi-canonical-hosted-key");
  });

  it("ignores a non-nvapi public fallback alias", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({
        NVIDIA_INFERENCE_API_KEY: "sk-compatible-key",
        NVIDIA_API_KEY: "not-hosted-public-alias",
      }),
      {},
    );

    expect(cfg.apiKey).toBe("sk-compatible-key");
    expect(cfg.sourceSecretName).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(cfg.env.COMPATIBLE_API_KEY).toBe("sk-compatible-key");
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
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/custom-model",
      NEMOCLAW_COMPAT_MODEL: "nvidia/custom-model",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      COMPATIBLE_API_KEY: "repo-hosted-key",
    });
  });

  it("preserves workflow-hosted model defaults ahead of fixture fallbacks", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      { NEMOCLAW_MODEL: "nvidia/workflow-model" },
      { model: "nvidia/scenario-model" },
    );

    expect(cfg.model).toBe("nvidia/workflow-model");
    expect(cfg.env.NEMOCLAW_MODEL).toBe("nvidia/workflow-model");
    expect(cfg.env.NEMOCLAW_COMPAT_MODEL).toBe("nvidia/workflow-model");
  });

  it("preserves an explicit hosted inference API preference", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      { NEMOCLAW_PREFERRED_API: "openai-responses" },
    );

    expect(cfg.env.NEMOCLAW_PREFERRED_API).toBe("openai-responses");
  });

  it("prefers an explicit fixture API preference over workflow defaults", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      { NEMOCLAW_PREFERRED_API: "openai-responses" },
      { preferredApi: "openai-completions" },
    );

    expect(cfg.env.NEMOCLAW_PREFERRED_API).toBe("openai-completions");
  });
});
