// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentDefs from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import * as mutableConfigPerms from "../../sandbox/mutable-config-perms";
import * as registry from "../../state/registry";
import * as sandboxVersion from "../../sandbox/version";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import * as pairingSettlement from "../../onboard/machine/finalization-deps";
import * as launchReadiness from "./launch-readiness";
import * as portableReceipts from "../../onboard/experimental/portable-runtime-receipt-readiness";
import * as messagingHostForward from "./messaging-host-forward-lifecycle";
import * as restoreWindow from "./runtime/openclaw-lifecycle";
import * as rebuildHermesPostRestore from "./rebuild-hermes-post-restore";
import * as rebuildMcp from "./rebuild-mcp-phase";
import * as rebuildMessaging from "./rebuild-messaging-phase";
import { runRebuildPostRestorePhase } from "./rebuild-post-restore-phase";
import * as nativeCustom from "../../inference/native-custom";
import { buildNativeCustomProfile } from "../../inference/native-custom/profile";
import * as initialRoute from "../../onboard/openclaw/initial-inference-route";
import { patchOpenClawInferenceConfig } from "../inference-set";

describe("native custom rebuild restoration", () => {
  const runtimeKindByAgent = {
    openclaw: "gateway",
    hermes: "gateway",
    "langchain-deepagents-code": "terminal",
    pi: "terminal",
  } as const;
  let agentName: keyof typeof runtimeKindByAgent;
  let order: string[];

  beforeEach(() => {
    agentName = "openclaw";
    order = [];
    vi.spyOn(
      rebuildOnboardDependencies,
      "verifyRebuiltOpenClawCompatibleEndpoint",
    ).mockImplementation(async () => {
      order.push("inference-smoke");
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(agentRuntime, "getSessionAgent").mockImplementation(() =>
      agentName === "openclaw" ? null : ({ name: agentName } as never),
    );
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("test agent");
    vi.spyOn(agentDefs, "loadAgent").mockImplementation(
      () =>
        ({
          name: agentName,
          expectedVersion: null,
          runtime: { kind: runtimeKindByAgent[agentName] },
        }) as never,
    );
    vi.spyOn(restoreWindow, "beginUnregisteredOpenClawBackupQuiesce").mockImplementation(
      async (sandboxName, runtimeSelection) => {
        order.push("maintenance-begin");
        return {
          ok: true,
          window: {
            sandboxName,
            kind: "backup",
            ...(runtimeSelection ? { runtimeSelection } : {}),
          },
        };
      },
    );
    vi.spyOn(restoreWindow, "finishUnregisteredOpenClawPostRestoreDoctor").mockImplementation(
      async () => {
        order.push("native-start");
        return { ok: true };
      },
    );
    vi.spyOn(restoreWindow, "abortUnregisteredOpenClawPostRestoreDoctor").mockImplementation(
      async () => {
        order.push("doctor-abort");
        return { ok: true };
      },
    );
    vi.spyOn(rebuildMessaging, "reapplyMessagingManifestBeforeAgentStart").mockImplementation(
      async () => {
        order.push("messaging");
      },
    );
    vi.spyOn(rebuildMessaging, "finalizePendingMessagingRemovalsAfterRestore").mockImplementation(
      (plan) => plan,
    );
    vi.spyOn(mutableConfigPerms, "inspectMutableHermesConfigPerms").mockReturnValue({
      verified: true,
      errors: [],
    });
    vi.spyOn(rebuildMcp, "restoreMcpAfterRebuild").mockImplementation(async () => {
      order.push("mcp");
      return true;
    });
    vi.spyOn(rebuildHermesPostRestore, "restartHermesGatewayAfterStateRestore").mockImplementation(
      async (_sandboxName, targetAgentName) =>
        targetAgentName === "hermes" ? "restarted" : "not-applicable",
    );
    vi.spyOn(rebuildHermesPostRestore, "verifyHermesGatewayAfterStateRestore").mockImplementation(
      async (_sandboxName, targetAgentName) =>
        targetAgentName === "hermes" ? "healthy" : "not-applicable",
    );
    vi.spyOn(
      rebuildHermesPostRestore,
      "verifyHermesGatewayAfterStateRestoreForCronGate",
    ).mockResolvedValue({
      state: "healthy",
      replacementIdentity: { pid: 77, start_time: 903, drain_token: "restore-token" },
    });
    vi.spyOn(
      rebuildHermesPostRestore,
      "completeHermesCronRestoreAfterGatewayReplacement",
    ).mockReturnValue({ pid: 77, start_time: 903, drain_token: "restore-token" });
    vi.spyOn(
      rebuildHermesPostRestore,
      "isHermesCronRestoreDrainMarkerRollbackFailure",
    ).mockReturnValue(false);
    vi.spyOn(registry, "getSandbox").mockImplementation(
      () => ({ agent: agentName === "openclaw" ? null : agentName }) as never,
    );
    vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(portableReceipts, "classifyPortableLifecycleReceipt").mockReturnValue({
      kind: "absent",
    });
    vi.spyOn(pairingSettlement, "settleOrdinaryOpenClawPairing").mockResolvedValue({
      kind: "settled",
    });
    vi.spyOn(launchReadiness, "settlePortableOpenClawPairing").mockResolvedValue({
      kind: "not-portable",
    });
    vi.spyOn(sandboxVersion, "checkAgentVersion").mockResolvedValue({
      sandboxVersion: null,
      expectedVersion: null,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unavailable",
      unavailableReason: "no-expected-version",
    });
    vi.spyOn(messagingHostForward, "ensureMessagingHostForwardAfterRebuild").mockImplementation(
      async () => {
        order.push("host-forward");
        return true;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function input() {
    return {
      sandboxName: "alpha",
      targetAgentName: agentName,
      messagingPlan: null,
      backupManifest: null,
      mcpEntries: [],
      restoreSucceeded: true,
      failedPresets: [],
      finalBuiltinPresets: [],
      failedPresetRemovals: [],
      policyPresetReconciliationVerified: true,
      preparedBackupRecovery: false,
      versionCheck: { expectedVersion: null } as never,
      log: vi.fn(),
      bail: vi.fn() as never,
    };
  }

  function nativeCustomRestore() {
    const prepared = buildNativeCustomProfile({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      endpointUrl: "https://example.com/v1",
      api: "openai-completions",
      addresses: ["8.8.8.8"],
    });
    const attachment = nativeCustom.customAttachmentFromPrepared(
      { ...prepared, trustedPrivateEndpoint: false },
      {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "replacement-provider-id",
      },
    );
    vi.mocked(registry.getSandbox).mockReturnValue({
      agent: null,
      provider: "compatible-endpoint",
      model: "selected-model",
      preferredInferenceApi: "openai-completions",
      nativeCustomProviderAttachment: attachment,
    } as never);
    const verify = vi
      .spyOn(nativeCustom, "verifyNativeCustomProviderAttachment")
      .mockImplementation(async () => {
        order.push("attachment-verified");
        return attachment;
      });
    const config = {
      agents: { defaults: { model: { primary: "inference/selected-model" } } },
      models: {
        providers: {
          inference: {
            apiKey: "openshell:resolve:env:v1_COMPATIBLE_API_KEY",
            models: [{ id: "selected-model", contextWindow: 8192, maxTokens: 128 }],
          },
        },
      },
    };
    const resolveReference = vi.fn(async () => "openshell:resolve:env:v2_COMPATIBLE_API_KEY");
    const write = vi.fn(() => {
      order.push("route-written");
    });
    vi.spyOn(initialRoute, "writeRestoredOpenclawInferenceRoute").mockImplementation(
      initialRoute.createOpenclawInferenceRouteWriter({
        readOpenclawConfig: () => config,
        patchOpenclawInferenceConfig: patchOpenClawInferenceConfig,
        resolveNativeCustomCredentialReference: resolveReference,
        writeOpenclawInferenceConfigNatively: write,
      }),
    );
    return { attachment, verify, config, resolveReference, write };
  }

  it("replaces a restored credential reference before the native gateway starts (#12636)", async () => {
    const fixture = nativeCustomRestore();
    await runRebuildPostRestorePhase({
      ...input(),
      mcpRuntimeSelection: { gatewayName: "nemoclaw-9090" } as never,
    });
    expect(fixture.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        expected: fixture.attachment,
        target: { kind: "named", gatewayName: "nemoclaw-9090" },
      }),
    );
    expect(fixture.config.models.providers.inference.apiKey).toBe(
      "openshell:resolve:env:v2_COMPATIBLE_API_KEY",
    );
    expect(fixture.config.models.providers.inference.models[0]).toMatchObject({
      id: "selected-model",
      contextWindow: 8192,
      maxTokens: 128,
    });
    expect(fixture.resolveReference).toHaveBeenCalledWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw-9090",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    expect(order.indexOf("attachment-verified")).toBeLessThan(order.indexOf("route-written"));
    expect(order.indexOf("route-written")).toBeLessThan(order.indexOf("native-start"));
  });

  it.each(["verify", "resolveReference"] as const)(
    "keeps restoration offline when %s verification fails (#12636)",
    async (failure) => {
      const fixture = nativeCustomRestore();
      fixture[failure].mockRejectedValue(new Error("restored authority unavailable"));
      await expect(
        runRebuildPostRestorePhase({
          ...input(),
          mcpRuntimeSelection: { gatewayName: "nemoclaw-9090" } as never,
        }),
      ).rejects.toThrow();
      expect(fixture.write).not.toHaveBeenCalled();
      expect(restoreWindow.finishUnregisteredOpenClawPostRestoreDoctor).not.toHaveBeenCalled();
      expect(restoreWindow.abortUnregisteredOpenClawPostRestoreDoctor).toHaveBeenCalledOnce();
      expect(fixture.config.models.providers.inference.apiKey).toBe(
        "openshell:resolve:env:v1_COMPATIBLE_API_KEY",
      );
    },
  );
});
