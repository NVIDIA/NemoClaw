// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RebuildRecreateOnboardOpts } from "../../../src/lib/actions/sandbox/rebuild-gpu-opt-out.ts";
import { runRebuildRecreatePhase } from "../../../src/lib/actions/sandbox/rebuild-recreate-phase.ts";
import { MessagingSetupApplier } from "../../../src/lib/messaging/applier/setup-applier.ts";
import type { SandboxMessagingPlan } from "../../../src/lib/messaging/manifest/index.ts";
import { decisionSelected } from "../../../src/lib/state/onboard-checkpoint-decision.ts";
import { deriveCheckpointFromSession } from "../../../src/lib/state/onboard-checkpoint-migrate.ts";
import * as onboardSession from "../../../src/lib/state/onboard-session.ts";
import {
  GOOGLECHAT_E2E_ACCESS_TOKEN,
  addAndRebuildGooglechatForChannelsStopStartLiveE2e,
  installGooglechatCredentialFixture,
  rebuildGooglechatForChannelsStopStartLiveE2e,
} from "../live/channels-stop-start-helpers.ts";

type CredentialProviderRegistrationModule =
  typeof import("../../../src/lib/onboard/credential-provider-registration.ts");
type OnboardModule = {
  onboard(options: RebuildRecreateOnboardOpts): Promise<void>;
};
type SetupApplierModule = typeof import("../../../src/lib/messaging/applier/setup-applier.ts");
type FixtureRunner = typeof import("../../../src/lib/adapters/openshell/runtime.ts").runOpenshell;

const commonJsOnboard = require("../../../src/lib/onboard") as OnboardModule;
const commonJsRegistration =
  require("../../../src/lib/onboard/credential-provider-registration") as CredentialProviderRegistrationModule;
const commonJsSetupApplier =
  require("../../../src/lib/messaging/applier/setup-applier") as SetupApplierModule;

async function runRealRebuildRecreateHandoff(plan: SandboxMessagingPlan): Promise<boolean> {
  const gatewayAuthority = {
    gatewayName: "test-gateway",
    gatewayPort: 8080,
    mode: "nemoclaw-managed",
    source: "standalone",
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  } as const;
  let session = onboardSession.createSession({ sandboxName: plan.sandboxName });
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: plan.sandboxName, agent: plan.agent }),
    gatewayAuthority: decisionSelected(gatewayAuthority),
    sandboxRecreate: {
      version: 1,
      id: "fixture-journal",
      revision: 1,
      sandboxName: plan.sandboxName,
      gatewayName: gatewayAuthority.gatewayName,
      gatewayPort: gatewayAuthority.gatewayPort,
      sourceRegistryFingerprint: "fixture-registry",
      sourceLiveIdentityFingerprint: "fixture-live-identity",
      sourceWorkload: null,
      targetIntentFingerprint: "fixture-intent",
      targetGeneration: "fixture-generation",
      targetLiveIdentityFingerprint: null,
      phase: "deleted",
      startedAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:01.000Z",
    },
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
    session = mutator(session) ?? session;
    return session;
  });

  return runRebuildRecreatePhase({
    sandboxName: plan.sandboxName,
    sandboxEntry: { name: plan.sandboxName, agent: plan.agent },
    sessionSnapshot: onboardSession.createSession({ sandboxName: plan.sandboxName }),
    sessionMatchesSandbox: true,
    durableConfig: {
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
    },
    resumeConfig: {
      agent: plan.agent,
      provider: "nvidia",
      model: "nvidia/test-model",
      nimContainer: null,
      credentialEnv: "NVIDIA_API_KEY",
      preferredInferenceApi: null,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      pinEndpoint: true,
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      registryInferenceRoute: null,
      ambient: { presentVars: [], agentMismatch: null },
    },
    recreateOptions: {
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      authoritativeResumeConfig: true,
      rebuildPolicySourcePath: "/tmp/fixture-policy.yaml",
      acceptThirdPartySoftware: true,
      agent: plan.agent,
      recreateProvider: "nvidia",
      recreateModel: "nvidia/test-model",
      recreatePreferredInferenceApi: "openai",
      fromDockerfile: null,
      sandboxGpu: null,
      sandboxGpuDevice: null,
      controlUiPort: null,
      targetGatewayName: gatewayAuthority.gatewayName,
      targetGatewayPort: gatewayAuthority.gatewayPort,
      onboardLockAlreadyHeld: true,
      deferProcessExit: true,
      autoYes: true,
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      dcodeAutoApprovalRequestedExplicitly: false,
      observabilityEnabled: false,
      observabilityRequestedExplicitly: false,
      baseImageResolutionHint: null,
      rebuildGatewayAuthority: gatewayAuthority,
    },
    recreateJournal: {
      id: "fixture-journal",
      acceptedTarget: false,
      sourceConfirmedAbsent: false,
      gatewayAuthority,
      targetGeneration: "fixture-generation",
      targetIntentFingerprint: "fixture-intent",
      beginDelete: vi.fn(() => "source" as const),
      confirmDeleted: vi.fn(),
      completeAcceptedTarget: vi.fn(),
    },
    fromDockerfile: null,
    rebuildAgent: plan.agent,
    messagingPlan: plan,
    rebuildsHermesSandbox: plan.agent === "hermes",
    hermesToolGateways: [],
    hasHermesToolGateways: false,
    policySourcePath: "/tmp/fixture-policy.yaml",
    credentialEnv: "NVIDIA_API_KEY",
    baseImagePreflight: { ok: true, imageRef: null, overrideEnvVar: null },
    recoveryRecreate: false,
    preparedBackupRecovery: false,
    registryRollback: { recordRemoval: vi.fn(), restoreForRetry: vi.fn() },
    backupManifest: null,
    mcpEntries: [],
    log: vi.fn(),
    bail: vi.fn((message: string): never => {
      throw new Error(`bail: ${message}`);
    }),
  });
}

describe("channels stop/start Google Chat live composition", () => {
  it.each([
    ["openclaw", "e2e-oc-ch-cycle", "google-chat-bridge"],
    ["hermes", "e2e-hm-ch-cycle", "google-chat-hermes-bridge"],
  ] as const)(
    "uses the fixed access token for typed %s channel add and the late-bound rebuild graph (#11186)",
    async (agent, sandboxName, providerType) => {
      const providerName = `${sandboxName}-googlechat-bridge`;
      const privateKey = "fixture-private-key";
      const plan: SandboxMessagingPlan = {
        schemaVersion: 1,
        sandboxName,
        agent,
        workflow: "onboard",
        channels: [],
        disabledChannels: [],
        credentialBindings: [],
        networkPolicy: { presets: [], entries: [] },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      };
      const definition = {
        channelId: "googlechat",
        credentialId: "GOOGLE_CHAT_ACCESS_TOKEN",
        providerName,
        providerType,
        credentials: [
          { name: "GOOGLE_CHAT_ACCESS_TOKEN", value: "openshell-managed-pending-mint" },
        ],
        profile: { profilePath: "/repo/googlechat.yaml", profileType: providerType },
      } as const;
      const applied = {
        upserted: [],
        reused: [],
        missing: [],
        replacedProviderNames: [],
        providerNames: [providerName],
        sandboxCreateProviderArgs: ["--provider", providerName],
      } as const;
      const esmApply = vi
        .spyOn(MessagingSetupApplier, "applyCredentialsAtOpenShell")
        .mockResolvedValue(applied);
      const commonJsApply = vi
        .spyOn(commonJsSetupApplier.MessagingSetupApplier, "applyCredentialsAtOpenShell")
        .mockResolvedValue(applied);
      const runOpenshellMock = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
      const runOpenshell = runOpenshellMock as unknown as FixtureRunner;
      const registration = commonJsRegistration.createCredentialProviderRegistration({
        root: process.cwd(),
        runOpenshell,
        getGatewayName: () => "test-gateway",
        getCredential: (key) =>
          key === "GOOGLECHAT_SERVICE_ACCOUNT"
            ? JSON.stringify({ client_email: "bot@example.test", private_key: privateKey })
            : null,
        updateSession: vi.fn() as never,
        stagedLegacyValues: new Map(),
        migratedLegacyKeys: new Set(),
        persistMigratedLegacyKeys: vi.fn(),
      });
      const onboard = vi.spyOn(commonJsOnboard, "onboard").mockImplementation(async () => {
        const rebuildPlan = commonJsSetupApplier.MessagingSetupApplier.requirePlanFromEnv();
        expect(rebuildPlan).toEqual(plan);
        expect(onboardSession.loadSession()?.messagingPlan).toEqual(plan);
        await registration.applyMessagingProviders(
          [
            {
              name: providerName,
              envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
              token: "openshell-managed-pending-mint",
              providerType,
            },
          ],
          {},
          runOpenshell,
          rebuildPlan,
        );
      });
      const originalServiceAccount = process.env.GOOGLECHAT_SERVICE_ACCOUNT;
      const originalMessagingPlan = process.env.NEMOCLAW_MESSAGING_PLAN_B64;
      const restoreMessagingPlan =
        originalMessagingPlan === undefined
          ? () => Reflect.deleteProperty(process.env, "NEMOCLAW_MESSAGING_PLAN_B64")
          : () => {
              process.env.NEMOCLAW_MESSAGING_PLAN_B64 = originalMessagingPlan;
            };
      const restoreServiceAccount =
        originalServiceAccount === undefined
          ? () => Reflect.deleteProperty(process.env, "GOOGLECHAT_SERVICE_ACCOUNT")
          : () => {
              process.env.GOOGLECHAT_SERVICE_ACCOUNT = originalServiceAccount;
            };
      process.env.GOOGLECHAT_SERVICE_ACCOUNT = JSON.stringify({
        client_email: "bot@example.test",
        private_key: privateKey,
      });
      const fixture = installGooglechatCredentialFixture(sandboxName, agent);

      try {
        const addProviderNames = await fixture.upsertMessagingProviders(
          [
            {
              name: providerName,
              envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
              token: "openshell-managed-pending-mint",
              providerType,
            },
          ],
          "test-gateway",
          {},
          {
            plan,
            channelName: "googlechat",
            sandboxAgent: agent,
            sandboxName,
            revalidateSandboxIdentity: () => undefined,
          },
        );
        await expect(runRealRebuildRecreateHandoff(plan)).resolves.toBe(true);

        expect(addProviderNames).toEqual([providerName]);
        expect(onboard).toHaveBeenCalledOnce();
        expect(commonJsApply.mock.calls.map(([, options]) => options.refreshes)).toEqual([[], []]);
        expect(esmApply).not.toHaveBeenCalled();
        expect(commonJsApply).toHaveBeenCalledTimes(2);
        expect(
          commonJsApply.mock.calls.map(([, options]) => ({
            definitions: options.definitions?.map((receivedDefinition) => ({
              channelId: receivedDefinition.channelId,
              credentialId: receivedDefinition.credentialId,
              providerName: receivedDefinition.providerName,
              providerType: receivedDefinition.providerType,
              credentials: receivedDefinition.credentials,
              profileType: receivedDefinition.profile?.profileType,
            })),
            refreshes: options.refreshes,
          })),
        ).toEqual([
          {
            definitions: [
              {
                channelId: definition.channelId,
                credentialId: definition.credentialId,
                providerName: definition.providerName,
                providerType: definition.providerType,
                profileType: definition.profile.profileType,
                credentials: [
                  { name: "GOOGLE_CHAT_ACCESS_TOKEN", value: GOOGLECHAT_E2E_ACCESS_TOKEN },
                ],
              },
            ],
            refreshes: [],
          },
          {
            definitions: [
              {
                channelId: definition.channelId,
                credentialId: definition.credentialId,
                providerName: definition.providerName,
                providerType: definition.providerType,
                profileType: definition.profile.profileType,
                credentials: [
                  { name: "GOOGLE_CHAT_ACCESS_TOKEN", value: GOOGLECHAT_E2E_ACCESS_TOKEN },
                ],
              },
            ],
            refreshes: [],
          },
        ]);
        expect(runOpenshellMock).not.toHaveBeenCalled();
        expect(JSON.stringify(commonJsApply.mock.calls)).not.toContain(privateKey);
      } finally {
        fixture();
        restoreServiceAccount();
        restoreMessagingPlan();
        vi.restoreAllMocks();
      }
    },
  );

  it("grants a process-local audience capability to the exact live sandbox", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const rebuildSandbox = vi.fn(async () => {});
    const restore = vi.fn();
    const installCredentialFixture = vi.fn(() => restore);

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-oc-ch-cycle",
        agent: "openclaw",
        audience: "  https://e2e-fake.trycloudflare.com/googlechat  ",
      },
      { addSandboxChannel, installCredentialFixture, rebuildSandbox },
    );

    expect(installCredentialFixture).toHaveBeenCalledWith("e2e-oc-ch-cycle", "openclaw");
    expect(addSandboxChannel).toHaveBeenCalledWith(
      "e2e-oc-ch-cycle",
      { channel: "googlechat" },
      {
        googlechatNonInteractiveAudienceCapability: {
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
      },
    );
    expect(rebuildSandbox).toHaveBeenCalledWith("e2e-oc-ch-cycle", ["--yes"]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("adds Hermes Google Chat without the OpenClaw audience capability", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const rebuildSandbox = vi.fn(async () => {});
    const restore = vi.fn();
    const installCredentialFixture = vi.fn(() => restore);

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-hm-ch-cycle",
        agent: "hermes",
        audience: "https://e2e-fake.trycloudflare.com/googlechat",
      },
      { addSandboxChannel, installCredentialFixture, rebuildSandbox },
    );

    expect(installCredentialFixture).toHaveBeenCalledWith("e2e-hm-ch-cycle", "hermes");
    expect(addSandboxChannel).toHaveBeenCalledWith(
      "e2e-hm-ch-cycle",
      { channel: "googlechat" },
      {},
    );
    expect(rebuildSandbox).toHaveBeenCalledWith("e2e-hm-ch-cycle", ["--yes"]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("refuses to grant the capability outside the destructive live-test sandbox namespace", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const installCredentialFixture = vi.fn(() => vi.fn());

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "production-openclaw",
          agent: "openclaw",
          audience: "https://example.com/googlechat",
        },
        { addSandboxChannel, installCredentialFixture },
      ),
    ).rejects.toThrow(/only accepts openclaw sandbox names with prefix e2e-oc-ch-/);
    expect(addSandboxChannel).not.toHaveBeenCalled();
    expect(installCredentialFixture).not.toHaveBeenCalled();
  });

  it("refuses an empty live-test audience", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const installCredentialFixture = vi.fn(() => vi.fn());

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-oc-ch-cycle",
          agent: "openclaw",
          audience: " ",
        },
        { addSandboxChannel, installCredentialFixture },
      ),
    ).rejects.toThrow(/GOOGLECHAT_AUDIENCE is required/);
    expect(addSandboxChannel).not.toHaveBeenCalled();
    expect(installCredentialFixture).not.toHaveBeenCalled();
  });

  it("restores the provider boundary when channel add fails", async () => {
    const addSandboxChannel = vi.fn(async () => {
      throw new Error("planned add failed");
    });
    const restore = vi.fn();

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-hm-ch-cycle",
          agent: "hermes",
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
        {
          addSandboxChannel,
          installCredentialFixture: () => restore,
          rebuildSandbox: async () => {},
        },
      ),
    ).rejects.toThrow("planned add failed");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("keeps the provider fixture installed across add and rebuild", async () => {
    const events: string[] = [];
    const restore = vi.fn(() => events.push("restore"));

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-hm-ch-cycle",
        agent: "hermes",
        audience: "https://e2e-fake.trycloudflare.com/googlechat",
      },
      {
        installCredentialFixture: () => {
          events.push("install");
          return restore;
        },
        addSandboxChannel: async () => {
          events.push("add");
        },
        rebuildSandbox: async (_sandboxName, args) => {
          expect(args).toEqual(["--yes"]);
          events.push("rebuild");
        },
      },
    );

    expect(events).toEqual(["install", "add", "rebuild", "restore"]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("restores the provider fixture when rebuild fails", async () => {
    const restore = vi.fn();

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-oc-ch-cycle",
          agent: "openclaw",
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
        {
          installCredentialFixture: () => restore,
          addSandboxChannel: async () => {},
          rebuildSandbox: async () => {
            throw new Error("planned rebuild failed");
          },
        },
      ),
    ).rejects.toThrow("planned rebuild failed");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("keeps the provider fixture installed across a later lifecycle rebuild", async () => {
    const events: string[] = [];
    const restore = vi.fn(() => events.push("restore"));

    await rebuildGooglechatForChannelsStopStartLiveE2e(
      { sandboxName: "e2e-oc-ch-cycle", agent: "openclaw" },
      {
        installCredentialFixture: () => {
          events.push("install");
          return restore;
        },
        addSandboxChannel: async () => {},
        rebuildSandbox: async (_sandboxName, args) => {
          expect(args).toEqual(["--yes"]);
          events.push("rebuild");
        },
      },
    );

    expect(events).toEqual(["install", "rebuild", "restore"]);
    expect(restore).toHaveBeenCalledOnce();
  });
});
