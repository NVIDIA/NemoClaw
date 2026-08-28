// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreEnv } from "../../../../test/helpers/env-test-helpers";
import * as shields from "../../shields";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import type { CheckpointGatewayAuthority } from "../../state/onboard-checkpoint-types";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import type { RebuildDurableConfig } from "./rebuild-durable-config";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import { type RebuildRecreatePhaseInput, runRebuildRecreatePhase } from "./rebuild-recreate-phase";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

const DCODE_AGENT = "langchain-deepagents-code";

const STANDALONE_GATEWAY_AUTHORITY: CheckpointGatewayAuthority = {
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  mode: "nemoclaw-managed",
  source: "standalone",
  endpoint: null,
  stateDir: null,
  supervisor: null,
  requiredCapabilities: [],
};

const PACKAGED_GATEWAY_AUTHORITY: CheckpointGatewayAuthority = {
  ...STANDALONE_GATEWAY_AUTHORITY,
  source: "packaged-service",
};

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

const resumeConfig: RebuildResumeConfig = {
  agent: DCODE_AGENT,
  provider: "nvidia",
  model: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  nimContainer: null,
  credentialEnv: "NVIDIA_API_KEY",
  preferredInferenceApi: null,
  compatibleEndpointReasoning: null,
  compatibleEndpointReasoningEffort: null,
  pinEndpoint: true,
  endpointUrl: "https://integrate.api.nvidia.com/v1",
  registryInferenceRoute: null,
  ambient: { presentVars: [], agentMismatch: null },
};

const recreateOptions: RebuildRecreateOnboardOpts = {
  resume: true,
  nonInteractive: true,
  recreateSandbox: true,
  authoritativeResumeConfig: true,
  acceptThirdPartySoftware: true,
  agent: DCODE_AGENT,
  recreateProvider: "nvidia",
  recreateModel: "model-a",
  recreatePreferredInferenceApi: "openai",
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
  observabilityEnabled: true,
  observabilityRequestedExplicitly: true,
  policyTier: "restricted",
  baseImageResolutionHint: null,
  rebuildGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
};

function seedRecreateJournalCheckpoint(
  session: Session,
  gatewayAuthority: CheckpointGatewayAuthority = STANDALONE_GATEWAY_AUTHORITY,
): void {
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "alpha", agent: DCODE_AGENT }),
    gatewayAuthority: decisionSelected(gatewayAuthority),
    sandboxRecreate: {
      version: 1,
      id: "journal-1",
      revision: 3,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sourceRegistryFingerprint: "source-registry",
      sourceLiveIdentityFingerprint: "source-identity",
      sourceWorkload: null,
      targetIntentFingerprint: "intent-1",
      targetGeneration: "generation-1",
      targetLiveIdentityFingerprint: null,
      phase: "deleted",
      startedAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:01.000Z",
    },
  };
}

function makeInput(overrides: Partial<RebuildRecreatePhaseInput> = {}): RebuildRecreatePhaseInput {
  return {
    sandboxName: "alpha",
    sandboxEntry: {
      name: "alpha",
      agent: DCODE_AGENT,
      observabilityEnabled: true,
      policyTier: "restricted",
    },
    sessionSnapshot: onboardSession.createSession({
      sandboxName: "alpha",
      observabilityEnabled: false,
    }),
    sessionMatchesSandbox: true,
    durableConfig,
    resumeConfig,
    recreateOptions,
    recreateJournal: {
      id: "journal-1",
      acceptedTarget: false,
      sourceConfirmedAbsent: false,
      gatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
      targetGeneration: "generation-1",
      targetIntentFingerprint: "intent-1",
      markDeleting: vi.fn(),
      observeSourceForDelete: vi.fn(() => "source" as const),
      confirmDeleted: vi.fn(),
      completeAcceptedTarget: vi.fn(),
    },
    fromDockerfile: null,
    rebuildAgent: DCODE_AGENT,
    messagingPlan: null,
    rebuildsHermesSandbox: false,
    hermesToolGateways: [],
    hasHermesToolGateways: false,
    sessionPolicyPresets: ["observability-otlp-local"],
    credentialEnv: "NVIDIA_API_KEY",
    baseImagePreflight: { ok: true, imageRef: null, overrideEnvVar: null },
    recoveryRecreate: false,
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

describe("runRebuildRecreatePhase handoff", () => {
  let session: Session;

  beforeEach(() => {
    session = onboardSession.createSession({
      sandboxName: "alpha",
      observabilityEnabled: false,
    });
    seedRecreateJournalCheckpoint(session);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
    vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
      session = mutator(session) ?? session;
      return session;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists enabled observability before inner onboard and through successful recreate", async () => {
    const observedAtOnboard: boolean[] = [];
    const observedAtCreated: boolean[] = [];
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async (options) => {
      observedAtOnboard.push(onboardSession.loadSession()?.observabilityEnabled === true);
      expect(options.observabilityEnabled).toBe(true);
    });
    const input = makeInput({
      onCreated: vi.fn(() => {
        observedAtCreated.push(onboardSession.loadSession()?.observabilityEnabled === true);
      }),
    });

    await expect(runRebuildRecreatePhase(input)).resolves.toBe(true);

    expect(observedAtOnboard).toEqual([true]);
    expect(observedAtCreated).toEqual([true]);
    expect(onboardSession.loadSession()?.observabilityEnabled).toBe(true);
    expect(onboardSession.loadSession()?.observabilityRequestedExplicitly).toBe(true);
    expect(input.onCreated).toHaveBeenCalledOnce();
    expect(input.registryRollback.restoreForRetry).not.toHaveBeenCalled();
    expect(input.bail).not.toHaveBeenCalled();
  });

  it("retains inherited observability provenance through inner onboard handoff", async () => {
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async (options) => {
      expect(options.observabilityEnabled).toBe(true);
      expect(options.observabilityRequestedExplicitly).toBe(false);
      expect(onboardSession.loadSession()?.observabilityRequestedExplicitly).toBe(false);
    });

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          recreateOptions: {
            ...recreateOptions,
            observabilityRequestedExplicitly: false,
          },
        }),
      ),
    ).resolves.toBe(true);

    expect(onboardSession.loadSession()?.observabilityEnabled).toBe(true);
    expect(onboardSession.loadSession()?.observabilityRequestedExplicitly).toBe(false);
  });

  it("carries the replacement journal and its target fingerprint into inner onboard (#7734)", async () => {
    const retiredSessionId = session.sessionId;
    let observedFingerprint: string | null | undefined;
    let observedJournalPhase: string | undefined;
    let observedCheckpointSessionId: string | undefined;
    const onboardSpy = vi
      .spyOn(rebuildOnboardDependencies, "onboard")
      .mockImplementation(async (options) => {
        observedFingerprint = options.recreateJournalTargetIntentFingerprint;
        const carried = onboardSession.loadSession()?.checkpoint;
        observedJournalPhase = carried?.sandboxRecreate?.phase;
        observedCheckpointSessionId = carried?.sessionId;
      });

    try {
      await expect(runRebuildRecreatePhase(makeInput())).resolves.toBe(true);

      expect(observedFingerprint).toBe("intent-1");
      expect(observedJournalPhase).toBe("deleted");
      expect(observedCheckpointSessionId).toBe(onboardSession.loadSession()?.sessionId);
      expect(observedCheckpointSessionId).not.toBe(retiredSessionId);
      expect(onboardSession.loadSession()?.checkpoint?.effectGroups).toEqual({});
    } finally {
      onboardSpy.mockRestore();
    }
  });

  it("carries the recreate host mounts into the session inner onboard resumes (#9451)", async () => {
    const hostMounts = [
      {
        source: "/srv/host-share",
        target: "/sandbox/host-share",
        readOnly: true as const,
        sourceIdentity: { device: "66306", inode: "12345" },
      },
    ];
    let recordedHostMounts: unknown;
    let requestedHostMounts: unknown;
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async (options) => {
      recordedHostMounts = onboardSession.loadSession()?.metadata.hostMounts;
      requestedHostMounts = options.hostMounts;
    });

    await expect(
      runRebuildRecreatePhase(makeInput({ recreateOptions: { ...recreateOptions, hostMounts } })),
    ).resolves.toBe(true);

    // Both sides of the resume host-mount comparison must agree; an empty
    // recorded set aborted the resume after the old sandbox was deleted.
    expect(recordedHostMounts).toEqual(hostMounts);
    expect(requestedHostMounts).toEqual(hostMounts);
    expect(recordedHostMounts).not.toBe(hostMounts);
  });

  it("records no host mounts when the recreate target declares none (#9451)", async () => {
    let recordedHostMounts: unknown = "inner onboard was never reached";
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
      recordedHostMounts = onboardSession.loadSession()?.metadata.hostMounts;
    });

    await expect(runRebuildRecreatePhase(makeInput())).resolves.toBe(true);

    expect(recordedHostMounts).toBeUndefined();
  });

  it("carries the journal authority instead of a stale preflight option (#7411)", async () => {
    let observedAuthority: unknown;
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async (options) => {
      observedAuthority = options.rebuildGatewayAuthority;
    });

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          recreateOptions: {
            ...recreateOptions,
            rebuildGatewayAuthority: PACKAGED_GATEWAY_AUTHORITY,
          },
        }),
      ),
    ).resolves.toBe(true);

    expect(observedAuthority).toBe(STANDALONE_GATEWAY_AUTHORITY);
    const selected = onboardSession.loadSession()?.checkpoint?.gatewayAuthority;
    expect(selected?.kind === "selected" && selected.value).toBe(STANDALONE_GATEWAY_AUTHORITY);
  });

  it("refuses a changed checkpoint authority before recreating the sandbox (#7411)", async () => {
    seedRecreateJournalCheckpoint(session, PACKAGED_GATEWAY_AUTHORITY);
    const onboardSpy = vi.spyOn(rebuildOnboardDependencies, "onboard");

    await expect(runRebuildRecreatePhase(makeInput())).rejects.toThrow(
      "bail: Authoritative rebuild journal authority changed before sandbox recreation.",
    );

    expect(onboardSession.updateSession).not.toHaveBeenCalled();
    expect(onboardSpy).not.toHaveBeenCalled();
  });

  it("pins the authoritative restricted tier during recreate and restores ambient policy input", async () => {
    const previousPolicyTier = process.env.NEMOCLAW_POLICY_TIER;
    process.env.NEMOCLAW_POLICY_TIER = "open";
    try {
      let observedTier: string | undefined;
      vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
        observedTier = process.env.NEMOCLAW_POLICY_TIER;
      });

      await expect(runRebuildRecreatePhase(makeInput())).resolves.toBe(true);

      expect(observedTier).toBe("restricted");
      expect(process.env.NEMOCLAW_POLICY_TIER).toBe("open");
    } finally {
      restoreEnv("NEMOCLAW_POLICY_TIER", previousPolicyTier);
    }
  });

  it("does not take a second backup during the inner recreate", async () => {
    const previousRecreateWithoutBackup = process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
    delete process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
    try {
      let observedBackupMarker: string | undefined;
      vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
        observedBackupMarker = process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
      });

      await expect(
        runRebuildRecreatePhase(
          makeInput({
            backupManifest: {
              backupPath: "/tmp/rebuild-backups/alpha/2026-07-22T04-36-37-633Z",
              timestamp: "2026-07-22T04-36-37-633Z",
            } as never,
          }),
        ),
      ).resolves.toBe(true);

      expect(observedBackupMarker).toBe("1");
      expect(process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP).toBeUndefined();
    } finally {
      restoreEnv("NEMOCLAW_RECREATE_WITHOUT_BACKUP", previousRecreateWithoutBackup);
    }
  });

  it("carries preserved Hermes home channels to the Dockerfile patch boundary (#7803)", async () => {
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async (options) => {
      expect(options.rebuildPreservedEnv).toEqual([
        {
          path: ".env",
          assignments: ["SLACK_HOME_CHANNEL=C0123", "SLACK_HOME_CHANNEL_THREAD_ID="],
        },
      ]);
    });

    await expect(
      runRebuildRecreatePhase(
        makeInput({
          sandboxEntry: {
            name: "alpha",
            agent: "hermes",
            observabilityEnabled: true,
            policyTier: "restricted",
          },
          rebuildAgent: "hermes",
          rebuildsHermesSandbox: true,
          messagingPlan: {
            schemaVersion: 1,
            sandboxName: "alpha",
            agent: "hermes",
            workflow: "rebuild",
            channels: [
              {
                channelId: "slack",
                displayName: "Slack",
                authMode: "token-paste",
                active: true,
                selected: true,
                configured: true,
                disabled: false,
                inputs: [],
                hooks: [],
              },
            ],
            disabledChannels: [],
            credentialBindings: [],
            networkPolicy: { presets: [], entries: [] },
            agentRender: [],
            buildSteps: [],
            stateUpdates: [],
            healthChecks: [],
          },
          backupManifest: {
            preservedEnv: [
              {
                path: ".env",
                assignments: ["SLACK_HOME_CHANNEL=C0123", "SLACK_HOME_CHANNEL_THREAD_ID="],
              },
            ],
          } as never,
        }),
      ),
    ).resolves.toBe(true);
  });

  it("restores the caller backup marker after inner recreate failure", async () => {
    const previousRecreateWithoutBackup = process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
    process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = "0";
    try {
      let observedBackupMarker: string | undefined;
      vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async () => {
        observedBackupMarker = process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
        throw new Error("inner onboard failed");
      });

      await expect(runRebuildRecreatePhase(makeInput())).rejects.toThrow(
        "bail: Recreate failed (stale-sandbox recovery).",
      );

      expect(observedBackupMarker).toBe("1");
      expect(process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP).toBe("0");
    } finally {
      restoreEnv("NEMOCLAW_RECREATE_WITHOUT_BACKUP", previousRecreateWithoutBackup);
    }
  });

  it("retains enabled observability through inner onboard failure, recovery, and bail", async () => {
    const checkpoints: Array<[string, boolean]> = [];
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockImplementation(async (options) => {
      checkpoints.push([
        "onboard",
        options.observabilityEnabled === true &&
          onboardSession.loadSession()?.observabilityEnabled === true,
      ]);
      throw new Error("inner onboard failed");
    });
    const input = makeInput({
      recoveryRecreate: true,
      registryRollback: {
        recordRemoval: vi.fn(),
        restoreForRetry: vi.fn(() => {
          checkpoints.push([
            "rollback",
            onboardSession.loadSession()?.observabilityEnabled === true,
          ]);
        }),
      },
      relockShieldsIfNeeded: vi.fn(() => {
        checkpoints.push(["relock", onboardSession.loadSession()?.observabilityEnabled === true]);
        return true;
      }),
      bail: vi.fn((message: string): never => {
        checkpoints.push(["bail", onboardSession.loadSession()?.observabilityEnabled === true]);
        throw new Error(`bail: ${message}`);
      }),
    });

    await expect(runRebuildRecreatePhase(input)).rejects.toThrow(
      "bail: Recreate failed (stale-sandbox recovery).",
    );

    expect(checkpoints).toEqual([
      ["onboard", true],
      ["rollback", true],
      ["relock", true],
      ["bail", true],
    ]);
    expect(onboardSession.loadSession()?.observabilityEnabled).toBe(true);
    expect(input.registryRollback.restoreForRetry).toHaveBeenCalledOnce();
    expect(input.relockShieldsIfNeeded).toHaveBeenCalledWith(false);
    expect(input.onCreated).not.toHaveBeenCalled();
    expect(input.bail).toHaveBeenCalledWith("Recreate failed (stale-sandbox recovery).", 1);
  });
});

describe("rebuild recreate shields state", () => {
  let session: Session;

  beforeEach(() => {
    session = onboardSession.createSession({
      sandboxName: "alpha",
      observabilityEnabled: false,
    });
    seedRecreateJournalCheckpoint(session);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
    vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
      session = mutator(session) ?? session;
      return session;
    });
    vi.spyOn(rebuildOnboardDependencies, "onboard").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears prior shields state only after a recovery recreate succeeds (#8283)", async () => {
    const clearShieldsState = vi
      .spyOn(shields, "clearShieldsState")
      .mockImplementation(() => undefined);

    await expect(runRebuildRecreatePhase(makeInput({ recoveryRecreate: false }))).resolves.toBe(
      true,
    );
    expect(clearShieldsState).not.toHaveBeenCalled();

    await expect(runRebuildRecreatePhase(makeInput({ recoveryRecreate: true }))).resolves.toBe(
      true,
    );
    expect(clearShieldsState).toHaveBeenCalledOnce();
    expect(clearShieldsState).toHaveBeenCalledWith("alpha");
  });

  it("keeps prior shields state when a recovery recreate fails (#8283)", async () => {
    const clearShieldsState = vi
      .spyOn(shields, "clearShieldsState")
      .mockImplementation(() => undefined);
    vi.mocked(rebuildOnboardDependencies.onboard).mockRejectedValue(
      new Error("inner onboard failed"),
    );

    await expect(runRebuildRecreatePhase(makeInput({ recoveryRecreate: true }))).rejects.toThrow(
      "bail: Recreate failed (stale-sandbox recovery).",
    );

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Sandbox recreate error: inner onboard failed"),
    );
    expect(clearShieldsState).not.toHaveBeenCalled();
  });
});
