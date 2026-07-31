// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreEnv } from "../../../../test/helpers/env-test-helpers";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import type { RebuildDurableConfig } from "./rebuild-durable-config";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import { type RebuildRecreatePhaseInput, runRebuildRecreatePhase } from "./rebuild-recreate-phase";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

const SANDBOX_NAME = "rebuild-reasoning-effort";

const durableConfig: RebuildDurableConfig = {
  dcodeAutoApprovalMode: "disabled",
  dcodeAutoApprovalModeError: null,
  fromDockerfile: null,
  fromDockerfileError: null,
  hermesAuthMethod: null,
  hermesAuthMethodError: null,
  webSearchConfig: null,
  webSearchError: null,
  toolDisclosure: "progressive",
  toolDisclosureError: null,
};

const compatibleResumeConfig: RebuildResumeConfig = {
  agent: "openclaw",
  provider: "compatible-endpoint",
  model: "mock/deepseek-compatible",
  nimContainer: null,
  credentialEnv: "COMPATIBLE_API_KEY",
  preferredInferenceApi: "openai-completions",
  compatibleEndpointReasoning: "true",
  compatibleEndpointReasoningEffort: "high",
  pinEndpoint: true,
  endpointUrl: "https://compatible.example.test/v1",
  registryInferenceRoute: null,
  ambient: { presentVars: [], agentMismatch: null },
};

const recreateOptions: RebuildRecreateOnboardOpts = {
  resume: true,
  nonInteractive: true,
  recreateSandbox: true,
  authoritativeResumeConfig: true,
  acceptThirdPartySoftware: true,
  agent: "openclaw",
  fromDockerfile: null,
  sandboxGpu: null,
  sandboxGpuDevice: null,
  controlUiPort: null,
  targetGatewayName: "nemoclaw",
  targetGatewayPort: 8080,
  onboardLockAlreadyHeld: true,
  autoYes: true,
  toolDisclosure: "progressive",
  dcodeAutoApprovalMode: "disabled",
  dcodeAutoApprovalRequestedExplicitly: false,
  observabilityEnabled: false,
  observabilityRequestedExplicitly: false,
  policyTier: null,
  baseImageResolutionHint: null,
};

function makeInput(overrides: Partial<RebuildRecreatePhaseInput> = {}): RebuildRecreatePhaseInput {
  return {
    sandboxName: SANDBOX_NAME,
    sandboxEntry: { name: SANDBOX_NAME, agent: "openclaw" },
    sessionSnapshot: onboardSession.createSession({ sandboxName: SANDBOX_NAME }),
    sessionMatchesSandbox: true,
    durableConfig,
    resumeConfig: compatibleResumeConfig,
    recreateOptions,
    fromDockerfile: null,
    rebuildAgent: "openclaw",
    messagingPlan: null,
    rebuildsHermesSandbox: false,
    hermesToolGateways: [],
    hasHermesToolGateways: false,
    sessionPolicyPresets: ["telegram"],
    credentialEnv: "COMPATIBLE_API_KEY",
    baseImagePreflight: { ok: true, imageRef: null, overrideEnvVar: null },
    recoveryRecreate: true,
    registryRollback: { recordRemoval: vi.fn(), restoreForRetry: vi.fn() },
    backupManifest: null,
    mcpEntries: [],
    rebuildShieldsWindow: { relocked: false, wasLocked: false },
    relockShieldsIfNeeded: vi.fn(() => true),
    onCreated: vi.fn(),
    log: vi.fn(),
    bail: vi.fn((message: string): never => {
      throw new Error(`bail: ${message}`);
    }),
    ...overrides,
  };
}

describe("rebuild recreate compatible-endpoint reasoning handoff (#7940)", () => {
  let session: Session;
  let previousReasoning: string | undefined;
  let previousReasoningEffort: string | undefined;

  beforeEach(() => {
    previousReasoning = process.env.NEMOCLAW_REASONING;
    previousReasoningEffort = process.env.NEMOCLAW_REASONING_EFFORT;
    session = onboardSession.createSession({ sandboxName: SANDBOX_NAME });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
    vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
      session = mutator(session) ?? session;
      return session;
    });
  });

  afterEach(() => {
    restoreEnv("NEMOCLAW_REASONING", previousReasoning);
    restoreEnv("NEMOCLAW_REASONING_EFFORT", previousReasoningEffort);
    vi.restoreAllMocks();
  });

  it("scopes the recorded reasoning inputs to the recreate and restores ambient values", async () => {
    process.env.NEMOCLAW_REASONING = "false";
    process.env.NEMOCLAW_REASONING_EFFORT = "low";
    let observed: Record<string, string | undefined> = {};
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
      observed = {
        reasoning: process.env.NEMOCLAW_REASONING,
        effort: process.env.NEMOCLAW_REASONING_EFFORT,
      };
    });

    await expect(runRebuildRecreatePhase(makeInput())).resolves.toBe(true);

    expect(observed).toEqual({ reasoning: "true", effort: "high" });
    expect(onboardSession.loadSession()?.compatibleEndpointReasoningEffort).toBe("high");
    expect(process.env.NEMOCLAW_REASONING).toBe("false");
    expect(process.env.NEMOCLAW_REASONING_EFFORT).toBe("low");
  });

  it("restores absent ambient reasoning inputs after a failed recreate", async () => {
    delete process.env.NEMOCLAW_REASONING;
    delete process.env.NEMOCLAW_REASONING_EFFORT;
    let observedEffort: string | undefined;
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
      observedEffort = process.env.NEMOCLAW_REASONING_EFFORT;
      throw new Error("inner onboard failed");
    });

    await expect(runRebuildRecreatePhase(makeInput())).rejects.toThrow("bail: Recreate failed");

    expect(observedEffort).toBe("high");
    expect(process.env.NEMOCLAW_REASONING).toBeUndefined();
    expect(process.env.NEMOCLAW_REASONING_EFFORT).toBeUndefined();
  });

  it("clears a recorded effort the resume configuration no longer carries", async () => {
    process.env.NEMOCLAW_REASONING_EFFORT = "high";
    let observedEffort: string | undefined = "unset";
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
      observedEffort = process.env.NEMOCLAW_REASONING_EFFORT;
    });

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          resumeConfig: { ...compatibleResumeConfig, compatibleEndpointReasoningEffort: null },
        }),
      ),
    ).resolves.toBe(true);

    expect(observedEffort).toBeUndefined();
    expect(process.env.NEMOCLAW_REASONING_EFFORT).toBe("high");
  });

  it("keeps ambient reasoning inputs isolated for a provider that cannot use them", async () => {
    process.env.NEMOCLAW_REASONING = "true";
    process.env.NEMOCLAW_REASONING_EFFORT = "high";
    let observed: Record<string, string | undefined> = {};
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
      observed = {
        reasoning: process.env.NEMOCLAW_REASONING,
        effort: process.env.NEMOCLAW_REASONING_EFFORT,
      };
    });

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          resumeConfig: {
            ...compatibleResumeConfig,
            provider: "nvidia",
            compatibleEndpointReasoning: null,
            compatibleEndpointReasoningEffort: null,
          },
        }),
      ),
    ).resolves.toBe(true);

    expect(observed).toEqual({ reasoning: undefined, effort: undefined });
    expect(process.env.NEMOCLAW_REASONING).toBe("true");
    expect(process.env.NEMOCLAW_REASONING_EFFORT).toBe("high");
  });
});
