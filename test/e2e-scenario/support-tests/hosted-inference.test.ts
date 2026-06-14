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
    required: (name: string) => {
      const value = values[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
  };
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

  it("uses a lightweight reachability probe instead of spending an inference request", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hosted-probe-"));
    try {
      const curlPath = path.join(tmpDir, "curl");
      const callsPath = path.join(tmpDir, "curl.calls");
      fs.writeFileSync(
        curlPath,
        `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
case "$*" in
  *chat/completions*) exit 88 ;;
esac
printf '404'
exit 0
`,
        { mode: 0o755 },
      );

      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
export PATH=${JSON.stringify(`${tmpDir}:${process.env.PATH ?? ""}`)}
export NVIDIA_INFERENCE_API_KEY=hosted-compatible-key
export NEMOCLAW_E2E_USE_HOSTED_INFERENCE=1
. ${JSON.stringify(COMPAT_HELPER)}
nemoclaw_e2e_probe_hosted_inference
`,
        ],
        { encoding: "utf-8" },
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(callsPath, "utf-8")).not.toContain("chat/completions");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
      COMPATIBLE_API_KEY: "repo-hosted-key",
    });
  });
});
