// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Focused tests for the default plugin entries written into openclaw.json by
// scripts/generate-openclaw-config.mts. Split out of generate-openclaw-config
// .test.ts to keep that file within its size budget.

import { describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";

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

describe("generate-openclaw-config.mts: default plugin entries", () => {
  it("omits the stale acpx entry and disables bundled bonjour by default", () => {
    const config = buildConfig({ ...BASE_ENV });
    expect(config.plugins.entries.acpx).toBeUndefined();
    expect(config.plugins.entries.bonjour).toEqual({ enabled: false });
  });

  it("does not reference the uninstalled qqbot plugin", () => {
    // qqbot is not bundled in the sandbox image, so a config entry for it makes
    // OpenClaw warn "plugin not installed: qqbot" on every first TUI launch (#6000).
    const config = buildConfig({ ...BASE_ENV });
    expect(config.plugins.entries.qqbot).toBeUndefined();
  });
});
