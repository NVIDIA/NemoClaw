// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSession } from "../state/onboard-session";
import {
  clearStationExpressInstallerResume,
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
const boundUltraIntent = {
  ...ultraIntent,
  servedModel: "nvidia/nemotron-3-ultra-550b-a55b",
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
    clearInstallerResume: vi.fn(),
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
    expect(
      parseStationExpressResumeIntent({ ...ultraIntent, servedModel: "unsafe alias" }),
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

  it("reuses the exact served alias recorded by a completed provider selection", async () => {
    const session = createSession({
      mode: "non-interactive",
      stationExpressIntent: { ...ultraIntent, servedModel: "nemotron-ultra" },
      provider: "vllm-local",
      model: "nemotron-ultra",
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
    const deps = resumeDeps(session);
    const run = vi.fn(async () => undefined);

    await withStationExpressResumeEnvironment(run, deps, {})({ resume: true });

    expect(run).toHaveBeenCalledTimes(1);
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
      stationExpressIntent: boundUltraIntent,
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
      stationExpressIntent: boundUltraIntent,
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
    expect(deps.clearInstallerResume).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the Station installer resume receipt cannot be discarded", async () => {
    const deps = resumeDeps();
    deps.clearInstallerResume.mockImplementation(() => {
      throw new Error("unsafe receipt");
    });
    const run = vi.fn(async () => undefined);

    await expect(
      withStationExpressResumeEnvironment(run, deps, {})({ fresh: true }),
    ).rejects.toThrow("exit 1");

    expect(run).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("unsafe receipt"));
  });

  it("refuses a symbolic-link Station installer resume receipt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-"));
    const stateDir = path.join(home, ".nemoclaw");
    const target = path.join(home, "target");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(target, "keep", { mode: 0o600 });
    fs.symlinkSync(target, path.join(stateDir, "station-express-resume"));

    try {
      expect(() => clearStationExpressInstallerResume({ HOME: home })).toThrow(
        "Refusing symbolic link",
      );
      expect(fs.readFileSync(target, "utf8")).toBe("keep");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
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
