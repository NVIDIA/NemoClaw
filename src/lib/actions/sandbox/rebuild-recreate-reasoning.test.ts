// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";

import {
  installRebuildResourceOnboardFixture,
  RESOURCE_CREATE_BOUNDARY,
} from "../../../../test/helpers/rebuild-resource-onboard-fixture";
import type { SandboxCreateIntent } from "../../onboard/types";

import { restoreEnv } from "../../../../test/helpers/env-test-helpers";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import type { CheckpointGatewayAuthority } from "../../state/onboard-checkpoint-types";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import type { RebuildDurableConfig } from "./rebuild-durable-config";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import type { RebuildRecreateJournal } from "./rebuild-recreate-journal";
import { type RebuildRecreatePhaseInput, runRebuildRecreatePhase } from "./rebuild-recreate-phase";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

const SANDBOX_NAME = "rebuild-reasoning-effort";

const GATEWAY_AUTHORITY: CheckpointGatewayAuthority = {
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  mode: "nemoclaw-managed",
  source: "standalone",
  endpoint: null,
  stateDir: null,
  supervisor: null,
  requiredCapabilities: [],
};

const durableConfig: RebuildDurableConfig = {
  dcodeAutoApprovalMode: "disabled",
  dcodeAutoApprovalModeError: null,
  fromDockerfile: null,
  fromDockerfileError: null,
  fromImage: null,
  fromImageError: null,
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
  rebuildPolicySourcePath: "/tmp/current-policy.yaml",
  acceptThirdPartySoftware: true,
  agent: "openclaw",
  recreateProvider: "compatible-endpoint",
  recreateModel: "mock/deepseek-compatible",
  recreatePreferredInferenceApi: "openai-completions",
  fromDockerfile: null,
  sandboxGpu: null,
  sandboxGpuDevice: null,
  controlUiPort: null,
  targetGatewayName: "nemoclaw",
  targetGatewayPort: 8080,
  onboardLockAlreadyHeld: true,
  deferProcessExit: true,
  autoYes: true,
  toolDisclosure: "progressive",
  dcodeAutoApprovalMode: "disabled",
  dcodeAutoApprovalRequestedExplicitly: false,
  observabilityEnabled: false,
  observabilityRequestedExplicitly: false,
  baseImageResolutionHint: null,
  rebuildGatewayAuthority: GATEWAY_AUTHORITY,
};

const recreateJournal: RebuildRecreateJournal = {
  id: "11111111-1111-4111-8111-111111111111",
  acceptedTarget: false,
  sourceConfirmedAbsent: true,
  gatewayAuthority: GATEWAY_AUTHORITY,
  targetGeneration: "22222222-2222-4222-8222-222222222222",
  targetIntentFingerprint: "rebuild-reasoning-target",
  beginDelete: vi.fn((): "missing" => "missing"),
  confirmDeleted: vi.fn(),
  completeAcceptedTarget: vi.fn(),
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
    recreateJournal,
    fromDockerfile: null,
    rebuildAgent: "openclaw",
    messagingPlan: null,
    rebuildsHermesSandbox: false,
    hermesToolGateways: [],
    hasHermesToolGateways: false,
    policySourcePath: "/tmp/current-policy.yaml",
    credentialEnv: "COMPATIBLE_API_KEY",
    baseImagePreflight: { ok: true, imageRef: null, overrideEnvVar: null },
    recoveryRecreate: true,
    registryRollback: { recordRemoval: vi.fn(), restoreForRetry: vi.fn() },
    backupManifest: null,
    mcpEntries: [],
    log: vi.fn(),
    bail: vi.fn((message: string): never => {
      throw new Error(`bail: ${message}`);
    }),
    ...overrides,
  };
}

let session: Session;

/** Stub an onboard session whose recreate journal has already deleted the sandbox. */
function stubJournaledRecreateSession(): void {
  session = onboardSession.createSession({ sandboxName: SANDBOX_NAME });
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: SANDBOX_NAME, agent: "openclaw" }),
    gatewayAuthority: decisionSelected(GATEWAY_AUTHORITY),
    sandboxRecreate: {
      version: 1,
      id: recreateJournal.id,
      revision: 3,
      sandboxName: SANDBOX_NAME,
      gatewayName: GATEWAY_AUTHORITY.gatewayName,
      gatewayPort: GATEWAY_AUTHORITY.gatewayPort,
      sourceRegistryFingerprint: "source-registry",
      sourceLiveIdentityFingerprint: null,
      sourceWorkload: null,
      targetIntentFingerprint: recreateJournal.targetIntentFingerprint,
      targetGeneration: recreateJournal.targetGeneration,
      targetLiveIdentityFingerprint: null,
      phase: "deleted",
      startedAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:01.000Z",
    },
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
    session = mutator(session) ?? session;
    return session;
  });
}

describe("rebuild recreate OpenClaw dashboard origin (#13177)", () => {
  let previousChatUiUrl: string | undefined;

  beforeEach(() => {
    previousChatUiUrl = process.env.CHAT_UI_URL;
    stubJournaledRecreateSession();
  });

  afterEach(() => {
    restoreEnv("CHAT_UI_URL", previousChatUiUrl);
    vi.restoreAllMocks();
  });

  /** Record the `CHAT_UI_URL` that the inner onboard sees while it runs. */
  function observeInnerChatUiUrl(): () => string | undefined {
    let observed: string | undefined = "not-called";
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
      observed = process.env.CHAT_UI_URL;
    });
    return () => observed;
  }

  it.each([{ cpu: "4", memory: "8Gi" }, null])(
    "preserves the recorded resource decision %j during recreation (#13623)",
    async (resourceProfile) => {
      const source = onboardSession.createSession({ sandboxName: SANDBOX_NAME });
      source.resourceProfile = resourceProfile;
      source.sandboxPromptProgress.resourceProfile = true;
      vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
        expect(session.resourceProfile).toEqual(resourceProfile);
        expect(session.sandboxPromptProgress.resourceProfile).toBe(true);
        expect(session.checkpoint?.resourceProfile).toEqual(
          deriveCheckpointFromSession(source).resourceProfile,
        );
      });

      await expect(runRebuildRecreatePhase(makeInput({ sessionSnapshot: source }))).resolves.toBe(
        true,
      );
      expect(rebuildOnboardDependencies.onboard).toHaveBeenCalledOnce();
    },
  );

  it("does not reuse resource limits from a different sandbox session (#13623)", async () => {
    const source = onboardSession.createSession({ sandboxName: "different" });
    source.resourceProfile = { cpu: "4", memory: "8Gi" };
    source.sandboxPromptProgress.resourceProfile = true;
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
      expect(session.resourceProfile).toBeNull();
      expect(session.sandboxPromptProgress.resourceProfile).toBe(false);
    });

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          sessionSnapshot: source,
          sessionMatchesSandbox: false,
        }),
      ),
    ).resolves.toBe(true);
    expect(rebuildOnboardDependencies.onboard).toHaveBeenCalledOnce();
  });

  it("replays the recorded origin instead of the rebuild environment's CHAT_UI_URL", async () => {
    process.env.CHAT_UI_URL = "https://ambient.example.test";
    const observed = observeInnerChatUiUrl();

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          sandboxEntry: {
            name: SANDBOX_NAME,
            agent: "openclaw",
            dashboardExternalUrl: "https://launchpad.example.test:18789",
          },
          recreateOptions: { ...recreateOptions, controlUiPort: 18_790 },
        }),
      ),
    ).resolves.toBe(true);

    expect(observed()).toBe("https://launchpad.example.test:18790");
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring CHAT_UI_URL='https://ambient.example.test'"),
    );
    expect(process.env.CHAT_UI_URL).toBe("https://ambient.example.test");
  });

  it("replays the managed replacement profile's origin for a sandbox without a registry record", async () => {
    const observed = observeInnerChatUiUrl();
    const managedWorkloadRebuild = {
      replacementProfile: {
        profile: {
          dashboard: {
            agent: "openclaw",
            mode: "remote",
            url: "https://launchpad.example.test:18790",
            port: 18_790,
            bindAddress: "127.0.0.1",
            wslExposure: false,
          },
        },
      },
    } as unknown as NonNullable<RebuildRecreateOnboardOpts["managedWorkloadRebuild"]>;

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          recreateOptions: { ...recreateOptions, controlUiPort: 18_790, managedWorkloadRebuild },
        }),
      ),
    ).resolves.toBe(true);

    expect(observed()).toBe("https://launchpad.example.test:18790");
  });

  it("recreates a sandbox without a recorded origin on loopback", async () => {
    process.env.CHAT_UI_URL = "https://ambient.example.test";
    const observed = observeInnerChatUiUrl();

    await expect(
      runRebuildRecreatePhase(
        makeInput({ recreateOptions: { ...recreateOptions, controlUiPort: 18_790 } }),
      ),
    ).resolves.toBe(true);

    expect(observed()).toBe("http://127.0.0.1:18790");
    expect(process.env.CHAT_UI_URL).toBe("https://ambient.example.test");
  });

  it("restores the ambient CHAT_UI_URL after the inner onboard fails", async () => {
    process.env.CHAT_UI_URL = "https://ambient.example.test";
    let observed: string | undefined;
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
      observed = process.env.CHAT_UI_URL;
      throw new Error("inner onboard failed");
    });

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          sandboxEntry: {
            name: SANDBOX_NAME,
            agent: "openclaw",
            dashboardExternalUrl: "https://launchpad.example.test:18789",
          },
          recreateOptions: { ...recreateOptions, controlUiPort: 18_790 },
        }),
      ),
    ).rejects.toThrow("bail: Recreate failed");

    expect(observed).toBe("https://launchpad.example.test:18790");
    expect(process.env.CHAT_UI_URL).toBe("https://ambient.example.test");
  });
});

describe("rebuild recreate compatible-endpoint reasoning handoff (#7940)", () => {
  let previousReasoning: string | undefined;
  let previousReasoningEffort: string | undefined;

  beforeEach(() => {
    previousReasoning = process.env.NEMOCLAW_REASONING;
    previousReasoningEffort = process.env.NEMOCLAW_REASONING_EFFORT;
    stubJournaledRecreateSession();
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

describe("public rebuild resource replay through inner onboarding (#13623)", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_CPU", "");
    vi.stubEnv("NEMOCLAW_RAM", "");
    vi.stubEnv("NEMOCLAW_RESOURCE_PROFILE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      resourceProfile: { cpu: "4", memory: "8Gi" },
      resourceArgs: ["--cpu", "4", "--memory", "8Gi"],
    },
    { resourceProfile: null, resourceArgs: [] },
  ])(
    "passes the recorded decision $resourceProfile to recreation",
    async ({ resourceProfile, resourceArgs }) => {
      const harness = createRebuildFlowHarness();
      const resourceSession = harness.session as unknown as Session;
      resourceSession.resourceProfile = resourceProfile;
      resourceSession.sandboxPromptProgress.resourceProfile = true;
      const fixture = installRebuildResourceOnboardFixture(harness);
      onTestFinished(fixture.cleanup);

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Recreate failed");

      expect(fixture.selectResourceProfile).not.toHaveBeenCalled();
      expect(fixture.createSandbox).toHaveBeenCalledOnce();
      const createArgs = fixture.createSandbox.mock.calls[0];
      expect(createArgs[11]).toEqual(resourceProfile);
      expect((createArgs[15] as SandboxCreateIntent).resolved?.resourceCreateArgs).toEqual(
        resourceArgs,
      );
      expect(resourceSession.resourceProfile).toEqual(resourceProfile);
      expect(resourceSession.sandboxPromptProgress.resourceProfile).toBe(true);
      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(RESOURCE_CREATE_BOUNDARY),
      );
    },
  );
});
