// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runSmokeScript,
  writeFakeCurl,
  writeFakeSleep,
  writeSmokeConfig,
} from "./__test-helpers__/compatible-endpoint-smoke-helpers";

vi.mock("../inference/config", () => ({
  INFERENCE_ROUTE_URL: "https://inference.local/v1",
  MANAGED_PROVIDER_ID: "inference",
}));

import {
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  shouldRunCompatibleEndpointSandboxSmoke,
  spawnOutputToString,
  verifyCompatibleEndpointSandboxSmoke,
} from "./compatible-endpoint-smoke";

describe("compatible endpoint sandbox smoke helpers", () => {
  it("runs only for OpenClaw compatible-endpoint sandboxes with messaging", () => {
    expect(shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", ["telegram"])).toBe(true);
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

  it("budgets the host command timeout for every retry attempt", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "provider ready" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "OPENCLAW_CONFIG_OK\nINFERENCE_SMOKE_OK PONG",
      });

    verifyCompatibleEndpointSandboxSmoke({
      sandboxName: "smoke-sandbox",
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-ultra",
      runOpenshell,
      redact: (value) => value,
      messagingChannels: ["telegram"],
    });

    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      expect.objectContaining({ timeout: 225_000 }),
    );
  });

  it("builds a sandbox script that checks managed provider routing", () => {
    const script = buildCompatibleEndpointSandboxSmokeScript("provider/model'");

    expect(script).toContain("OPENCLAW_CONFIG_OK");
    expect(script).toContain("INFERENCE_SMOKE_OK");
    expect(script).toContain("models.providers.inference");
    expect(script).toContain("https://inference.local/v1/chat/completions");
    expect(script).toContain("INITIAL_MAX_TOKENS=512");
    expect(script).toContain("RETRY_MAX_TOKENS=1024");
    expect(script).toContain("SMOKE_ATTEMPTS=3");
    expect(script).toContain("SMOKE_REQUEST_TIMEOUT_SECONDS=60");
    expect(script).toContain("SMOKE_RETRY_DELAY_SECONDS=5");
    expect(script).toContain("MODEL='provider/model'\\'''");
  });

  it("shell-quotes hostile model text through the generated smoke script", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-quoting-"));
    const sentinel = path.join(tmpDir, "model-command-ran");
    const model = "foo'bar`baz$(touch " + sentinel + ")";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, requestFile } = writeFakeCurl(
      tmpDir,
      `printf '%s\\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      configPath,
      retryDelaySeconds: 0,
    });
    const result = runSmokeScript(script, tmpDir, binDir);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(requestFile, "utf-8")).model).toBe(model);
    expect(fs.existsSync(sentinel)).toBe(false);
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
      attempts: 2,
      configPath,
      initialMaxTokens: 32,
      retryDelaySeconds: 0,
      retryMaxTokens: 512,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OPENCLAW_CONFIG_OK");
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stderr).toContain("exhausted max_tokens=32 in reasoning_content");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("retries a transient non-JSON gateway response", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-transient-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -eq 1 ]; then
  printf '%s\n' '<html><head><title>504 Gateway Time-out</title></head></html>'
else
  printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
fi
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stderr).toContain("inference.local returned non-JSON response");
    expect(result.stderr).toContain("smoke attempt 1/3 failed; retrying in 0s");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("retries a parseable JSON HTTP 500 response", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-json-500-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -eq 1 ]; then
  printf '%s\n' '__HTTP_STATUS__=500'
  printf '%s\n' '{"error":{"message":"temporary gateway failure"}}'
else
  printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
fi
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stderr).toContain("transient HTTP 500");
    expect(result.stderr).toContain("smoke attempt 1/3 failed; retrying in 0s");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("backs off for 5s then 10s between three attempts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-backoff-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -lt 3 ]; then
  printf '%s\n' '__HTTP_STATUS__=500'
  printf '%s\n' '{"error":{"message":"temporary gateway failure"}}'
else
  printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
fi
`,
    );
    const sleepFile = writeFakeSleep(tmpDir, binDir);
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 5,
    });
    const result = runSmokeScript(script, tmpDir, binDir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("retrying in 5s");
    expect(result.stderr).toContain("retrying in 10s");
    expect(fs.readFileSync(sleepFile, "utf-8")).toBe("5\n10\n");
  });

  it("does not retry a parseable JSON HTTP 429 response", () => {
    // Fail closed: a blind replay cannot honor Retry-After and amplifies overload.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-json-429-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
printf '%s\n' '__HTTP_STATUS__=429'
printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("INFERENCE_SMOKE_OK");
    expect(result.stderr).toContain("terminal HTTP 429");
    expect(result.stderr).not.toContain("retrying in");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("1");
  });

  it.each([
    6, 7, 28, 52, 55, 56,
  ])("retries transient curl exit %i before succeeding", (exitCode) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-curl-retry-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -eq 1 ]; then
  exit ${exitCode}
fi
printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INFERENCE_SMOKE_OK PONG");
    expect(result.stderr).toContain(`curl exit ${exitCode}`);
    expect(result.stderr).toContain("smoke attempt 1/3 failed; retrying in 0s");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("does not retry a permanent curl exit", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-curl-terminal-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(tmpDir, "exit 2");
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("curl exit 2");
    expect(result.stderr).not.toContain("retrying in");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("1");
  });

  it("does not retry a permanent JSON response validation failure", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-permanent-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      `printf '%s\\n' '{"error":{"message":"invalid model"}}'`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not contain non-empty choices[0].message.content");
    expect(result.stderr).not.toContain("retrying in");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("1");
  });

  it("fails after the bounded transient retry budget", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-exhausted-"));
    const model = "nvidia/nemotron-3-ultra";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile } = writeFakeCurl(
      tmpDir,
      "printf '%s\\n' '<html><head><title>504 Gateway Time-out</title></head><body>Authorization: Bearer test-secret</body></html>'",
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 3,
      configPath,
      retryDelaySeconds: 0,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("http_status=504");
    expect(result.stderr).toContain("response_bytes=");
    expect(result.stderr).not.toContain("test-secret");
    expect(result.stderr).toContain("smoke attempt 1/3 failed; retrying in 0s");
    expect(result.stderr).toContain("smoke attempt 2/3 failed; retrying in 0s");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("3");
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
      attempts: 2,
      configPath,
      initialMaxTokens: 32,
      retryDelaySeconds: 0,
      retryMaxTokens: 64,
    });

    const result = runSmokeScript(script, tmpDir, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("initial smoke attempt exhausted max_tokens=32");
    expect(result.stderr).toContain("retry smoke attempt still exhausted max_tokens=64");
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
  });

  it("passes the native multiline script through the OpenShell command argument", () => {
    const command = buildCompatibleEndpointSandboxSmokeCommand("nvidia/model");

    expect(command).toBe(buildCompatibleEndpointSandboxSmokeScript("nvidia/model"));
    expect(command).toContain("\n");
    expect(command).not.toContain("base64.b64decode");
  });
});
