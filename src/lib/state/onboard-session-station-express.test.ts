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

  it("clears resume intent only after successful completion", () => {
    session.saveSession(
      session.createSession({
        mode: "non-interactive",
        stationExpressIntent: {
          version: 1,
          model: "nemotron-3-ultra-550b-a55b",
          sandboxName: "my-assistant",
        },
      }),
    );

    session.completeSession();

    expect(requireLoadedSession(session.loadSession()).stationExpressIntent).toBeNull();
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
    fs.writeFileSync(
      receipt,
      "revision=0123456789012345678901234567890123456789\nmodel=nemotron-3-ultra-550b-a55b\n",
      { mode: 0o600 },
    );
    const run = vi.fn(async () => undefined);

    await wrapOnboard(run, session.loadSession)({ fresh: true });

    expect(run).toHaveBeenCalledWith({ fresh: true });
    expect(fs.existsSync(receipt)).toBe(false);
  });

  it("persists an injected provider failure and resumes through the real entry wrapper", async () => {
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
    const { registerIncompleteOnboardExitHandlerForSession } = await import(
      "../onboard/onboard-exit-handler"
    );
    const bootstrapDeps = await realBootstrapDeps();
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
    };
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
      });
      return {
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        provider: "vllm-local",
        endpointUrl: null,
        credentialEnv: null,
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: "openai-responses",
        compatibleEndpointReasoning: null,
        nimContainer: null,
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
    const wrapped = wrapOnboard(async () => {
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
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        machine: { state: "sandbox" },
      });
    }, session.loadSession);

    await wrapped({ resume: true });

    expect(resumedSetup).toHaveBeenCalledTimes(1);
    expect(resumed.calls.promptName).not.toHaveBeenCalled();
    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      provider: "vllm-local",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      stationExpressIntent: {
        ...intent,
        servedModel: "nvidia/nemotron-3-ultra-550b-a55b",
      },
    });
  });

  it("atomically binds a validated served alias when provider selection completes", () => {
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
      model: "nemotron-ultra",
    });

    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      provider: "vllm-local",
      model: "nemotron-ultra",
      stationExpressIntent: { ...intent, servedModel: "nemotron-ultra" },
    });
  });

  it("does not complete Station Express provider selection with an invalid binding", () => {
    const intent = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
    };
    session.saveSession(
      session.createSession({ mode: "non-interactive", stationExpressIntent: intent }),
    );

    expect(() =>
      session.markStepComplete("provider_selection", {
        provider: "vllm-local",
        model: "unsafe alias",
      }),
    ).toThrow("invalid DGX Station Express provider selection");

    expect(requireLoadedSession(session.loadSession())).toMatchObject({
      provider: null,
      model: null,
      stationExpressIntent: intent,
      steps: { provider_selection: { status: "pending" } },
    });
  });
});
