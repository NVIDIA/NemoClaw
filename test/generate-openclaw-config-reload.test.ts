// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for the gateway.reload pin in scripts/generate-openclaw-config.mts
// (#4710). The in-sandbox OpenClaw gateway must run with reload mode "hot":
// in the default "hybrid" mode a restart-class config change makes the
// gateway SIGUSR1-restart itself in-process, and a failed restart parks the
// process alive with no HTTP listener — invisible to the PID-wait respawn
// loop in nemoclaw-start.sh. Split out of test/generate-openclaw-config.test.ts,
// which is at its size budget (ci/test-file-size-budget.json).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildConfig, main } from "../scripts/generate-openclaw-config.mts";

/** Minimal env vars required for a valid config generation run. */
const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_PROVIDER_KEY: "test-provider",
  NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
  CHAT_UI_URL: "http://127.0.0.1:18789",
  NEMOCLAW_INFERENCE_BASE_URL: "http://localhost:8080",
  NEMOCLAW_INFERENCE_API: "openai",
  NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("{}").toString("base64"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
  NEMOCLAW_CONTEXT_WINDOW: "131072",
  NEMOCLAW_MAX_TOKENS: "4096",
  NEMOCLAW_REASONING: "false",
  NEMOCLAW_AGENT_TIMEOUT: "600",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-reload-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function withConfigEnv<T>(envOverrides: Record<string, string>, fn: () => T): T {
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env).filter(
    (key) => key.startsWith("NEMOCLAW_") || key === "CHAT_UI_URL",
  )) {
    delete process.env[key];
  }
  Object.assign(process.env, BASE_ENV, envOverrides, { HOME: tmpDir });
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env).filter((key) => !(key in originalEnv))) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

function buildConfigDirect(envOverrides: Record<string, string> = {}): any {
  return withConfigEnv(envOverrides, () => buildConfig());
}

describe("gateway.reload pin (#4710)", () => {
  it("pins gateway.reload.mode to hot in the generated config", () => {
    const config = buildConfigDirect();
    expect(config.gateway.reload).toEqual({ mode: "hot" });
  });

  it("keeps the pin across unrelated env permutations", () => {
    const permutations: Record<string, string>[] = [
      { NEMOCLAW_WEB_SEARCH_ENABLED: "1" },
      { NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0" },
      { NEMOCLAW_AGENT_HEARTBEAT_EVERY: "5m" },
      { CHAT_UI_URL: "http://127.0.0.1:18792" },
    ];
    for (const overrides of permutations) {
      const config = buildConfigDirect(overrides);
      expect(config.gateway.reload, JSON.stringify(overrides)).toEqual({ mode: "hot" });
    }
  });

  // Generous timeout: main() does real file I/O and the suite shares a
  // worker pool with heavier integration files.
  it("re-pins hot mode when an existing config carries a different reload mode", {
    timeout: 20000,
  }, () => {
    // preserveExistingPluginInstalls() merges plugin install records from an
    // existing openclaw.json into the regenerated config; the gateway block
    // (including reload) must come from the generator, not the old file.
    const configDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { reload: { mode: "hybrid" }, auth: { token: "stale" } },
        plugins: { installs: { "custom-plugin": { origin: "npm" } } },
      }),
    );

    withConfigEnv({}, () => main());

    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.gateway.reload).toEqual({ mode: "hot" });
    // The plugin-install carryover still works alongside the pin.
    expect(written.plugins.installs["custom-plugin"]).toEqual({ origin: "npm" });
  });
});
