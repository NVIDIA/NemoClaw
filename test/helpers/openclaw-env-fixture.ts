// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/**
 * Environment mechanics for the OpenClaw config-generation suites. The
 * fixture owns the ordinary valid generation environment and the fake
 * OpenClaw binary; scenario values, per-suite overrides, and assertions stay
 * in each test. Every call returns a fresh mutable object.
 */

/** The ordinary valid config-generation environment. */
export function baseOpenClawGenerationEnv(): Record<string, string> {
  return {
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
}

/** Writes an exit-0 openclaw stub into dir and returns its path. */
export function ensureFakeOpenClaw(dir: string): string {
  const fakeOpenclaw = path.join(dir, "openclaw");
  fs.writeFileSync(fakeOpenclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return fakeOpenclaw;
}

/**
 * The spawn environment the generation suites run with: the fake OpenClaw
 * on PATH, the given base entries, the overrides, and HOME at dir.
 */
export function buildOpenClawTestEnv(
  dir: string,
  baseEnv: Record<string, string>,
  overrides: Record<string, string> = {},
): Record<string, string> {
  ensureFakeOpenClaw(dir);
  return {
    PATH: `${dir}:${process.env.PATH || "/usr/bin:/bin"}`,
    ...baseEnv,
    ...overrides,
    HOME: dir,
  };
}
