// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);
const JSON5_MODULE = path.join(import.meta.dirname, "../../../..", "node_modules", "json5");
const SANDBOX_JSON5_MODULE = "/usr/local/lib/node_modules/openclaw/node_modules/json5";

describe("sandbox OpenClaw config parser dependency", () => {
  it.each([
    START_SCRIPT,
    path.resolve(
      import.meta.dirname,
      "../../../../scripts/lib/refresh-openclaw-wechat-placeholder.py",
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../src/lib/messaging/channels/telegram/runtime/telegram-diagnostics.ts",
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.ts",
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../src/lib/actions/sandbox/mcp-bridge-adapter-status.ts",
    ),
    path.resolve(import.meta.dirname, "../../../../src/lib/actions/sandbox/mcp-bridge-source.ts"),
  ])(
    "loads JSON5 from the agent runtime exposed by the OpenShell filesystem policy: %s",
    (sourcePath) => {
      const source = fs.readFileSync(sourcePath, "utf-8");
      expect(source, sourcePath).toContain(SANDBOX_JSON5_MODULE);
      expect(source, sourcePath).not.toContain("/opt/nemoclaw/node_modules/json5");
    },
  );
});

describe("runtime model override (#759)", () => {
  const src = fs
    .readFileSync(START_SCRIPT, "utf-8")
    .replaceAll("/usr/local/lib/node_modules/openclaw/node_modules/json5", JSON5_MODULE)
    .replaceAll("/usr/local/bin/node", process.execPath);

  function extractShellFunction(name: string): string {
    return extractShellFunctionFromSource(src, name);
  }

  function runApplyModelOverride(env: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-override-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      `// Native OpenClaw JSON5 remains valid across restart-time overrides.\n${JSON.stringify({
        agents: { defaults: { model: { primary: "old-model" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "old-model",
                  name: "old-model",
                  contextWindow: 1024,
                  maxTokens: 128,
                  reasoning: false,
                },
              ],
            },
          },
        },
      })}`,
    );
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);

    const fn = extractShellFunction("apply_model_override").replaceAll("/sandbox", root);
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "id() { echo 0; }",
      'run_openclaw_config_as_owner() { "$@"; }',
      fn,
      "apply_model_override",
    ].join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    const config = JSON5.parse(fs.readFileSync(configPath, "utf-8"));
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config };
  }

  it("applies model, API, context, max-token, and reasoning overrides", () => {
    const { result, config } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
      NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
      NEMOCLAW_CONTEXT_WINDOW: "4096",
      NEMOCLAW_MAX_TOKENS: "512",
      NEMOCLAW_REASONING: "true",
    });

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("new-model");
    const provider = config.models.providers.inference;
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.models[0]).toMatchObject({
      id: "new-model",
      name: "new-model",
      contextWindow: 4096,
      maxTokens: 512,
      reasoning: true,
    });
  });

  it.each([
    {
      env: { NEMOCLAW_CONTEXT_WINDOW: "not-a-number" },
      message: "NEMOCLAW_CONTEXT_WINDOW must be a positive integer",
    },
    {
      env: { NEMOCLAW_CONTEXT_WINDOW: "0" },
      message: "NEMOCLAW_CONTEXT_WINDOW must be a positive integer",
    },
    {
      env: { NEMOCLAW_MAX_TOKENS: "not-a-number" },
      message: "NEMOCLAW_MAX_TOKENS must be a positive integer",
    },
    {
      env: { NEMOCLAW_MAX_TOKENS: "0" },
      message: "NEMOCLAW_MAX_TOKENS must be a positive integer",
    },
    {
      env: { NEMOCLAW_REASONING: "maybe" },
      message: 'NEMOCLAW_REASONING must be "true" or "false"',
    },
    {
      env: { NEMOCLAW_INFERENCE_API_OVERRIDE: "unexpected-api" },
      message: 'must be "openai-completions" or "anthropic-messages"',
    },
  ])("treats invalid supplemental overrides as atomic no-ops [case %#]", ({ env, message }) => {
    const { result, config } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
      ...env,
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(config.agents.defaults.model.primary).toBe("old-model");
    expect(config.models.providers.inference.api).toBe("openai-completions");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "old-model",
      name: "old-model",
      contextWindow: 1024,
      maxTokens: 128,
      reasoning: false,
    });
  });
});

describe("root OpenClaw config I/O authority", () => {
  const src = fs
    .readFileSync(START_SCRIPT, "utf-8")
    .replaceAll("/usr/local/lib/node_modules/openclaw/node_modules/json5", JSON5_MODULE)
    .replaceAll("/usr/local/bin/node", process.execPath);

  it("drops the root environment before invoking an absolute sandbox-owned writer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-writer-env-"));
    const script = path.join(root, "run.sh");
    const handoff = path.join(root, "handoff");
    const rawSecret = "SENTINEL_ROOT_ONLY_PROVIDER_SECRET";
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { printf '0\\n'; }",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "used\\n" >${JSON.stringify(handoff)}; exec "$@"' sandbox-step-down)`,
        extractShellFunctionFromSource(src, "run_openclaw_config_as_owner"),
        `export ROOT_ONLY_SECRET=${JSON.stringify(rawSecret)}`,
        'run_openclaw_config_as_owner /usr/bin/env SAFE_INPUT=reviewed /usr/bin/python3 -I -c \'import os; print(os.environ.get("SAFE_INPUT", "")); print(os.environ.get("ROOT_ONLY_SECRET", "absent")); print(os.environ.get("HOME", ""))\'',
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["reviewed", "absent", "/sandbox"]);
      expect(fs.readFileSync(handoff, "utf-8")).toBe("used\n");
      expect(result.stdout).not.toContain(rawSecret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invoke privileged pathname metadata tools around owner config I/O", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-writer-authority-"));
    const openclawDir = path.join(root, ".openclaw");
    const configPath = path.join(openclawDir, "openclaw.json");
    const metadataLog = path.join(root, "metadata.log");
    const script = path.join(root, "run.sh");
    fs.mkdirSync(openclawDir);
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { controlUi: { allowedOrigins: [] } } }),
    );
    const applyCors = extractShellFunctionFromSource(src, "apply_cors_override").replaceAll(
      "/sandbox/.openclaw",
      openclawDir,
    );
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { printf '0\\n'; }",
        `chown() { printf 'chown\\n' >>${JSON.stringify(metadataLog)}; return 97; }`,
        `chmod() { printf 'chmod\\n' >>${JSON.stringify(metadataLog)}; return 98; }`,
        'run_openclaw_config_as_owner() { "$@"; }',
        applyCors,
        "export NEMOCLAW_CORS_ORIGIN=https://owner-io.example.test",
        "apply_cors_override",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.existsSync(metadataLog)).toBe(false);
      expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toMatchObject({
        gateway: { controlUi: { allowedOrigins: ["https://owner-io.example.test"] } },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runtime CORS origin override (#719)", () => {
  const src = fs
    .readFileSync(START_SCRIPT, "utf-8")
    .replaceAll("/usr/local/lib/node_modules/openclaw/node_modules/json5", JSON5_MODULE)
    .replaceAll("/usr/local/bin/node", process.execPath);

  function extractShellFunction(name: string): string {
    return extractShellFunctionFromSource(src, name);
  }

  function runApplyCorsOverride(origin: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cors-override-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      `// Native OpenClaw JSON5 remains valid across restart-time overrides.\n${JSON.stringify({
        gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } },
      })}`,
    );
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);

    const fn = extractShellFunction("apply_cors_override").replaceAll("/sandbox", root);
    const script = path.join(root, "run.sh");
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { echo 0; }",
        'run_openclaw_config_as_owner() { "$@"; }',
        fn,
        "apply_cors_override",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, NEMOCLAW_CORS_ORIGIN: origin },
    });
    const config = JSON5.parse(fs.readFileSync(configPath, "utf-8"));
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config };
  }

  it("adds valid CORS origins", () => {
    const { result, config } = runApplyCorsOverride("https://chat.example.test");
    expect(result.status).toBe(0);
    expect(config.gateway.controlUi.allowedOrigins).toContain("https://chat.example.test");
  });

  it("rejects invalid CORS origins without mutating config", () => {
    const { result, config } = runApplyCorsOverride("javascript:alert(1)");
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("must start with http:// or https://");
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });
});
