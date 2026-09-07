// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  resolveGatewayRebuildAuthority: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  captureOpenshell: mocks.captureOpenshell,
  runOpenshell: vi.fn(),
}));

vi.mock("../../onboard/gateway-teardown-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/gateway-teardown-authority")>()),
  resolveGatewayRebuildAuthority: mocks.resolveGatewayRebuildAuthority,
}));

import { fingerprintSandboxRecreateValue } from "../../onboard/sandbox-recreate-transaction";
import type { CheckpointGatewayAuthority } from "../../state/onboard-checkpoint-types";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import type { RebuildManifest } from "../../state/sandbox";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import {
  clearRebuildRecoveryBackup,
  findRebuildRecoveryBackup,
  fingerprintRebuildRecreateTargetIntent,
  isRebuildRecoveryCleanupOnly,
  markRebuildRecoveryCleanupOnly,
  observeRebuildSandbox,
  openRebuildRecreateJournal,
  recordRebuildRecoveryBackup,
  retireRebuildRecoveryBackup,
} from "./rebuild-recreate-journal";

const SANDBOX_ID = "sbx-0d6f4c2a91";
const HOST_MOUNT = {
  source: "/srv/host-share",
  target: "/sandbox/host-share",
  readOnly: true,
  sourceIdentity: { device: "66306", inode: "12345" },
} as const;
const PRE_HOST_MOUNT_FINGERPRINT =
  "831bd40537ec3112f056079c89476ef2d62ce30664d0d11573c98301de81139e";

const NON_DEFAULT_TARGET = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw-9090",
  gatewayPort: 9090,
};

const STANDALONE_GATEWAY_AUTHORITY: CheckpointGatewayAuthority = {
  gatewayName: "nemoclaw-9090",
  gatewayPort: 9090,
  mode: "nemoclaw-managed",
  source: "standalone",
  endpoint: null,
  stateDir: null,
  supervisor: null,
  requiredCapabilities: [],
};

const recreateOptions: RebuildRecreateOnboardOpts = {
  resume: true,
  nonInteractive: true,
  recreateSandbox: true,
  authoritativeResumeConfig: true,
  rebuildPolicySourcePath: "/tmp/current-policy.yaml",
  acceptThirdPartySoftware: true,
  agent: "langchain-deepagents-code",
  recreateProvider: "nvidia",
  recreateModel: "model-a",
  recreatePreferredInferenceApi: "openai",
  fromDockerfile: null,
  sandboxGpu: null,
  sandboxGpuDevice: null,
  controlUiPort: null,
  hostMounts: [HOST_MOUNT],
  targetGatewayName: "nemoclaw-9090",
  targetGatewayPort: 9090,
  onboardLockAlreadyHeld: true,
  deferProcessExit: true,
  autoYes: true,
  toolDisclosure: "progressive",
  dcodeAutoApprovalMode: "disabled",
  dcodeAutoApprovalRequestedExplicitly: false,
  observabilityEnabled: true,
  observabilityRequestedExplicitly: true,
  baseImageResolutionHint: null,
};

function livePresentProbe(phase = "Ready") {
  return {
    status: 0,
    output: `Name: alpha\nId: ${SANDBOX_ID}\nPhase: ${phase}\n`,
    stdout: `Name: alpha\nId: ${SANDBOX_ID}\nPhase: ${phase}\n`,
    stderr: "",
  };
}

function absentProbe() {
  return {
    status: 1,
    output: "",
    stdout: "",
    stderr: "Error: sandbox alpha not found",
  };
}

describe("rebuild replacement target fingerprint", () => {
  it("carries only validated non-secret rebuild inputs", () => {
    const withTransientHandoffs: RebuildRecreateOnboardOpts = {
      ...recreateOptions,
      autoYes: false,
      dcodeAutoApprovalRequestedExplicitly: true,
      observabilityRequestedExplicitly: false,
      preparedDcodeRebuild: {
        stagingDir: "/tmp/rebuild-xyz",
      } as unknown as RebuildRecreateOnboardOpts["preparedDcodeRebuild"],
    };

    expect(fingerprintRebuildRecreateTargetIntent(withTransientHandoffs)).toBe(
      fingerprintRebuildRecreateTargetIntent(recreateOptions),
    );
  });

  it.each([
    { dcodeAutoApprovalMode: "thread-opt-in" },
    { endpointSource: "onboard" },
    { recreateProvider: "compatible-endpoint" },
    { recreateModel: "model-b" },
    { recreatePreferredInferenceApi: "anthropic" },
  ] as const)("changes when a recorded replacement input changes [case %#]", (drift) => {
    expect(fingerprintRebuildRecreateTargetIntent({ ...recreateOptions, ...drift })).not.toBe(
      fingerprintRebuildRecreateTargetIntent(recreateOptions),
    );
  });

  it("changes when the replacement targets another gateway", () => {
    expect(
      fingerprintRebuildRecreateTargetIntent({
        ...recreateOptions,
        targetGatewayName: "nemoclaw",
        targetGatewayPort: 8080,
      }),
    ).not.toBe(fingerprintRebuildRecreateTargetIntent(recreateOptions));
  });

  it("preserves the previous fingerprint for a replacement without host mounts (#9451)", () => {
    expect(fingerprintRebuildRecreateTargetIntent({ ...recreateOptions, hostMounts: [] })).toBe(
      PRE_HOST_MOUNT_FINGERPRINT,
    );
  });

  it("separates a mounted replacement from the pre-binding fingerprint (#9451)", () => {
    expect(fingerprintRebuildRecreateTargetIntent(recreateOptions)).not.toBe(
      PRE_HOST_MOUNT_FINGERPRINT,
    );
  });

  it("changes when the replacement host mount identity changes (#9451)", () => {
    expect(
      fingerprintRebuildRecreateTargetIntent({
        ...recreateOptions,
        hostMounts: [
          {
            ...HOST_MOUNT,
            sourceIdentity: { ...HOST_MOUNT.sourceIdentity, inode: "67890" },
          },
        ],
      }),
    ).not.toBe(fingerprintRebuildRecreateTargetIntent(recreateOptions));
  });
});

describe("rebuild replacement observation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries only the journaled gateway", () => {
    mocks.captureOpenshell.mockReturnValue(absentProbe());

    observeRebuildSandbox(NON_DEFAULT_TARGET);

    expect(mocks.captureOpenshell).toHaveBeenCalledTimes(1);
    expect(mocks.captureOpenshell.mock.calls[0]?.[0]).toEqual([
      "sandbox",
      "get",
      "-g",
      "nemoclaw-9090",
      "alpha",
    ]);
  });

  it("reports explicit absence without an identity", () => {
    mocks.captureOpenshell.mockReturnValue(absentProbe());

    expect(observeRebuildSandbox(NON_DEFAULT_TARGET)).toEqual({
      state: "missing",
      liveIdentityFingerprint: null,
    });
  });

  it("hashes a live identity instead of recording it", () => {
    mocks.captureOpenshell.mockReturnValue(livePresentProbe());

    const observation = observeRebuildSandbox(NON_DEFAULT_TARGET);

    expect(observation.state).toBe("ready");
    expect(observation.liveIdentityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(observation.liveIdentityFingerprint).not.toContain(SANDBOX_ID);
  });

  it("separates a live sandbox that is not ready", () => {
    mocks.captureOpenshell.mockReturnValue(livePresentProbe("Pending"));

    expect(observeRebuildSandbox(NON_DEFAULT_TARGET).state).toBe("not_ready");
  });

  it("fails closed when a live sandbox has no stable identity", () => {
    mocks.captureOpenshell.mockReturnValue({
      status: 0,
      output: "Name: alpha\nPhase: Ready\n",
      stdout: "Name: alpha\nPhase: Ready\n",
      stderr: "",
    });

    expect(() => observeRebuildSandbox(NON_DEFAULT_TARGET)).toThrow(
      /did not report a stable sandbox Id/,
    );
  });

  it("fails closed when the gateway proves neither presence nor absence", () => {
    mocks.captureOpenshell.mockReturnValue({
      status: 1,
      output: "",
      stdout: "",
      stderr: "Error: connection refused",
    });

    expect(() => observeRebuildSandbox(NON_DEFAULT_TARGET)).toThrow(
      /neither a live sandbox nor explicit absence/,
    );
  });
});

describe("rebuild replacement journal", () => {
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    session = onboardSession.createSession({ sandboxName: "alpha" });
    vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
    vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
      session = mutator(session) ?? session;
      return session;
    });
    vi.spyOn(onboardSession, "compareAndSwapSession").mockImplementation((matches, mutator) => {
      return matches(session) ? ((session = mutator(session) ?? session), "updated") : "mismatch";
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
    } as registry.SandboxEntry);
    mocks.resolveGatewayRebuildAuthority.mockReturnValue(STANDALONE_GATEWAY_AUTHORITY);
    mocks.captureOpenshell.mockReturnValue(livePresentProbe());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function open(target = NON_DEFAULT_TARGET) {
    return openRebuildRecreateJournal({
      target,
      expectedGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
      agentName: "langchain-deepagents-code",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(recreateOptions),
      log: vi.fn(),
    });
  }

  it("binds a secret-free replacement to the non-default gateway before deletion", () => {
    const journal = open();

    const recorded = session.checkpoint?.sandboxRecreate;
    expect(recorded?.phase).toBe("planned");
    expect(recorded?.gatewayName).toBe("nemoclaw-9090");
    expect(recorded?.gatewayPort).toBe(9090);
    expect(recorded?.sourceLiveIdentityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded?.targetIntentFingerprint).toBe(journal.targetIntentFingerprint);
    expect(JSON.stringify(session.checkpoint)).not.toContain(SANDBOX_ID);
  });

  it("selects the exact gateway authority the journal records", () => {
    const journal = open();

    expect(mocks.resolveGatewayRebuildAuthority).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
    });
    const authority = session.checkpoint?.gatewayAuthority;
    expect(authority?.kind).toBe("selected");
    expect(authority?.kind === "selected" && authority.value.gatewayPort).toBe(9090);
    expect(authority?.kind === "selected" && authority.value.source).toBe("standalone");
    expect(authority?.kind === "selected" && authority.value).toBe(journal.gatewayAuthority);
  });

  it("refuses the standalone to package-managed authority change after preflight (#7411)", () => {
    const onAuthorityRefusal = vi.fn();
    mocks.resolveGatewayRebuildAuthority.mockReturnValue({
      ...STANDALONE_GATEWAY_AUTHORITY,
      source: "packaged-service",
    });

    expect(() =>
      openRebuildRecreateJournal({
        target: NON_DEFAULT_TARGET,
        expectedGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
        agentName: "langchain-deepagents-code",
        targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(recreateOptions),
        log: vi.fn(),
        onAuthorityRefusal,
      }),
    ).toThrow(/authority changed after authoritative rebuild preflight/);

    expect(onAuthorityRefusal).toHaveBeenCalledOnce();
    expect(onboardSession.updateSession).not.toHaveBeenCalled();
    expect(session.checkpoint?.sandboxRecreate ?? null).toBeNull();
  });

  it("adopts the package-managed to standalone migration and journals standalone (#9088)", () => {
    const onAuthorityRefusal = vi.fn();

    const journal = openRebuildRecreateJournal({
      target: NON_DEFAULT_TARGET,
      expectedGatewayAuthority: {
        ...STANDALONE_GATEWAY_AUTHORITY,
        source: "packaged-service",
      },
      agentName: "langchain-deepagents-code",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(recreateOptions),
      log: vi.fn(),
      onAuthorityRefusal,
    });

    expect(onAuthorityRefusal).not.toHaveBeenCalled();
    expect(journal.gatewayAuthority.source).toBe("standalone");
    expect(session.checkpoint?.gatewayAuthority).toMatchObject({
      kind: "selected",
      value: { source: "standalone" },
    });
  });

  it("starts at deleted when the source sandbox is already absent", () => {
    mocks.captureOpenshell.mockReturnValue(absentProbe());

    open();

    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleted");
    expect(session.checkpoint?.sandboxRecreate?.sourceLiveIdentityFingerprint).toBeNull();
  });

  it("starts a fresh journal when the stranded one no longer owns a replacement (#10473)", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
      lifecycleGeneration: "44444444-4444-4444-8444-444444444444",
      lifecycleLiveIdentityFingerprint: fingerprintSandboxRecreateValue(SANDBOX_ID),
    } as registry.SandboxEntry);
    const stranded = open();
    onboardSession.updateSession((current) => {
      const checkpoint = current.checkpoint as NonNullable<Session["checkpoint"]>;
      const transaction = checkpoint.sandboxRecreate as NonNullable<
        typeof checkpoint.sandboxRecreate
      >;
      current.checkpoint = {
        ...checkpoint,
        sandboxRecreate: { ...transaction, phase: "deleted" },
      };
      return current;
    });
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      id: stranded.id,
      phase: "deleted",
    });

    const restarted = open();

    expect(restarted.id).not.toBe(stranded.id);
    expect(restarted.acceptedTarget).toBe(false);
    expect(restarted.sourceConfirmedAbsent).toBe(false);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      id: restarted.id,
      phase: "planned",
      revision: 0,
    });
  });

  it("keeps a stranded journal when the matching source is on another gateway (#10473)", () => {
    mocks.captureOpenshell.mockReturnValue(absentProbe());
    const stranded = open();
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      id: stranded.id,
      gatewayName: "nemoclaw-9090",
      phase: "deleted",
    });

    // Same sandbox name and same live identity, but the row and the probe now
    // describe a sandbox on a different gateway. The journal may still own an
    // unregistered replacement on nemoclaw-9090, so it must survive.
    mocks.captureOpenshell.mockReturnValue(livePresentProbe());
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw-7070",
      gatewayPort: 7070,
      lifecycleGeneration: "44444444-4444-4444-8444-444444444444",
      lifecycleLiveIdentityFingerprint: fingerprintSandboxRecreateValue(SANDBOX_ID),
    } as registry.SandboxEntry);

    expect(() =>
      open({ sandboxName: "alpha", gatewayName: "nemoclaw-7070", gatewayPort: 7070 }),
    ).toThrow(/different recreate transaction in progress/);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      id: stranded.id,
      gatewayName: "nemoclaw-9090",
      phase: "deleted",
    });
  });

  it("records the delete boundary before and after the destructive command", () => {
    const journal = open();

    journal.beginDelete();
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleting");

    mocks.captureOpenshell.mockReturnValue(absentProbe());
    journal.confirmDeleted();
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleted");
  });

  it("keeps a proven deletion when a recovery rebuild deletes an already absent source", () => {
    mocks.captureOpenshell.mockReturnValue(absentProbe());
    const journal = open();

    journal.beginDelete();

    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleted");
  });

  it("stops before the next mutation when the source outlives its delete", () => {
    const journal = open();
    journal.beginDelete();

    expect(() => journal.confirmDeleted()).toThrow(
      /OpenShell still reports the journaled source after delete/,
    );
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleting");
  });

  it("refuses to resume when a different same-name sandbox holds the name", () => {
    open();
    mocks.captureOpenshell.mockReturnValue({
      status: 0,
      output: "Name: alpha\nId: sbx-replaced-by-another\nPhase: Ready\n",
      stdout: "Name: alpha\nId: sbx-replaced-by-another\nPhase: Ready\n",
      stderr: "",
    });

    expect(() => open()).toThrow(/no longer has the journaled source identity/);
  });

  it("refuses to resume a journal that targets another replacement", () => {
    open();

    expect(() =>
      openRebuildRecreateJournal({
        target: NON_DEFAULT_TARGET,
        expectedGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
        agentName: "langchain-deepagents-code",
        targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent({
          ...recreateOptions,
          dcodeAutoApprovalMode: "thread-opt-in",
        }),
        log: vi.fn(),
      }),
    ).toThrow(/different recreate transaction in progress/);
  });

  it("refuses to resume a journal whose host mount identity changed (#9451)", () => {
    open();

    expect(() =>
      openRebuildRecreateJournal({
        target: NON_DEFAULT_TARGET,
        expectedGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
        agentName: "langchain-deepagents-code",
        targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent({
          ...recreateOptions,
          hostMounts: [
            {
              ...HOST_MOUNT,
              sourceIdentity: { ...HOST_MOUNT.sourceIdentity, inode: "67890" },
            },
          ],
        }),
        log: vi.fn(),
      }),
    ).toThrow(/different recreate transaction in progress/);
  });

  it("refuses to resume a journal whose endpoint provenance changed (#7734)", () => {
    open();

    expect(() =>
      openRebuildRecreateJournal({
        target: NON_DEFAULT_TARGET,
        expectedGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
        agentName: "langchain-deepagents-code",
        targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent({
          ...recreateOptions,
          endpointSource: "onboard",
        }),
        log: vi.fn(),
      }),
    ).toThrow(/different recreate transaction in progress/);
  });

  it.each([
    { recreateProvider: "compatible-endpoint" },
    { recreateModel: "model-b" },
    { recreatePreferredInferenceApi: "anthropic" },
  ] as const)("refuses to resume a journal whose inference route changed (#7734)", (drift) => {
    open();

    expect(() =>
      openRebuildRecreateJournal({
        target: NON_DEFAULT_TARGET,
        expectedGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
        agentName: "langchain-deepagents-code",
        targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent({
          ...recreateOptions,
          ...drift,
        }),
        log: vi.fn(),
      }),
    ).toThrow(/different recreate transaction in progress/);
  });

  it("resumes the same replacement without restarting its generation", () => {
    const first = open();

    const second = open();

    expect(second.id).toBe(first.id);
    expect(second.targetGeneration).toBe(first.targetGeneration);
  });

  function proveReplacement(targetGeneration: string): string {
    const identity = session.checkpoint?.sandboxRecreate?.sourceLiveIdentityFingerprint ?? "";
    onboardSession.updateSession((current) => {
      const checkpoint = current.checkpoint as NonNullable<Session["checkpoint"]>;
      current.checkpoint = {
        ...checkpoint,
        sandboxRecreate: {
          ...(checkpoint.sandboxRecreate as NonNullable<typeof checkpoint.sandboxRecreate>),
          phase: "registry_committing",
          targetLiveIdentityFingerprint: identity,
        },
      };
      return current;
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
      lifecycleGeneration: targetGeneration,
      lifecycleLiveIdentityFingerprint: identity,
    } as registry.SandboxEntry);
    return identity;
  }

  it("reports a registered ready replacement as the proven target (#7734)", () => {
    const first = open();
    proveReplacement(first.targetGeneration);

    const resumed = open();

    expect(first.acceptedTarget).toBe(false);
    expect(resumed.acceptedTarget).toBe(true);
    expect(resumed.id).toBe(first.id);
  });

  it("pins an interrupted replacement observation to its recorded OpenShell target (#10514)", () => {
    open();
    const runtimeSelection = {
      gatewayName: "nemoclaw-9090",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const resolveRuntimeSelection = vi.fn(() => runtimeSelection);
    mocks.captureOpenshell.mockClear();

    const resumed = openRebuildRecreateJournal({
      target: NON_DEFAULT_TARGET,
      expectedGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
      agentName: "langchain-deepagents-code",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(recreateOptions),
      log: vi.fn(),
      resolveRuntimeSelection,
    });

    expect(resolveRuntimeSelection).toHaveBeenCalledOnce();
    expect(resumed.runtimeSelection).toEqual(runtimeSelection);
    expect(mocks.captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-9090", "alpha"],
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "nemoclaw-9090",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        }),
      }),
    );
  });

  it("pins the first replacement observation to its recorded OpenShell target (#10514)", () => {
    const runtimeSelection = {
      gatewayName: "nemoclaw-9090",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const resolveRuntimeSelection = vi.fn(() => runtimeSelection);

    const journal = openRebuildRecreateJournal({
      target: NON_DEFAULT_TARGET,
      expectedGatewayAuthority: STANDALONE_GATEWAY_AUTHORITY,
      agentName: "langchain-deepagents-code",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(recreateOptions),
      log: vi.fn(),
      resolveRuntimeSelection,
    });

    expect(resolveRuntimeSelection).toHaveBeenCalledOnce();
    expect(journal.runtimeSelection).toEqual(runtimeSelection);
    expect(mocks.captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-9090", "alpha"],
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "nemoclaw-9090",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        }),
      }),
    );
  });

  it("retires the journal of a proven replacement instead of deleting it again (#7734)", () => {
    const first = open();
    proveReplacement(first.targetGeneration);
    const resumed = open();

    resumed.completeAcceptedTarget();

    expect(session.checkpoint?.sandboxRecreate).toBeNull();
  });

  it("refuses to retire a journal whose replacement is not proven (#7734)", () => {
    const journal = open();

    expect(() => journal.completeAcceptedTarget()).toThrow(
      /cannot be retired before its replacement is proven/,
    );
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("planned");
  });
});

describe("rebuild replacement recovery backup", () => {
  const transactionId = "11111111-1111-4111-8111-111111111111";
  const otherTransactionId = "22222222-2222-4222-8222-222222222222";
  let backupPath: string;
  let manifest: RebuildManifest;

  const identity = (selectedTransactionId = transactionId) => ({
    sandboxName: "alpha",
    agentName: "openclaw",
    transactionId: selectedTransactionId,
  });
  const recordedIdentity = (selectedTransactionId = transactionId) => ({
    ...identity(selectedTransactionId),
    gatewayName: "nemoclaw-18080",
    gatewayPort: 18_080,
  });

  beforeEach(() => {
    backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-recovery-test-"));
    manifest = {
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-08-28T00-00-00-000Z",
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: [],
      dir: "/sandbox/.openclaw",
      backupPath,
      blueprintDigest: null,
    };
  });

  afterEach(() => {
    fs.rmSync(backupPath, { recursive: true, force: true });
  });

  const deps = () => ({
    listBackups: () => [{ ...manifest, snapshotVersion: 1 }],
    validateManifest: (_name: string, _agent: string | null | undefined, value: RebuildManifest) =>
      ({ ok: true, manifest: value }) as const,
  });

  const prepareUnsafeRecovery = () => {
    const policy = [
      "version: 1",
      "process:",
      "  environment:",
      "    SERVICE_API_KEY: opaque-retained-credential",
      "",
    ].join("\n");
    const sha256 = createHash("sha256").update(policy).digest("hex");
    const file = `rebuild-policy-handoff.${sha256}.yaml`;
    fs.writeFileSync(path.join(backupPath, file), policy, { mode: 0o600 });
    manifest = { ...manifest, rebuildPolicyHandoff: { file, sha256 } };
    recordRebuildRecoveryBackup({ ...recordedIdentity(), backupManifest: manifest }, deps());
    return {
      handoffPath: path.join(backupPath, file),
      recordPath: path.join(backupPath, ".nemoclaw-rebuild-recovery.json"),
    };
  };

  const corruptRecoveryRecord = {
    "malformed JSON": (recordPath: string) => fs.writeFileSync(recordPath, "{", "utf8"),
    "invalid schema": (recordPath: string) =>
      fs.writeFileSync(recordPath, '{"schemaVersion":99}\n', "utf8"),
    "invalid permissions": (recordPath: string) => fs.chmodSync(recordPath, 0o644),
    "invalid ownership": () => {
      const currentUid = process.getuid?.();
      expect(currentUid).toBeTypeOf("number");
      vi.spyOn(process, "getuid").mockReturnValue(Number(currentUid) + 1);
    },
  } satisfies Record<string, (recordPath: string) => void>;

  it("binds, resolves, and clears one transaction backup", () => {
    recordRebuildRecoveryBackup({ ...recordedIdentity(), backupManifest: manifest }, deps());

    const recordPath = path.join(backupPath, ".nemoclaw-rebuild-recovery.json");
    expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(findRebuildRecoveryBackup(identity(), deps())).toEqual(
      expect.objectContaining({ backupPath, timestamp: manifest.timestamp }),
    );
    expect(
      isRebuildRecoveryCleanupOnly({ ...identity(), backupManifest: manifest }, deps()),
    ).toBe(false);

    markRebuildRecoveryCleanupOnly({ ...identity(), backupManifest: manifest }, deps());
    expect(
      isRebuildRecoveryCleanupOnly({ ...identity(), backupManifest: manifest }, deps()),
    ).toBe(true);

    clearRebuildRecoveryBackup({ ...identity(), backupManifest: manifest }, deps());
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it("rejects another transaction and preserves the original binding", () => {
    recordRebuildRecoveryBackup({ ...recordedIdentity(), backupManifest: manifest }, deps());

    expect(() =>
      recordRebuildRecoveryBackup(
        { ...recordedIdentity(otherTransactionId), backupManifest: manifest },
        deps(),
      ),
    ).toThrow("already belongs to another transaction");
    expect(findRebuildRecoveryBackup(identity(), deps())).not.toBeNull();
    expect(findRebuildRecoveryBackup(identity(otherTransactionId), deps())).toBeNull();
  });

  it("binds and retires a legacy unsafe handoff with no active journal (#10150)", () => {
    const { handoffPath, recordPath } = prepareUnsafeRecovery();
    const observePresence = vi.fn(() => "missing" as const);

    expect(() =>
      retireRebuildRecoveryBackup(
        {
          sandboxName: "alpha",
          transactionId: otherTransactionId,
          confirmDataRecovered: true,
        },
        { ...deps(), observePresence },
      ),
    ).toThrow("No exact rebuild recovery record");
    expect(() =>
      retireRebuildRecoveryBackup(
        { sandboxName: "beta", transactionId, confirmDataRecovered: true },
        { ...deps(), observePresence },
      ),
    ).toThrow("does not match sandbox 'beta'");
    expect(() =>
      retireRebuildRecoveryBackup(
        { sandboxName: "alpha", transactionId, confirmDataRecovered: false },
        { ...deps(), observePresence },
      ),
    ).toThrow("requires --yes");
    expect(() =>
      retireRebuildRecoveryBackup(
        { sandboxName: "alpha", transactionId, confirmDataRecovered: true },
        { ...deps(), observePresence: () => "present" },
      ),
    ).toThrow(`Recovery remains at '${backupPath}'`);
    expect(() =>
      retireRebuildRecoveryBackup(
        { sandboxName: "alpha", transactionId, confirmDataRecovered: true },
        { ...deps(), observePresence, clearPolicyHandoff: () => false },
      ),
    ).toThrow(`Recovery remains at '${backupPath}'`);
    expect(fs.existsSync(handoffPath)).toBe(true);
    expect(fs.existsSync(recordPath)).toBe(true);

    expect(
      retireRebuildRecoveryBackup(
        { sandboxName: "alpha", transactionId, confirmDataRecovered: true },
        { ...deps(), observePresence },
      ),
    ).toEqual({
      backupPath,
      gatewayName: "nemoclaw-18080",
      transactionId,
    });
    expect(observePresence).toHaveBeenCalledWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw-18080",
    });
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(fs.existsSync(recordPath)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(backupPath, "rebuild-manifest.json"), "utf8")),
    ).not.toHaveProperty("rebuildPolicyHandoff");
  });

  it.each(Object.entries(corruptRecoveryRecord))(
    "reports and preserves the exact unsafe backup when its recovery marker has %s",
    (_condition, corrupt) => {
      const { handoffPath, recordPath } = prepareUnsafeRecovery();
      corrupt(recordPath);
      const observePresence = vi.fn(() => "missing" as const);
      const clearPolicyHandoff = vi.fn(() => true);

      expect(() =>
        retireRebuildRecoveryBackup(
          { sandboxName: "alpha", transactionId, confirmDataRecovered: true },
          { ...deps(), observePresence, clearPolicyHandoff },
        ),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(`Recovery remains at '${backupPath}'`),
        }),
      );

      expect(() =>
        retireRebuildRecoveryBackup(
          { sandboxName: "alpha", transactionId, confirmDataRecovered: true },
          { ...deps(), observePresence, clearPolicyHandoff },
        ),
      ).toThrow(/Do not edit or remove the marker or retained policy handoff/);
      expect(fs.existsSync(handoffPath)).toBe(true);
      expect(fs.existsSync(recordPath)).toBe(true);
      expect(observePresence).not.toHaveBeenCalled();
      expect(clearPolicyHandoff).not.toHaveBeenCalled();
    },
  );
});
