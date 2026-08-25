// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "../helpers/openclaw-env-fixture";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "../..",
  "scripts",
  "generate-openclaw-config.mts",
);
const SCRIPT_ARGS = ["--experimental-strip-types", SCRIPT_PATH];
const BASE_ENV = baseOpenClawGenerationEnv();

type GeneratedConfig = {
  agents: {
    defaults: {
      heartbeat?: {
        every: string;
        isolatedSession: boolean;
      };
    };
  };
};

let tmpDir: string;

function runGenerator(envOverrides: Record<string, string> = {}) {
  const result = spawnSync("node", SCRIPT_ARGS, {
    encoding: "utf8",
    env: buildOpenClawTestEnv(tmpDir, BASE_ENV, envOverrides),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  const config = JSON.parse(
    fs.readFileSync(path.join(tmpDir, ".openclaw", "openclaw.json"), "utf8"),
  ) as GeneratedConfig;
  return { config, result };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-heartbeat-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generate OpenClaw heartbeat config", () => {
  it("omits heartbeat when the cadence is unset", () => {
    const { config, result } = runGenerator();
    expect(result.status, result.stderr).toBe(0);
    expect(config.agents.defaults.heartbeat).toBeUndefined();
  });

  it("omits heartbeat for Docker's empty environment value", () => {
    const { config, result } = runGenerator({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "" });
    expect(result.status, result.stderr).toBe(0);
    expect(config.agents.defaults.heartbeat).toBeUndefined();
  });

  it("writes a configured heartbeat into an isolated session (#10262)", () => {
    const { config, result } = runGenerator({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "2m" });
    expect(result.status, result.stderr).toBe(0);
    expect(config.agents.defaults.heartbeat).toEqual({
      every: "2m",
      isolatedSession: true,
    });
  });

  it("keeps the isolated-session setting when heartbeat is disabled (#2880)", () => {
    const { config, result } = runGenerator({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "0m" });
    expect(result.status, result.stderr).toBe(0);
    expect(config.agents.defaults.heartbeat).toEqual({
      every: "0m",
      isolatedSession: true,
    });
  });

  it.each(["5 minutes", "1h30m"])(
    "rejects unsupported cadence %s and preserves the OpenClaw default",
    (heartbeatEvery) => {
      const { config, result } = runGenerator({
        NEMOCLAW_AGENT_HEARTBEAT_EVERY: heartbeatEvery,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(config.agents.defaults.heartbeat).toBeUndefined();
      expect(result.stderr).toContain(
        `[SECURITY] NEMOCLAW_AGENT_HEARTBEAT_EVERY must match ^\\d+(s|m|h)$, got "${heartbeatEvery}"`,
      );
    },
  );
});
