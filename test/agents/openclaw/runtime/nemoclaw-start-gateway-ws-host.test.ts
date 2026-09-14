// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../../../..");
const startScript = fs.readFileSync(path.join(repoRoot, "scripts", "nemoclaw-start.sh"), "utf8");

function runtimeShellEnvFunction(): string {
  const start = startScript.indexOf("write_runtime_shell_env() {");
  const end = startScript.indexOf("# cleanup_on_signal", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return startScript.slice(start, end);
}

function generateRuntimeEnv(tmpDir: string, environment: Record<string, string> = {}): string {
  const envFile = path.join(tmpDir, "nemoclaw-proxy-env.sh");
  const fn = runtimeShellEnvFunction().replaceAll(
    '"/tmp/nemoclaw-proxy-env.sh"',
    JSON.stringify(envFile),
  );
  const script = [
    "set -euo pipefail",
    '_PROXY_URL="http://10.200.0.1:3128"',
    '_NO_PROXY_VAL="localhost,127.0.0.1,::1"',
    `_SANDBOX_SAFETY_NET=${JSON.stringify(path.join(tmpDir, "safety-net.js"))}`,
    `_PROXY_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "proxy-fix.js"))}`,
    `_NEMOTRON_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "nemotron-fix.js"))}`,
    "NODE_USE_ENV_PROXY=",
    "_TOOL_REDIRECTS=()",
    "emit_messaging_connect_runtime_preload_exports() { :; }",
    'emit_sandbox_sourced_file() { cat > "$1"; chmod 444 "$1"; }',
    fn,
    "write_runtime_shell_env",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      OPENCLAW_GATEWAY_PORT: "19123",
      OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
      ...environment,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return envFile;
}

function sourceRuntimeEnv(envFile: string, environment: Record<string, string> = {}): string {
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `. ${JSON.stringify(envFile)}; printf 'URL=%s TOKEN=%s PORT=%s INSECURE=%s\\n' "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS-unset}"`,
    ],
    { encoding: "utf8", env: { ...process.env, ...environment } },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("native sandbox gateway loopback", () => {
  it("does not synthesize a private-interface URL or insecure WebSocket exception", () => {
    expect(startScript).toContain("export OPENCLAW_GATEWAY_PORT");
    expect(startScript).not.toContain("NEMOCLAW_GATEWAY_WS_HOST");
    expect(startScript).not.toContain("hostname -I");
    expect(startScript).not.toContain("NEMOCLAW_OPENCLAW_GATEWAY_URL");
    expect(startScript).not.toContain("NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS");
  });

  it("keeps the native URL unset and preserves the configured custom port", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-loopback-"));
    try {
      const envFile = generateRuntimeEnv(tmpDir);
      expect(sourceRuntimeEnv(envFile)).toBe(
        "URL=unset TOKEN=test-gateway-token PORT=19123 INSECURE=unset\n",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves an explicit loopback endpoint and its gateway token", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-explicit-loopback-"));
    try {
      const url = "ws://127.0.0.1:19123";
      const envFile = generateRuntimeEnv(tmpDir, { OPENCLAW_GATEWAY_URL: url });
      expect(sourceRuntimeEnv(envFile, { OPENCLAW_GATEWAY_URL: url })).toContain(
        `URL=${url} TOKEN=test-gateway-token PORT=19123`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves a remote endpoint without forwarding the local gateway token", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-explicit-remote-"));
    try {
      const url = "wss://gateway.example.test:443";
      const envFile = generateRuntimeEnv(tmpDir, { OPENCLAW_GATEWAY_URL: url });
      expect(sourceRuntimeEnv(envFile, { OPENCLAW_GATEWAY_URL: url })).toContain(
        `URL=${url} TOKEN= PORT=19123`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
