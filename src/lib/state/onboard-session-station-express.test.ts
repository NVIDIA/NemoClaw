// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OnboardSessionBootstrapDeps } from "../onboard/session-bootstrap";

type OnboardSessionModule = typeof import("./onboard-session");
type LoadedSession = NonNullable<ReturnType<OnboardSessionModule["loadSession"]>>;
let session: OnboardSessionModule;
let tmpDir: string;
const receiptRevision = "0123456789abcdef0123456789abcdef01234567";
const receiptGeneration = "0123456789abcdef0123456789abcdef";
const otherReceiptGeneration = "fedcba9876543210fedcba9876543210";

function receiptText(generation = receiptGeneration): string {
  return `revision=${receiptRevision}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${generation}\n`;
}

function receiptRetirementClaims(): string[] {
  return fs
    .readdirSync(session.SESSION_DIR)
    .filter((name) => name.startsWith("station-express-resume.retiring-"))
    .map((name) => path.join(session.SESSION_DIR, name));
}

function requireLoadedSession(
  loaded: ReturnType<OnboardSessionModule["loadSession"]>,
): LoadedSession {
  expect(loaded).not.toBeNull();
  return loaded as LoadedSession;
}

async function realBootstrapDeps(): Promise<OnboardSessionBootstrapDeps> {
  const { applySessionRecovery } = await import("../onboard/session-recovery");
  const { getResumeConfigConflicts } = await import("../onboard/resume-config");
  return {
    loadSession: session.loadSession,
    clearSession: session.clearSession,
    createSession: session.createSession,
    saveSession: session.saveSession,
    updateSession: session.updateSession,
    applySessionRecovery,
    setOnboardBrandingAgent: vi.fn(),
    getResumeConfigConflicts,
    recordResumeConflict: vi.fn(async () => undefined),
    resolvePath: path.resolve,
    cliName: () => "nemoclaw",
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${String(code)}`);
    }),
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-express-session-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  session = await import("./onboard-session");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  session.clearSession();
  session.releaseOnboardLock();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Station Express onboarding session state (#7048)", () => {
  it("round-trips only canonical secret-free resume state", () => {
    const stationExpress = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
      receiptGeneration,
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: stationExpress }),
    );

    expect(requireLoadedSession(session.loadSession()).stationExpressIntent).toEqual(
      stationExpress,
    );
    expect(fs.readFileSync(session.SESSION_FILE, "utf8")).not.toContain("token");
  });

  it("accepts legacy sessions without resume state and rejects malformed state", () => {
    const legacy = session.createSession() as unknown as Record<string, unknown>;
    delete legacy.stationExpressIntent;
    delete legacy.stationExpressReceiptRetirement;
    expect(
      requireLoadedSession(session.normalizeSession(legacy as never)).stationExpressIntent,
    ).toBeNull();

    const malformed = {
      ...session.createSession({ mode: "non-interactive" }),
      stationExpressIntent: {
        version: 1,
        model: "nemotron-3-ultra-550b-a55b",
        sandboxName: "my-assistant",
        HF_TOKEN: "must-not-persist",
      },
    };
    expect(session.normalizeSession(malformed as never)).toBeNull();
  });

  it.each([
    ["string resumable", { resumable: "false" }],
    ["missing resumable", { resumable: undefined }],
    ["non-resumable", { resumable: false }],
    ["unknown status", { status: "paused" }],
    ["missing status", { status: undefined }],
  ])("rejects %s lifecycle state", (_case, lifecycle) => {
    const candidate = {
      ...session.createSession({
        mode: "non-interactive",
        stationExpressIntent: {
          version: 1,
          model: "nemotron-3-ultra-550b-a55b",
          sandboxName: "my-assistant",
        },
      }),
      ...lifecycle,
    };

    expect(session.normalizeSession(candidate as never)).toBeNull();
  });

  it.each([
    {
      name: "complete provider step without a bound intent",
      intent: {
        version: 1 as const,
        model: "nemotron-3-ultra-550b-a55b",
        sandboxName: "my-assistant",
      },
      provider: "vllm-local",
      model: "nemotron-ultra",
      providerStatus: "complete" as const,
    },
    {
      name: "bound intent before provider completion",
      intent: {
        version: 1 as const,
        model: "nemotron-3-ultra-550b-a55b",
        sandboxName: "my-assistant",
        servedModel: "nemotron-ultra",
        checkpointModel: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
      },
      provider: null,
      model: null,
      providerStatus: "pending" as const,
    },
  ])("rejects $name during normalization", ({ intent, provider, model, providerStatus }) => {
    const candidate = session.createSession({
      mode: "non-interactive",
      stationExpressIntent: intent,
      provider,
      model,
    });
    candidate.steps.provider_selection.status = providerStatus;

    expect(session.normalizeSession(candidate)).toBeNull();
  });

  it("clears resume intent only after successful completion", () => {
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    session.saveSession(
      session.createSession({
        mode: "non-interactive",
        stationExpressIntent: {
          version: 1,
          model: "nemotron-3-ultra-550b-a55b",
          sandboxName: "my-assistant",
          receiptGeneration,
        },
      }),
    );
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });

    session.completeSession();

    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      stationExpressIntent: null,
      stationExpressReceiptRetirement: null,
    });
    expect(fs.existsSync(receipt)).toBe(false);
  });

  it("accepts receipt retirement state only for a completed non-resumable session", () => {
    const valid = session.createSession();
    valid.status = "complete";
    valid.resumable = false;
    valid.stationExpressReceiptRetirement = receiptGeneration;
    expect(session.normalizeSession(valid)?.stationExpressReceiptRetirement).toBe(
      receiptGeneration,
    );

    for (const candidate of [
      { ...valid, status: "in_progress" },
      { ...valid, resumable: true },
      {
        ...valid,
        stationExpressIntent: {
          version: 1 as const,
          model: "nemotron-3-ultra-550b-a55b",
          sandboxName: "my-assistant",
        },
      },
      { ...valid, stationExpressReceiptRetirement: "invalid" },
    ]) {
      expect(session.normalizeSession(candidate as never)).toBeNull();
    }
  });

  it("keeps the installer receipt when durable session completion fails", () => {
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
      receiptGeneration,
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected session publish failure");
    });

    expect(() => session.completeSession()).toThrow("injected session publish failure");
    rename.mockRestore();

    expect(fs.existsSync(receipt)).toBe(true);
    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      status: "in_progress",
      resumable: true,
      stationExpressIntent: intent,
      stationExpressReceiptRetirement: null,
    });
  });

  it("durably records retirement when receipt deletion fails, then reconciles", () => {
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
      receiptGeneration,
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw new Error("injected receipt deletion failure");
    });

    expect(() => session.completeSession()).toThrow("injected receipt deletion failure");
    unlink.mockRestore();

    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      status: "complete",
      resumable: false,
      stationExpressIntent: null,
      stationExpressReceiptRetirement: receiptGeneration,
    });
    expect(fs.existsSync(receipt)).toBe(false);
    expect(receiptRetirementClaims()).toHaveLength(1);
    expect(fs.existsSync(path.join(receiptRetirementClaims()[0]!, "receipt"))).toBe(true);

    session.reconcileStationExpressReceiptRetirement(receiptGeneration);
    expect(requireLoadedSession(session.loadSession()).stationExpressReceiptRetirement).toBeNull();
    expect(fs.existsSync(receipt)).toBe(false);
  });

  it("recovers a claimed receipt through the public wrapper after final session save fails", async () => {
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
      receiptGeneration,
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce((from, to) => originalRename(from, to))
      .mockImplementationOnce((from, to) => originalRename(from, to))
      .mockImplementationOnce(() => {
        throw new Error("injected retirement publish failure");
      });

    expect(() => session.completeSession()).toThrow("injected retirement publish failure");
    rename.mockRestore();

    expect(fs.existsSync(receipt)).toBe(false);
    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      status: "complete",
      resumable: false,
      stationExpressReceiptRetirement: receiptGeneration,
    });
    expect(receiptRetirementClaims()).toHaveLength(1);

    const { wrapOnboard } = await import("../onboard/station-express-resume");
    const run = vi.fn(async () => undefined);
    await wrapOnboard(
      run,
      session.loadSession,
      session.reconcileStationExpressReceiptRetirement,
    )({});

    expect(run).not.toHaveBeenCalled();
    expect(requireLoadedSession(session.loadSession()).stationExpressReceiptRetirement).toBeNull();
    expect(receiptRetirementClaims()).toEqual([]);
  });

  it("does not reconcile receipt retirement while another onboarding run holds the lock", () => {
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    const completed = session.createSession({ mode: "non-interactive" });
    completed.status = "complete";
    completed.resumable = false;
    completed.stationExpressReceiptRetirement = receiptGeneration;
    session.saveSession(completed);
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    fs.writeFileSync(
      session.LOCK_FILE,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: "competing nemoclaw onboard --fresh",
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );

    expect(() => session.reconcileStationExpressReceiptRetirement(receiptGeneration)).toThrow(
      "another onboarding run is in progress",
    );
    expect(requireLoadedSession(session.loadSession()).stationExpressReceiptRetirement).toBe(
      receiptGeneration,
    );
    expect(fs.readFileSync(receipt, "utf8")).toBe(receiptText());

    fs.unlinkSync(session.LOCK_FILE);
    session.reconcileStationExpressReceiptRetirement(receiptGeneration);
    expect(requireLoadedSession(session.loadSession()).stationExpressReceiptRetirement).toBeNull();
    expect(fs.existsSync(receipt)).toBe(false);
  });

  it("preserves a mismatched receipt and the in-progress session", () => {
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
      receiptGeneration,
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );
    fs.writeFileSync(receipt, receiptText(otherReceiptGeneration), { mode: 0o600 });

    expect(() => session.completeSession()).toThrow("another attempt");

    expect(fs.readFileSync(receipt, "utf8")).toBe(receiptText(otherReceiptGeneration));
    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      status: "in_progress",
      resumable: true,
      stationExpressIntent: intent,
      stationExpressReceiptRetirement: null,
    });
  });

  it("fails closed if the receipt is replaced after durable completion", () => {
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
      receiptGeneration,
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      originalRename(from, to);
      fs.writeFileSync(receipt, receiptText(otherReceiptGeneration), { mode: 0o600 });
    });

    expect(() => session.completeSession()).toThrow("another attempt");
    rename.mockRestore();

    expect(fs.readFileSync(receipt, "utf8")).toBe(receiptText(otherReceiptGeneration));
    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      status: "complete",
      resumable: false,
      stationExpressIntent: null,
      stationExpressReceiptRetirement: receiptGeneration,
    });
  });

  it("does not claim Station Express completion when receipt cleanup is unsafe", () => {
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    const target = path.join(tmpDir, "receipt-target");
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
      receiptGeneration,
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );
    fs.writeFileSync(target, "preserve\n", { mode: 0o600 });
    fs.symlinkSync(target, receipt);

    expect(() => session.completeSession()).toThrow("Refusing symbolic link");

    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      status: "in_progress",
      resumable: true,
      stationExpressIntent: intent,
    });
    expect(fs.readFileSync(target, "utf8")).toBe("preserve\n");
  });

  it("removes the Station installer receipt through the public fresh wrapper", async () => {
    const { wrapOnboard } = await import("../onboard/station-express-resume");
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    const run = vi.fn(async () => undefined);

    await wrapOnboard(
      run,
      session.loadSession,
      session.reconcileStationExpressReceiptRetirement,
    )({
      fresh: true,
    });

    expect(run).toHaveBeenCalledWith({ fresh: true });
    expect(fs.existsSync(receipt)).toBe(false);
  });

  it("resumes a provider failure and persists its route-validated arbitrary alias", async () => {
    const { prepareOnboardSession } = await import("../onboard/session-bootstrap");
    const { wrapOnboard } = await import("../onboard/station-express-resume");
    const { handleProviderInferenceState } = await import(
      "../onboard/machine/handlers/provider-inference"
    );
    const { baseOptions, createDeps } = await import(
      "../onboard/machine/handlers/provider-inference.test-support"
    );
    const { runOnboardMachine } = await import("../onboard/machine/runner");
    const { OnboardRuntime } = await import("../onboard/machine/runtime");
    const { completeOnboardMachine } = await import("../onboard/machine/result");
    const { addOnboardMachineEventListener } = await import("../onboard/machine/events");
    const { registerIncompleteOnboardExitHandlerForSession } = await import(
      "../onboard/onboard-exit-handler"
    );
    const bootstrapDeps = await realBootstrapDeps();
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
      receiptGeneration,
    };
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");
    await prepareOnboardSession(
      {
        resume: false,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: "my-assistant",
        cannotPrompt: true,
        nonInteractive: true,
        stationExpressIntent: intent,
      },
      bootstrapDeps,
    );
    fs.writeFileSync(receipt, receiptText(), { mode: 0o600 });
    expect(requireLoadedSession(session.loadSession()).stationExpressIntent).toEqual(intent);

    const failingRuntime = new OnboardRuntime();
    await failingRuntime.transition("preflight");
    await failingRuntime.transition("gateway");
    await failingRuntime.transition("provider_selection");
    const exitListeners: Array<(code: number) => void> = [];
    registerIncompleteOnboardExitHandlerForSession(session, () => false, {
      once: (_event, listener) => exitListeners.push(listener),
    });
    const injectedFailure = new Error("injected managed vLLM download failure");
    const failing = createDeps({
      setupNim: vi.fn(async () => {
        throw injectedFailure;
      }),
      startRecordedStep: vi.fn(async (stepName: string) => {
        await failingRuntime.markStepStarted(stepName);
      }),
      recordStepComplete: vi.fn(async (stepName, updates) =>
        failingRuntime.markStepComplete(stepName, updates),
      ),
    });
    await expect(
      runOnboardMachine({
        context: {},
        runtime: failingRuntime,
        handlers: {
          provider_selection: async () => {
            const result = await handleProviderInferenceState({
              ...baseOptions(failing.deps, requireLoadedSession(session.loadSession())),
              sandboxName: "my-assistant",
            });
            return result.stateResults;
          },
        },
        stopStates: ["sandbox"],
      }),
    ).rejects.toThrow(injectedFailure.message);
    expect(exitListeners).toHaveLength(1);
    exitListeners[0]!(1);

    const failedSession = requireLoadedSession(session.loadSession());
    expect(failedSession).toMatchObject({
      status: "failed",
      provider: null,
      model: null,
      stationExpressIntent: intent,
      steps: { provider_selection: { status: "failed" } },
    });

    for (const name of [
      "NEMOCLAW_STATION_EXPRESS",
      "NEMOCLAW_NON_INTERACTIVE",
      "NEMOCLAW_YES",
      "NEMOCLAW_POLICY_MODE",
      "NEMOCLAW_SANDBOX_NAME",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_VLLM_MODEL",
      "NEMOCLAW_MODEL",
      "NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION",
    ]) {
      vi.stubEnv(name, "");
    }

    const resumedSetup = vi.fn(async () => {
      expect(process.env).toMatchObject({
        NEMOCLAW_STATION_EXPRESS: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "install-vllm",
        NEMOCLAW_VLLM_MODEL: "nemotron-3-ultra-550b-a55b",
        NEMOCLAW_MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
        NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION: receiptGeneration,
      });
      return {
        model: "nemotron-ultra",
        provider: "vllm-local",
        endpointUrl: null,
        credentialEnv: null,
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: "openai-responses",
        compatibleEndpointReasoning: null,
        nimContainer: null,
        vllmModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
      };
    });
    const resumedRuntime = new OnboardRuntime();
    const resumed = createDeps({
      setupNim: resumedSetup,
      startRecordedStep: vi.fn(async (stepName: string) => {
        await resumedRuntime.markStepStarted(stepName);
      }),
      recordStepComplete: vi.fn(async (stepName, updates) =>
        resumedRuntime.markStepComplete(stepName, updates),
      ),
    });
    const wrapped = wrapOnboard(
      async () => {
        const resumedBootstrap = await prepareOnboardSession(
          {
            resume: true,
            fresh: false,
            requestedFromDockerfile: null,
            requestedSandboxName: process.env.NEMOCLAW_SANDBOX_NAME || null,
            cannotPrompt: true,
            nonInteractive: true,
          },
          bootstrapDeps,
        );
        const result = await runOnboardMachine({
          context: {},
          runtime: resumedRuntime,
          handlers: {
            provider_selection: async () => {
              const providerResult = await handleProviderInferenceState({
                ...baseOptions(resumed.deps, resumedBootstrap.session),
                resume: true,
                sandboxName: process.env.NEMOCLAW_SANDBOX_NAME || null,
                env: process.env,
              });
              return providerResult.stateResults;
            },
          },
          stopStates: ["sandbox"],
        });
        expect(result.session).toMatchObject({
          provider: "vllm-local",
          model: "nemotron-ultra",
          machine: { state: "sandbox" },
        });
      },
      session.loadSession,
      session.reconcileStationExpressReceiptRetirement,
    );

    await wrapped({ resume: true });

    expect(resumedSetup).toHaveBeenCalledTimes(1);
    expect(resumed.calls.promptName).not.toHaveBeenCalled();
    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      provider: "vllm-local",
      model: "nemotron-ultra",
      stationExpressIntent: {
        ...intent,
        servedModel: "nemotron-ultra",
        checkpointModel: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
      },
    });
    expect(fs.existsSync(receipt)).toBe(true);

    await resumedRuntime.transition("agent_setup");
    await resumedRuntime.transition("policies");
    await resumedRuntime.transition("finalizing");
    await resumedRuntime.transition("post_verify");
    const completionEvents: string[] = [];
    const removeCompletionListener = addOnboardMachineEventListener((event) =>
      completionEvents.push(event.type),
    );
    try {
      await resumedRuntime.applyResult(
        completeOnboardMachine({
          sandboxName: "my-assistant",
          provider: "vllm-local",
          model: "nemotron-ultra",
        }),
      );
    } finally {
      removeCompletionListener();
    }

    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      status: "complete",
      resumable: false,
      stationExpressIntent: null,
      stationExpressReceiptRetirement: null,
    });
    expect(fs.existsSync(receipt)).toBe(false);
    expect(completionEvents).toEqual([
      "context.updated",
      "state.completed",
      "state.entered",
      "onboard.completed",
    ]);
  });

  it("atomically binds a route-validated arbitrary alias when provider selection completes", () => {
    const servedAlias = "nemotron-ultra";
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );

    session.markStepComplete("provider_selection", {
      provider: "vllm-local",
      model: servedAlias,
      stationExpressModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    });

    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      provider: "vllm-local",
      model: servedAlias,
      stationExpressIntent: {
        ...intent,
        servedModel: servedAlias,
        checkpointModel: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
      },
      steps: { provider_selection: { status: "complete" } },
    });
  });

  it("does not complete Station Express provider selection with an invalid binding", () => {
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
    };
    const expectedIntent = { ...intent };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );

    expect(() =>
      session.markStepComplete("provider_selection", {
        provider: "vllm-local",
        model: "deepseek-ai/DeepSeek-V4-Flash",
        stationExpressModelIdentity: "deepseek-ai/DeepSeek-V4-Flash",
      }),
    ).toThrow("invalid DGX Station Express provider selection");

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded).toMatchObject({
      provider: null,
      model: null,
      steps: { provider_selection: { status: "pending" } },
    });
    expect(loaded.stationExpressIntent).toEqual(expectedIntent);
  });
});
