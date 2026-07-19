// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSession } from "../state/onboard-session";
import {
  assertStationExpressInstallerResumeMatches,
  cleanupStationExpressReceiptRetirementClaims,
  clearStationExpressInstallerResume,
  getStationExpressResumeIntent,
  INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV,
  parseStationExpressResumeIntent,
  retireStationExpressInstallerResume,
  STATION_EXPRESS_ENV,
  STATION_EXPRESS_RECEIPT_GENERATION_ENV,
  withStationExpressResumeEnvironment,
} from "./station-express-resume";

const receiptGeneration = "0123456789abcdef0123456789abcdef";
const otherReceiptGeneration = "fedcba9876543210fedcba9876543210";
const receiptRevision = "0123456789abcdef0123456789abcdef01234567";

const ultraIntent = {
  version: 1 as const,
  model: "nemotron-3-ultra-550b-a55b",
  sandboxName: "my-assistant",
};
const boundUltraIntent = {
  ...ultraIntent,
  servedModel: "nvidia/nemotron-3-ultra-550b-a55b",
  checkpointModel: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
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

function receiptText(generation = receiptGeneration, model = "nemotron-3-ultra-550b-a55b"): string {
  return `revision=${receiptRevision}\nmodel=${model}\ngeneration=${generation}\n`;
}

function currentReceiptText(
  overrides: Partial<{ agent: string; sandbox: string; policyTier: string }> = {},
): string {
  const { agent = "hermes", sandbox = "my-assistant", policyTier = "balanced" } = overrides;
  return `${receiptText().trimEnd()}\nagent=${agent}\nsandbox=${sandbox}\npolicy_tier=${policyTier}\n`;
}

function portReceiptText(
  overrides: Partial<{ gatewayPort: string; dashboardPort: string; vllmPort: string }> = {},
): string {
  const { gatewayPort = "18081", dashboardPort = "18790", vllmPort = "18000" } = overrides;
  return (
    `${currentReceiptText().trimEnd()}\n` +
    `gateway_port=${gatewayPort}\ndashboard_port=${dashboardPort}\nvllm_port=${vllmPort}\n`
  );
}

function retirementClaims(home: string): string[] {
  const stateDir = path.join(home, ".nemoclaw");
  return fs
    .readdirSync(stateDir)
    .filter((name) => name.startsWith("station-express-resume.retiring-"))
    .map((name) => path.join(stateDir, name));
}

function resumeDeps(
  session = createSession({ mode: "non-interactive", stationExpressIntent: ultraIntent }),
) {
  return {
    loadSession: vi.fn(() => session),
    clearInstallerResume: vi.fn(),
    cleanupReceiptRetirementClaims: vi.fn(),
    reconcileReceiptRetirement: vi.fn(),
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

  it("carries the installer receipt generation in the persisted intent", () => {
    const env = expressEnv();
    env[STATION_EXPRESS_RECEIPT_GENERATION_ENV] = receiptGeneration;

    expect(getStationExpressResumeIntent(env, "my-assistant")).toEqual({
      ok: true,
      intent: { ...ultraIntent, receiptGeneration },
    });
    expect(parseStationExpressResumeIntent({ ...ultraIntent, receiptGeneration })).toEqual({
      ...ultraIntent,
      receiptGeneration,
    });
    expect(
      parseStationExpressResumeIntent({ ...ultraIntent, receiptGeneration: "not-a-generation" }),
    ).toBeNull();
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
    expect(
      parseStationExpressResumeIntent({
        ...ultraIntent,
        servedModel: "nemotron-ultra",
        checkpointModel: "deepseek-ai/DeepSeek-V4-Flash",
      }),
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

  it("reuses the exact arbitrary alias recorded by a completed provider selection", async () => {
    const servedAlias = "nemotron-ultra";
    const session = createSession({
      mode: "non-interactive",
      stationExpressIntent: {
        ...ultraIntent,
        servedModel: servedAlias,
        checkpointModel: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
      },
      provider: "vllm-local",
      model: servedAlias,
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

  it.each([
    {
      name: "complete provider step with an unbound intent",
      intent: ultraIntent,
      provider: "vllm-local",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      providerStatus: "complete",
    },
    {
      name: "non-complete provider step with a bound intent",
      intent: boundUltraIntent,
      provider: null,
      model: null,
      providerStatus: "pending",
    },
  ])("fails closed for $name", async ({ intent, provider, model, providerStatus }) => {
    const malformed = createSession({
      mode: "non-interactive",
      stationExpressIntent: intent,
      provider,
      model,
      steps: {
        provider_selection: {
          status: providerStatus as "complete" | "pending",
          startedAt: null,
          completedAt: null,
          error: null,
        },
      },
    });
    malformed.status = "failed";
    const deps = resumeDeps(malformed);
    const run = vi.fn(async () => undefined);

    await expect(
      withStationExpressResumeEnvironment(run, deps, {})({ resume: true }),
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
    const env: NodeJS.ProcessEnv = {
      [STATION_EXPRESS_RECEIPT_GENERATION_ENV]: receiptGeneration,
    };
    const deps = resumeDeps();
    const run = vi.fn(async () => {
      expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
      expect(env[STATION_EXPRESS_RECEIPT_GENERATION_ENV]).toBeUndefined();
    });

    await withStationExpressResumeEnvironment(run, deps, env)({ fresh: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(deps.clearInstallerResume).toHaveBeenCalledTimes(1);
    expect(env[STATION_EXPRESS_RECEIPT_GENERATION_ENV]).toBe(receiptGeneration);
  });

  it("preserves the loaded receipt during an installer-initiated automatic fresh reset", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-auto-fresh-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(
      receipt,
      `revision=${receiptRevision}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${receiptGeneration}\n`,
      { mode: 0o600 },
    );
    const env = expressEnv();
    env.HOME = home;
    env[STATION_EXPRESS_RECEIPT_GENERATION_ENV] = receiptGeneration;
    env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV] = receiptGeneration;
    const deps = resumeDeps(createSession({ mode: "non-interactive" }));
    deps.clearInstallerResume.mockImplementation(() =>
      clearStationExpressInstallerResume({ HOME: home }),
    );
    const run = vi.fn(async () => {
      expect(env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV]).toBeUndefined();
      expect(env[STATION_EXPRESS_RECEIPT_GENERATION_ENV]).toBe(receiptGeneration);
      expect(fs.existsSync(receipt)).toBe(true);
      expect(getStationExpressResumeIntent(env, "my-assistant")).toEqual({
        ok: true,
        intent: { ...ultraIntent, receiptGeneration },
      });
    });

    try {
      await withStationExpressResumeEnvironment(run, deps, env)({ fresh: true });

      expect(run).toHaveBeenCalledTimes(1);
      expect(deps.clearInstallerResume).not.toHaveBeenCalled();
      expect(fs.existsSync(receipt)).toBe(true);
      expect(env[STATION_EXPRESS_RECEIPT_GENERATION_ENV]).toBe(receiptGeneration);
      expect(env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV]).toBe(receiptGeneration);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a stale automatic-fresh marker when its receipt is missing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-auto-fresh-missing-"));
    fs.mkdirSync(path.join(home, ".nemoclaw"), { mode: 0o700 });
    const env = expressEnv();
    env.HOME = home;
    env[STATION_EXPRESS_RECEIPT_GENERATION_ENV] = receiptGeneration;
    env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV] = receiptGeneration;
    const deps = resumeDeps(createSession({ mode: "non-interactive" }));
    const run = vi.fn(async () => undefined);

    try {
      await expect(
        withStationExpressResumeEnvironment(run, deps, env)({ fresh: true }),
      ).rejects.toThrow("exit 1");

      expect(run).not.toHaveBeenCalled();
      expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("state is missing"));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a spoofed automatic-fresh marker for another receipt", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-auto-fresh-mismatch-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, receiptText(otherReceiptGeneration), { mode: 0o600 });
    const env = expressEnv();
    env.HOME = home;
    env[STATION_EXPRESS_RECEIPT_GENERATION_ENV] = receiptGeneration;
    env[INSTALLER_AUTO_FRESH_RECEIPT_GENERATION_ENV] = receiptGeneration;
    const deps = resumeDeps(createSession({ mode: "non-interactive" }));
    const run = vi.fn(async () => undefined);

    try {
      await expect(
        withStationExpressResumeEnvironment(run, deps, env)({ fresh: true }),
      ).rejects.toThrow("exit 1");

      expect(run).not.toHaveBeenCalled();
      expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("another attempt"));
      expect(fs.readFileSync(receipt, "utf8")).toBe(receiptText(otherReceiptGeneration));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not treat an older completed session as proof of a new installer attempt", async () => {
    const completed = createSession();
    completed.status = "complete";
    completed.resumable = false;
    const deps = resumeDeps(completed);
    const run = vi.fn(async () => undefined);

    await withStationExpressResumeEnvironment(run, deps, {})({});

    expect(deps.clearInstallerResume).not.toHaveBeenCalled();
    expect(deps.reconcileReceiptRetirement).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves a legacy state directory alone when no Station retirement claim exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-legacy-state-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o755 });
    fs.writeFileSync(path.join(stateDir, "onboard-session.json"), "{}\n", { mode: 0o600 });

    try {
      expect(() => cleanupStationExpressReceiptRetirementClaims({ HOME: home })).not.toThrow();
      expect(fs.readFileSync(path.join(stateDir, "onboard-session.json"), "utf8")).toBe("{}\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a legacy state directory alone when explicit clear has no Station artifacts", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-legacy-clear-"));
    const stateDir = path.join(home, ".nemoclaw");
    const sessionFile = path.join(stateDir, "onboard-session.json");
    fs.mkdirSync(stateDir, { mode: 0o755 });
    fs.writeFileSync(sessionFile, "{}\n", { mode: 0o600 });

    try {
      expect(() => clearStationExpressInstallerResume({ HOME: home })).not.toThrow();
      expect(fs.readFileSync(sessionFile, "utf8")).toBe("{}\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an empty world-writable state directory during explicit clear", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-unsafe-empty-clear-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.chmodSync(stateDir, 0o777);

    try {
      expect(() => clearStationExpressInstallerResume({ HOME: home })).toThrow("non-owner-only");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic-link state directory during explicit clear without artifacts", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-symlink-empty-clear-"));
    const target = path.join(home, "state-target");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.join(home, ".nemoclaw"));

    try {
      expect(() => clearStationExpressInstallerResume({ HOME: home })).toThrow(
        "Refusing symbolic link",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("still rejects a Station receipt in a legacy state directory during explicit clear", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-legacy-receipt-clear-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o755 });
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });

    try {
      expect(() => clearStationExpressInstallerResume({ HOME: home })).toThrow("non-owner-only");
      expect(fs.readFileSync(receipt, "utf8")).toBe(receiptText());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("still rejects a Station retirement claim in an unsafe state directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-unsafe-claim-"));
    const stateDir = path.join(home, ".nemoclaw");
    const claim = path.join(
      stateDir,
      `station-express-resume.retiring-${receiptGeneration}-candidate`,
    );
    fs.mkdirSync(claim, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o755);

    try {
      expect(() => cleanupStationExpressReceiptRetirementClaims({ HOME: home })).toThrow(
        "non-owner-only",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reconciles a durable matching retirement marker without replaying onboarding", async () => {
    const completed = createSession();
    completed.status = "complete";
    completed.resumable = false;
    completed.stationExpressReceiptRetirement = receiptGeneration;
    const deps = resumeDeps(completed);
    const run = vi.fn(async () => undefined);

    await withStationExpressResumeEnvironment(run, deps, {})({});

    expect(deps.reconcileReceiptRetirement).toHaveBeenCalledWith(receiptGeneration);
    expect(run).not.toHaveBeenCalled();
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

  it("refuses receipt cleanup through a group-accessible state directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-mode-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "station-express-resume"), "keep", { mode: 0o600 });
    fs.chmodSync(stateDir, 0o750);

    try {
      expect(() => clearStationExpressInstallerResume({ HOME: home })).toThrow("non-owner-only");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("retires only the exact matching installer receipt generation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-match-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(
      receipt,
      `revision=${receiptRevision}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${receiptGeneration}\n`,
      { mode: 0o600 },
    );

    try {
      expect(() =>
        assertStationExpressInstallerResumeMatches(otherReceiptGeneration, { HOME: home }),
      ).toThrow("another attempt");
      expect(fs.existsSync(receipt)).toBe(true);

      retireStationExpressInstallerResume(receiptGeneration, { env: { HOME: home } });
      expect(fs.existsSync(receipt)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts and retires the current installer receipt with complete express intent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-current-receipt-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, currentReceiptText(), { mode: 0o600 });

    try {
      expect(() =>
        assertStationExpressInstallerResumeMatches(receiptGeneration, { HOME: home }),
      ).not.toThrow();
      retireStationExpressInstallerResume(receiptGeneration, { env: { HOME: home } });
      expect(fs.existsSync(receipt)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts and retires the port-bound installer receipt (#7203)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-port-receipt-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, portReceiptText(), { mode: 0o600 });

    try {
      expect(() =>
        assertStationExpressInstallerResumeMatches(receiptGeneration, { HOME: home }),
      ).not.toThrow();
      retireStationExpressInstallerResume(receiptGeneration, { env: { HOME: home } });
      expect(fs.existsSync(receipt)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["gateway", { gatewayPort: "invalid" }],
    ["dashboard", { dashboardPort: "1023" }],
    ["vLLM", { vllmPort: "65536" }],
    ["duplicate", { dashboardPort: "18081" }],
    ["numerically duplicate", { dashboardPort: "018081" }],
  ])("rejects a port-bound installer receipt with an invalid %s port", (_field, overrides) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-port-invalid-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, portReceiptText(overrides), { mode: 0o600 });

    try {
      expect(() =>
        assertStationExpressInstallerResumeMatches(receiptGeneration, { HOME: home }),
      ).toThrow("installer resume state is malformed");
      expect(fs.readFileSync(receipt, "utf8")).toBe(portReceiptText(overrides));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["agent", { agent: "unknown-agent" }],
    ["sandbox", { sandbox: "Invalid Sandbox" }],
    ["policy tier", { policyTier: "unrestricted" }],
  ])("rejects a current installer receipt with an invalid %s", (_field, overrides) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-current-invalid-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, currentReceiptText(overrides), { mode: 0o600 });

    try {
      expect(() =>
        assertStationExpressInstallerResumeMatches(receiptGeneration, { HOME: home }),
      ).toThrow("installer resume state is malformed");
      expect(fs.readFileSync(receipt, "utf8")).toBe(currentReceiptText(overrides));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["Nemotron Ultra", "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4"],
    ["DeepSeek V4 Flash", "deepseek-ai/DeepSeek-V4-Flash"],
  ])("retires a receipt written with the supported %s Hugging Face model ID", (_name, model) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-hf-id-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, receiptText(receiptGeneration, model), { mode: 0o600 });

    try {
      expect(() =>
        retireStationExpressInstallerResume(receiptGeneration, { env: { HOME: home } }),
      ).not.toThrow();
      expect(fs.existsSync(receipt)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an arbitrary served alias in an installer receipt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-alias-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, receiptText(receiptGeneration, "nvidia/nemotron-3-ultra-550b-a55b"), {
      mode: 0o600,
    });

    try {
      expect(() =>
        retireStationExpressInstallerResume(receiptGeneration, { env: { HOME: home } }),
      ).toThrow("installer resume state is malformed");
      expect(fs.readFileSync(receipt, "utf8")).toBe(
        receiptText(receiptGeneration, "nvidia/nemotron-3-ultra-550b-a55b"),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("never unlinks a replacement receipt introduced before its atomic claim", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-race-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      fs.writeFileSync(receipt, receiptText(otherReceiptGeneration), { mode: 0o600 });
      originalRename(from, to);
    });

    try {
      expect(() =>
        retireStationExpressInstallerResume(receiptGeneration, { env: { HOME: home } }),
      ).toThrow("another attempt");
      rename.mockRestore();

      expect(fs.readFileSync(receipt, "utf8")).toBe(receiptText(otherReceiptGeneration));
      expect(retirementClaims(home)).toHaveLength(1);
      expect(fs.readFileSync(path.join(retirementClaims(home)[0]!, "receipt"), "utf8")).toBe(
        receiptText(otherReceiptGeneration),
      );

      clearStationExpressInstallerResume({ HOME: home });
      expect(fs.existsSync(receipt)).toBe(false);
      expect(retirementClaims(home)).toEqual([]);
    } finally {
      rename.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("never unlinks a replacement receipt introduced after its atomic claim", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-claimed-race-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      originalRename(from, to);
      fs.writeFileSync(receipt, receiptText(otherReceiptGeneration), { mode: 0o600 });
    });

    try {
      expect(() =>
        retireStationExpressInstallerResume(receiptGeneration, { env: { HOME: home } }),
      ).not.toThrow();
      rename.mockRestore();

      expect(fs.readFileSync(receipt, "utf8")).toBe(receiptText(otherReceiptGeneration));
      expect(retirementClaims(home)).toEqual([]);
    } finally {
      rename.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rechecks the canonical receipt when a concurrent cleanup removes its empty claim", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-claim-race-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce((from, to) => {
        fs.rmdirSync(path.dirname(String(to)));
        originalRename(from, to);
      })
      .mockImplementation((from, to) => originalRename(from, to));

    try {
      expect(() =>
        retireStationExpressInstallerResume(receiptGeneration, {
          allowMissing: true,
          env: { HOME: home },
        }),
      ).not.toThrow();
      expect(rename).toHaveBeenCalledTimes(2);
      rename.mockRestore();

      expect(fs.existsSync(receipt)).toBe(false);
      expect(retirementClaims(home)).toEqual([]);
    } finally {
      rename.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails safely when the receipt disappears before its atomic claim", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-remove-race-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      fs.unlinkSync(receipt);
      originalRename(from, to);
    });

    try {
      expect(() =>
        retireStationExpressInstallerResume(receiptGeneration, { env: { HOME: home } }),
      ).toThrow("state is missing");
      rename.mockRestore();

      expect(fs.existsSync(receipt)).toBe(false);
      expect(retirementClaims(home)).toEqual([]);
      expect(() =>
        retireStationExpressInstallerResume(receiptGeneration, {
          allowMissing: true,
          env: { HOME: home },
        }),
      ).not.toThrow();
    } finally {
      rename.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to clean a symlinked receipt-retirement claim", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-claim-symlink-"));
    const stateDir = path.join(home, ".nemoclaw");
    const target = path.join(home, "claim-target");
    const claim = path.join(
      stateDir,
      `station-express-resume.retiring-${receiptGeneration}-ABC123`,
    );
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "preserve"), "keep\n", { mode: 0o600 });
    fs.symlinkSync(target, claim);

    try {
      expect(() => cleanupStationExpressReceiptRetirementClaims({ HOME: home })).toThrow(
        "Refusing symbolic link",
      );
      expect(fs.readFileSync(path.join(target, "preserve"), "utf8")).toBe("keep\n");
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
