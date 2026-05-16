// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../inference/config", () => ({
  INFERENCE_ROUTE_URL: "https://inference.local/v1",
  MANAGED_PROVIDER_ID: "inference",
}));

import {
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  shouldRunCompatibleEndpointSandboxSmoke,
  spawnOutputToString,
} from "./compatible-endpoint-smoke";

describe("compatible endpoint sandbox smoke helpers", () => {
  function writeSmokeConfig(tmpDir: string, model: string): string {
    const configDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { defaults: { model: { primary: `inference/${model}` } } },
        models: {
          providers: {
            inference: {
              baseUrl: "https://inference.local/v1",
              apiKey: "unused",
            },
          },
        },
      }),
    );
    return configPath;
  }

  function writeFakeCurl(tmpDir: string, bodyForCall: string): { binDir: string; callFile: string } {
    const binDir = path.join(tmpDir, "bin");
    const callFile = path.join(tmpDir, "curl-calls");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "curl"),
      `#!/usr/bin/env bash
set -eu
call_file="${callFile}"
count=0
if [ -f "$call_file" ]; then
  count="$(cat "$call_file")"
fi
count=$((count + 1))
printf '%s' "$count" >"$call_file"
${bodyForCall}
`,
      { mode: 0o755 },
    );
    return { binDir, callFile };
  }

  function runSmokeScript(script: string, tmpDir: string, binDir: string) {
    return spawnSync("sh", ["-c", script], {
      cwd: tmpDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
      },
    });
  }

  it("runs only for OpenClaw compatible-endpoint sandboxes with messaging", () => {
    expect(shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", ["telegram"])).toBe(
      true,
    );
    expect(
      shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", ["telegram"], {
        name: "openclaw",
      }),
    ).toBe(true);
    expect(
      shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", ["telegram"], {
        name: "hermes",
      }),
    ).toBe(false);
    expect(shouldRunCompatibleEndpointSandboxSmoke("nvidia-prod", ["telegram"])).toBe(false);
    expect(shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", [])).toBe(false);
  });

  it("normalizes spawn output values to strings", () => {
    expect(spawnOutputToString("already string")).toBe("already string");
    expect(spawnOutputToString(Buffer.from("buffered"))).toBe("buffered");
    expect(spawnOutputToString(null)).toBe("");
    expect(spawnOutputToString(42)).toBe("42");
  });

  it("builds a sandbox script that checks managed provider routing", () => {
    const script = buildCompatibleEndpointSandboxSmokeScript("provider/model'");

    expect(script).toContain("OPENCLAW_CONFIG_OK");
    expect(script).toContain("INFERENCE_SMOKE_OK");
    expect(script).toContain("models.providers.inference");
    expect(script).toContain("https://inference.local/v1/chat/completions");
    expect(script).toContain("INITIAL_MAX_TOKENS=256");
    expect(script).toContain("RETRY_MAX_TOKENS=1024");
    expect(script).toContain("MODEL='provider/model'\\'''");
  });

  it("retries a reasoning-only length response before failing the sandbox smoke", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-reasoning-"));
    const model = "minimaxai/minimax-m2.7";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -eq 1 ]; then
  cat <<'JSON'
{"id":"82f5ff","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning_content":"The user asked for PONG."},"finish_reason":"length"}],"usage":{"completion_tokens":32,"reasoning_tokens":32}}
JSON
else
  cat <<'JSON'
{"id":"82f5ff","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"PONG"},"finish_reason":"stop"}]}
JSON
fi
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      configPath,
      initialMaxTokens: 32,
      retryMaxTokens: 512,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OPENCLAW_CONFIG_OK");
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stderr).toContain("exhausted max_tokens=32 in reasoning_content");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("reports a model-output budget problem when the retry also has no assistant content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-no-content-"));
    const model = "minimaxai/minimax-m2.7";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
cat <<'JSON'
{"id":"82f5ff","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning_content":"Still reasoning."},"finish_reason":"length"}],"usage":{"completion_tokens":32,"reasoning_tokens":32}}
JSON
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      configPath,
      initialMaxTokens: 32,
      retryMaxTokens: 64,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("initial smoke attempt exhausted max_tokens=32");
    expect(result.stderr).toContain("retry smoke attempt still exhausted max_tokens=64");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("wraps the script as a base64 decoded temporary shell command", () => {
    const command = buildCompatibleEndpointSandboxSmokeCommand("nvidia/model");

    expect(command).toContain("set -eu");
    expect(command).toContain("base64.b64decode");
    expect(command).toContain('sh "$tmp"');
    expect(command).toContain("trap");
  });
});
