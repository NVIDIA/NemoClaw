// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { hostedNativeProvider } from "../../../../src/lib/inference/native-provider/hosted.ts";
import { describe, expect, it, vi } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";
import { buildConfig } from "../../../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../../../helpers/openclaw-env-fixture";

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

describe.concurrent("native provider handle refresh", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  async function runRefresh(
    config: unknown,
    env: Record<string, string> = {},
    rootMode = false,
    runtimePlan: unknown = { credentialBindings: [] },
    options: {
      readOnlyDirectory?: boolean;
      provider?: unknown;
      nvidia?: boolean;
      group?: number;
      failDirectorySync?: boolean;
    } = {},
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
      const providerPath = path.join(tmpDir, "providers.cjs");
      fs.writeFileSync(
        path.join(tmpDir, "providers.json"),
        JSON.stringify({
          openrouter: options.nvidia
            ? hostedNativeProvider("openrouter-api")
            : (options.provider ?? hostedNativeProvider("openrouter-api")),
          NVIDIA_HOSTED_NATIVE_ENDPOINT: options.nvidia
            ? options.provider.endpoint
            : "https://integrate.api.nvidia.com/v1",
          NVIDIA_HOSTED_CREDENTIAL_ENV: options.nvidia
            ? options.provider.credentialEnv
            : "NVIDIA_INFERENCE_API_KEY",
        }),
      );
      fs.writeFileSync(
        providerPath,
        `const fixture = require("./providers.json");
exports.fixedHostedNativeProvider = () => fixture.openrouter;
exports.NVIDIA_HOSTED_NATIVE_ENDPOINT = fixture.NVIDIA_HOSTED_NATIVE_ENDPOINT;
exports.NVIDIA_HOSTED_CREDENTIAL_ENV = fixture.NVIDIA_HOSTED_CREDENTIAL_ENV;`,
      );
      fs.chmodSync(configPath, 0o640);
      fs.chownSync(configPath, process.getuid(), options.group ?? fs.statSync(configPath).gid);
      fs.chmodSync(openclawDir, options.readOnlyDirectory ? 0o500 : 0o700);
      const fn = extractShellFunctionFromSource(src, "refresh_openclaw_provider_placeholders")
        .replace(
          "import tempfile",
          options.failDirectorySync
            ? `import tempfile
real_fsync = os.fsync
def sync_or_fail(fd):
    if stat.S_ISDIR(os.fstat(fd).st_mode):
        raise OSError("directory sync failed")
    return real_fsync(fd)
os.fsync = sync_or_fail`
            : "import tempfile",
        )
        .replaceAll("/sandbox/.openclaw", openclawDir)
        .replaceAll("/usr/local/share/nemoclaw/messaging-runtime-plan.json", runtimePlanPath)
        .replaceAll("/usr/local/lib/node_modules/openclaw/node_modules/json5", JSON5_MODULE)
        .replaceAll("/usr/local/bin/node", process.execPath)
        .replaceAll(
          "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
          options.provider
            ? providerPath
            : path.resolve(
                import.meta.dirname,
                "../../../../tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-direct-image-runtime.bundle",
              ),
        );
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
      return {
        config: updatedConfig,
        handoffEnv,
        result,
        mode: fs.statSync(configPath).mode & 0o777,
        group: fs.statSync(configPath).gid,
        files: fs.readdirSync(openclawDir),
      };
    } finally {
      fs.chmodSync(path.join(tmpDir, ".openclaw"), 0o700);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it.each(["v7", `s${"a".repeat(64)}`])(
    "materializes the local compatible credential generated without a handle, with scope %s",
    async (scope) => {
      const handle = `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
      const generated = buildConfig({
        ...baseOpenClawGenerationEnv(),
        NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
        NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:45173/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
      });
      const run = await runRefresh(generated, { NEMOCLAW_LOCAL_INFERENCE_TOKEN: handle });
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.config.models.providers.inference.apiKey).toBe(handle);
      expect(run.config.models.providers.inference.baseUrl).toBe(
        "http://host.openshell.internal:45173/v1",
      );
      expect(run.config.models.providers.inference.api).toBe("openai-completions");
      expect(JSON.stringify(run.config)).not.toContain("COMPATIBLE_API_KEY");
      expect(run.result.stdout + run.result.stderr).not.toContain(handle);
    },
  );

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

  it.each(
    [false, true].flatMap((rootMode) =>
      [
        { provider: "inference", key: "COMPATIBLE_API_KEY", endpoint: "http://10.1.1.225:8123/v1" },
        {
          provider: "anthropic",
          key: "COMPATIBLE_ANTHROPIC_API_KEY",
          endpoint: "https://fixture.example",
        },
        { provider: "openai", key: "OPENAI_API_KEY", endpoint: "https://api.openai.com/v1" },
      ].map((route) => ({ ...route, rootMode })),
    ),
  )(
    "refreshes only the persisted $provider credential on restart (root=$rootMode)",
    async ({ provider, key, endpoint, rootMode }) => {
      const saved = `openshell:resolve:env:v42_${key}`;
      const current = `openshell:resolve:env:s${"a".repeat(64)}_${key}`;
      const run = await runRefresh(
        {
          models: {
            providers: {
              [provider]: { baseUrl: endpoint, apiKey: saved },
              unrelated: { baseUrl: endpoint, apiKey: saved },
            },
          },
          channels: { telegram: { botToken: saved } },
        },
        { [key]: current },
        rootMode,
      );
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.config.models.providers[provider].apiKey).toBe(current);
      expect(run.config.models.providers.unrelated.apiKey).toBe(saved);
      expect(run.config.channels.telegram.botToken).toBe(saved);
    },
  );

  it.each(
    [false, true].flatMap((rootMode) =>
      [
        "",
        "raw-do-not-copy",
        "openshell:resolve:env:v43_OTHER_API_KEY",
        "openshell:resolve:env:COMPATIBLE_API_KEY",
      ].map((runtime) => ({ runtime, rootMode })),
    ),
  )(
    "keeps the saved custom credential when the runtime handle is invalid (root=$rootMode, runtime=$runtime)",
    async ({ runtime, rootMode }) => {
      const saved = "openshell:resolve:env:v42_COMPATIBLE_API_KEY";
      const run = await runRefresh(
        {
          models: {
            providers: {
              inference: {
                baseUrl: "https://fixture.example/v1",
                apiKey: saved,
              },
            },
          },
        },
        { COMPATIBLE_API_KEY: runtime },
        rootMode,
      );
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.config.models.providers.inference.apiKey).toBe(saved);
      expect(JSON.stringify(run.config)).not.toContain("raw-do-not-copy");
      expect(run.result.stderr).not.toContain("raw-do-not-copy");
      expect(run.handoffEnv).not.toContain("raw-do-not-copy");
    },
  );

  it.each([
    ["https://integrate.api.nvidia.com/v1/", "NVIDIA_INFERENCE_API_KEY"],
    ["https://openrouter.ai/api/v1/", "OPENROUTER_API_KEY"],
  ])("refreshes a native handle with a trailing slash at %s (#13043)", async (endpoint, key) => {
    const saved = `openshell:resolve:env:v42_${key}`;
    const current = `openshell:resolve:env:v43_${key}`;
    const run = await runRefresh(
      { models: { providers: { inference: { baseUrl: endpoint, apiKey: saved } } } },
      { [key]: current },
    );
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.models.providers.inference).toEqual({ baseUrl: endpoint, apiKey: current });
  });

  it.skipIf(process.getuid?.() === 0)(
    "preserves valid configuration when atomic publication cannot create a file (#13043)",
    async () => {
      const config = {
        models: {
          providers: {
            inference: {
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey: "openshell:resolve:env:v42_OPENROUTER_API_KEY",
            },
          },
        },
      };
      const run = await runRefresh(
        config,
        { OPENROUTER_API_KEY: "openshell:resolve:env:v43_OPENROUTER_API_KEY" },
        false,
        undefined,
        { readOnlyDirectory: true },
      );
      expect(run.result.status).not.toBe(0);
      expect(run.config).toEqual(config);
      expect(run.mode).toBe(0o640);
      expect(run.files).toEqual(["openclaw.json"]);
    },
  );

  it.each(["group", "directory sync"])(
    "preserves publication safety for %s (#13043)",
    async (boundary) => {
      const group = process.getgroups().find((gid) => gid !== process.getgid());
      const current = "openshell:resolve:env:v43_OPENROUTER_API_KEY";
      const run = await runRefresh(
        {
          models: {
            providers: {
              inference: {
                baseUrl: "https://openrouter.ai/api/v1",
                apiKey: "openshell:resolve:env:v42_OPENROUTER_API_KEY",
              },
            },
          },
        },
        { OPENROUTER_API_KEY: current },
        false,
        undefined,
        { group, failDirectorySync: boundary === "directory sync" },
      );
      expect(run.config.models.providers.inference.apiKey).toBe(current);
      expect(run.files).toEqual(["openclaw.json"]);
      expect(run.result.status, run.result.stderr).toBe(boundary === "group" ? 0 : 1);
      expect(run.group).toBe(group ?? process.getgid());
      expect(run.mode).toBe(0o640);
      expect(run.result.stderr).toContain(
        boundary === "group" ? "Refreshed provider placeholders" : "directory sync failed",
      );
    },
  );

  it.each([false, true])(
    "uses the canonical endpoint and credential definition (NVIDIA=%s) (#13043)",
    async (nvidia) => {
      const provider = {
        ...hostedNativeProvider("openrouter-api"),
        endpoint: "https://new.example.test/v1",
        credentialEnv: "NEW_ROUTER_KEY",
      };
      const current = "openshell:resolve:env:v43_NEW_ROUTER_KEY";
      const run = await runRefresh(
        {
          models: {
            providers: {
              inference: {
                baseUrl: provider.endpoint,
                apiKey: "openshell:resolve:env:v42_NEW_ROUTER_KEY",
              },
            },
          },
        },
        { NEW_ROUTER_KEY: current },
        false,
        undefined,
        { provider, nvidia },
      );
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.config.models.providers.inference.apiKey).toBe(current);
      expect(run.mode).toBe(0o640);
      expect(run.files).toEqual(["openclaw.json"]);
    },
  );

  describe.each([false, true])("OpenRouter refresh (root=%s)", (rootMode) => {
    it.each(["v43", `s${"a".repeat(64)}`])(
      "refreshes restored handles to generation %s (#13043)",
      async (generation) => {
        const oldHandle = "openshell:resolve:env:v42_OPENROUTER_API_KEY";
        const config = {
          models: {
            providers: {
              inference: {
                baseUrl: "https://openrouter.ai/api/v1",
                apiKey: oldHandle,
                models: [{ id: "nvidia/nemotron-3-ultra-550b-a55b" }],
              },
            },
          },
          agents: { defaults: { workspace: "/sandbox/.openclaw/workspace" } },
          channels: { telegram: { botToken: oldHandle } },
        };

        const currentHandle = `openshell:resolve:env:${generation}_OPENROUTER_API_KEY`;
        const run = await runRefresh(config, { OPENROUTER_API_KEY: currentHandle }, rootMode);
        expect(run.result.status, run.result.stderr).toBe(0);
        expect(run.config).toEqual({
          ...config,
          models: {
            providers: {
              inference: {
                ...config.models.providers.inference,
                apiKey: currentHandle,
              },
            },
          },
        });
        expect(run.result.stderr).not.toContain(currentHandle);
        const repeated = await runRefresh(
          run.config,
          { OPENROUTER_API_KEY: currentHandle },
          rootMode,
        );
        expect(repeated.result.status, repeated.result.stderr).toBe(0);
        expect(repeated.config).toEqual(run.config);
      },
    );

    it.each([
      { reason: "raw runtime key", runtime: "sk-or-test-secret" },
      { reason: "missing runtime key", runtime: "" },
      { reason: "unscoped runtime key", runtime: "openshell:resolve:env:OPENROUTER_API_KEY" },
      { reason: "wrong provider key", runtime: "openshell:resolve:env:v43_OPENAI_API_KEY" },
      { reason: "wrong key suffix", runtime: "openshell:resolve:env:v43_OPENROUTER_API_KEY_OTHER" },
      { reason: "malformed generation", runtime: "openshell:resolve:env:vbad_OPENROUTER_API_KEY" },
      {
        reason: "different endpoint",
        endpoint: "https://example.com/v1",
        runtime: "openshell:resolve:env:v43_OPENROUTER_API_KEY",
      },
      {
        reason: "endpoint query",
        endpoint: "https://openrouter.ai/api/v1/?route=other/",
        runtime: "openshell:resolve:env:v43_OPENROUTER_API_KEY",
      },
      {
        reason: "endpoint credentials",
        endpoint: "https://user@openrouter.ai/api/v1/",
        runtime: "openshell:resolve:env:v43_OPENROUTER_API_KEY",
      },
      {
        reason: "wrong saved provider",
        saved: "openshell:resolve:env:v42_OPENAI_API_KEY",
        runtime: "openshell:resolve:env:v43_OPENROUTER_API_KEY",
      },
      {
        reason: "user-managed saved key",
        saved: "user-managed-reference",
        runtime: "openshell:resolve:env:v43_OPENROUTER_API_KEY",
      },
    ])(
      "preserves OpenRouter configuration with $reason (#13043)",
      async ({ runtime, endpoint, saved }) => {
        const config = {
          models: {
            providers: {
              inference: {
                baseUrl: endpoint ?? "https://openrouter.ai/api/v1",
                apiKey: saved ?? "openshell:resolve:env:v42_OPENROUTER_API_KEY",
              },
            },
          },
        };
        const run = await runRefresh(config, { OPENROUTER_API_KEY: runtime }, rootMode);
        expect(run.result.status, run.result.stderr).toBe(0);
        expect(run.config).toEqual(config);
        expect(JSON.stringify(run.config)).not.toContain("sk-or-test-secret");
        expect(run.result.stderr).not.toContain("sk-or-test-secret");
        expect(run.handoffEnv).not.toContain("sk-or-test-secret");
      },
    );
  });

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
