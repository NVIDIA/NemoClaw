// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");
const JSON5_MODULE = path.resolve(import.meta.dirname, "../../../../nemoclaw/node_modules/json5");

vi.setConfig({ maxConcurrency: 4 });

function execFileResult(file, args, options) {
  return new Promise((resolve) =>
    execFile(file, args, options, (error, stdout, stderr) =>
      resolve({
        status: Number(error?.code) || (error ? -1 : 0),
        stdout,
        stderr,
      }),
    ),
  );
}

describe.concurrent("native NVIDIA handle refresh", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  async function runRefresh(
    config: unknown,
    env: Record<string, string> = {},
    rootMode = false,
    runtimePlan: unknown = { credentialBindings: [] },
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-placeholders-"));
    try {
      const openclawDir = path.join(tmpDir, ".openclaw");
      const configPath = path.join(openclawDir, "openclaw.json");
      const handoffEnvPath = path.join(tmpDir, "handoff-env");
      const runtimePlanPath = path.join(tmpDir, "messaging-runtime-plan.json");
      const scriptPath = path.join(tmpDir, "run.sh");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        `// Native OpenClaw JSON5\n${JSON.stringify(config, null, 2)}\n`,
      );
      fs.writeFileSync(runtimePlanPath, JSON.stringify(runtimePlan));
      const fn = extractShellFunctionFromSource(src, "refresh_openclaw_provider_placeholders")
        .replaceAll("/sandbox/.openclaw", openclawDir)
        .replaceAll("/usr/local/share/nemoclaw/messaging-runtime-plan.json", runtimePlanPath)
        .replaceAll("/usr/local/lib/node_modules/openclaw/node_modules/json5", JSON5_MODULE)
        .replaceAll("/usr/local/bin/node", process.execPath);
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail\nrefresh_openclaw_wechat_account_placeholder() { :; }",
          ...(rootMode
            ? [
                "id() { printf '0\\n'; }",
                `STEP_DOWN_PREFIX_SANDBOX=(/bin/bash -c 'env >${JSON.stringify(handoffEnvPath)}; exec "$@"' sandbox-step-down)`,
                extractShellFunctionFromSource(src, "run_openclaw_config_as_owner"),
              ]
            : ['run_openclaw_config_as_owner() { "$@"; }']),
          fn,
          "refresh_openclaw_provider_placeholders",
        ].join("\n"),
        { mode: 0o700 },
      );
      const result = await execFileResult("bash", [scriptPath], {
        encoding: "utf-8",
        env: { PATH: process.env.PATH || "", ...env },
        timeout: 5000,
      });
      const updatedConfig = JSON5.parse(fs.readFileSync(configPath, "utf-8"));
      const handoffEnv = fs.existsSync(handoffEnvPath)
        ? fs.readFileSync(handoffEnvPath, "utf-8")
        : "";
      return { config: updatedConfig, handoffEnv, result };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it.each([false, true])(
    "refreshes a persisted native NVIDIA handle after provider revision and supervisor restart (root=%s)",
    async (rootMode) => {
      const oldHandle = "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY";
      const currentHandle = "openshell:resolve:env:v43_NVIDIA_INFERENCE_API_KEY";
      const run = await runRefresh(
        {
          models: {
            providers: {
              inference: {
                baseUrl: "https://integrate.api.nvidia.com/v1",
                apiKey: oldHandle,
              },
            },
          },
          channels: { telegram: { botToken: oldHandle } },
        },
        { NVIDIA_INFERENCE_API_KEY: currentHandle },
        rootMode,
      );

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.config.models.providers.inference.apiKey).toBe(currentHandle);
      expect(run.config.channels.telegram.botToken).toBe(oldHandle);
      expect(run.result.stderr).toContain(
        "Refreshed provider placeholders from OpenShell runtime env: NVIDIA_INFERENCE_API_KEY",
      );
    },
  );

  it.each([
    {
      reason: "raw credential in root environment",
      endpoint: "https://integrate.api.nvidia.com/v1",
      runtime: "nvapi-raw-secret",
      rootMode: true,
    },
    {
      reason: "different endpoint",
      endpoint: "https://example.com/v1",
      runtime: "openshell:resolve:env:v43_NVIDIA_INFERENCE_API_KEY",
      rootMode: false,
    },
    {
      reason: "missing runtime handle",
      endpoint: "https://integrate.api.nvidia.com/v1",
      runtime: "",
      rootMode: false,
    },
  ])(
    "keeps a persisted native NVIDIA handle when refresh has $reason",
    async ({ endpoint, runtime, rootMode }) => {
      const saved = "openshell:resolve:env:v42_NVIDIA_INFERENCE_API_KEY";
      const run = await runRefresh(
        { models: { providers: { inference: { baseUrl: endpoint, apiKey: saved } } } },
        runtime ? { NVIDIA_INFERENCE_API_KEY: runtime } : {},
        rootMode,
      );

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.config.models.providers.inference.apiKey).toBe(saved);
      expect(JSON.stringify(run.config)).not.toContain("nvapi-raw-secret");
      expect(run.result.stderr).not.toContain("nvapi-raw-secret");
      expect(run.handoffEnv).not.toContain("nvapi-raw-secret");
    },
  );
});
