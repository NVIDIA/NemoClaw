// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../state/onboard-session";
import {
  getStationExpressResumeIntent,
  parseStationExpressResumeIntent,
  STATION_EXPRESS_ENV,
  withStationExpressResumeEnvironment,
} from "./station-express-resume";

const ultraIntent = {
  version: 1 as const,
  model: "nemotron-3-ultra-550b-a55b",
  sandboxName: "my-assistant",
};

function expressEnv(): NodeJS.ProcessEnv {
  return {
    [STATION_EXPRESS_ENV]: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_YES: "1",
    NEMOCLAW_POLICY_MODE: "suggested",
    NEMOCLAW_SANDBOX_NAME: "my-assistant",
    NEMOCLAW_PROVIDER: "install-vllm",
    NEMOCLAW_VLLM_MODEL: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    NEMOCLAW_MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
  };
}

function resumeDeps(
  session = createSession({ mode: "non-interactive", stationExpressIntent: ultraIntent }),
) {
  return {
    loadSession: vi.fn(() => session),
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${String(code)}`);
    }),
  };
}

describe("DGX Station Express resume (#7048)", () => {
  it("captures a canonical secret-free intent from the installer environment", () => {
    expect(getStationExpressResumeIntent(expressEnv(), "my-assistant")).toEqual({
      ok: true,
      intent: ultraIntent,
    });
  });

  it("ignores ordinary onboarding without the Station Express marker", () => {
    expect(getStationExpressResumeIntent({}, null)).toEqual({ ok: true, intent: null });
  });

  it("rejects malformed or expanded persisted intent", () => {
    expect(
      parseStationExpressResumeIntent({ ...ultraIntent, token: "must-not-persist" }),
    ).toBeNull();
    expect(
      parseStationExpressResumeIntent({ ...ultraIntent, model: "qwen3.6-35b-a3b-nvfp4" }),
    ).toBeNull();
  });

  it("restores the saved provider and model for a plain failed-session resume", async () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_PROVIDER: "" };
    const failedSession = createSession({
      mode: "non-interactive",
      stationExpressIntent: ultraIntent,
    });
    failedSession.status = "failed";
    const deps = resumeDeps(failedSession);
    const run = vi.fn(async () => {
      expect(env).toMatchObject({
        NEMOCLAW_STATION_EXPRESS: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_YES: "1",
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_SANDBOX_NAME: "my-assistant",
        NEMOCLAW_PROVIDER: "install-vllm",
        NEMOCLAW_VLLM_MODEL: "nemotron-3-ultra-550b-a55b",
        NEMOCLAW_MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
      });
    });

    await withStationExpressResumeEnvironment(run, deps, env)({ resume: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(env).toEqual({ NEMOCLAW_PROVIDER: "" });
  });

  it("also restores an automatically resumed in-progress Express session", async () => {
    const env: NodeJS.ProcessEnv = {};
    const deps = resumeDeps();
    const run = vi.fn(async () => {
      expect(env.NEMOCLAW_PROVIDER).toBe("install-vllm");
    });

    await withStationExpressResumeEnvironment(run, deps, env)({});

    expect(run).toHaveBeenCalledTimes(1);
    expect(env).toEqual({});
  });

  it("reuses a completed provider selection without replaying managed installation", async () => {
    const completeProviderStep = {
      status: "complete" as const,
      startedAt: "2026-07-16T00:00:00.000Z",
      completedAt: "2026-07-16T00:01:00.000Z",
      error: null,
    };
    const session = createSession({
      mode: "non-interactive",
      stationExpressIntent: ultraIntent,
      provider: "vllm-local",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      steps: {
        provider_selection: completeProviderStep,
      },
    });
    session.status = "failed";
    const env: NodeJS.ProcessEnv = {};
    const deps = resumeDeps(session);
    const run = vi.fn(async () => {
      expect(env.NEMOCLAW_NON_INTERACTIVE).toBe("1");
      expect(env.NEMOCLAW_POLICY_MODE).toBe("suggested");
      expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
      expect(env.NEMOCLAW_VLLM_MODEL).toBeUndefined();
      expect(env.NEMOCLAW_MODEL).toBeUndefined();
    });

    await withStationExpressResumeEnvironment(run, deps, env)({ resume: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(env).toEqual({});
  });

  it.each([
    { provider: "ollama-local", model: "nvidia/nemotron-3-ultra-550b-a55b" },
    { provider: "vllm-local", model: "nvidia/deepseek-v3.1" },
    {
      provider: "vllm-local",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      sandboxName: "other-assistant",
    },
  ])("fails closed when recorded state conflicts with Station Express intent", async ({
    provider,
    model,
    sandboxName = "my-assistant",
  }) => {
    const session = createSession({
      mode: "non-interactive",
      stationExpressIntent: ultraIntent,
      sandboxName,
      provider,
      model,
      steps: {
        provider_selection: {
          status: "complete",
          startedAt: "2026-07-16T00:00:00.000Z",
          completedAt: "2026-07-16T00:01:00.000Z",
          error: null,
        },
      },
    });
    session.status = "failed";
    const env: NodeJS.ProcessEnv = {};
    const deps = resumeDeps(session);
    const run = vi.fn(async () => undefined);

    await expect(
      withStationExpressResumeEnvironment(run, deps, env)({ resume: true }),
    ).rejects.toThrow("exit 1");

    expect(run).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("state is invalid"));
  });

  it("requires an explicit choice before replacing a failed Express session", async () => {
    const session = createSession({
      mode: "non-interactive",
      stationExpressIntent: ultraIntent,
    });
    session.status = "failed";
    const deps = resumeDeps(session);
    const run = vi.fn(async () => undefined);

    await expect(withStationExpressResumeEnvironment(run, deps, {})({})).rejects.toThrow("exit 1");

    expect(run).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("onboard --resume"));
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("onboard --fresh"));
  });

  it("does not restore discarded intent for --fresh", async () => {
    const env: NodeJS.ProcessEnv = {};
    const deps = resumeDeps();
    const run = vi.fn(async () => {
      expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
    });

    await withStationExpressResumeEnvironment(run, deps, env)({ fresh: true });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an explicit resume override selects another model", async () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_VLLM_MODEL: "deepseek-v4-flash" };
    const deps = resumeDeps();
    const run = vi.fn(async () => undefined);

    await expect(
      withStationExpressResumeEnvironment(run, deps, env)({ resume: true }),
    ).rejects.toThrow("exit 1");

    expect(run).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("NEMOCLAW_VLLM_MODEL"));
  });
});
