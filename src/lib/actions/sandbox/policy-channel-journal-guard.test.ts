// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as runtime from "../../adapters/openshell/runtime";
import * as defs from "../../agent/defs";
import * as store from "../../credentials/store";
import * as gatewayRuntime from "../../gateway-runtime-action";
import { MessagingSetupApplier, MessagingWorkflowPlanner } from "../../messaging";
import * as policies from "../../policy";
import * as onboardSession from "../../state/onboard-session";
import type {
  BaselineExclusionTransition,
  CustomPolicyTransition,
  SandboxEntry,
} from "../../state/registry";
import * as registry from "../../state/registry";
import { addSandboxChannel, removeSandboxChannel, startSandboxChannel } from "./policy-channel";
import { policyChannelDependencies } from "./policy-channel-dependencies";
import * as processRecovery from "./process-recovery";

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const customTransition: CustomPolicyTransition = {
  version: 1,
  id: "123e4567-e89b-42d3-a456-426614174000",
  operation: "apply",
  name: "private-api",
  previous: null,
  desired: {
    name: "private-api",
    content: "network_policies:\n  private_api: {}\n",
    appliedAt: "2026-08-06T12:00:00.000Z",
  },
  startedAt: "2026-08-06T12:00:00.000Z",
};

const baselineTransition: BaselineExclusionTransition = {
  id: "123e4567-e89b-42d3-a456-426614174001",
  operation: "exclude",
  exclusion: {
    version: 1,
    agent: "openclaw",
    key: "baseline_api",
    digest: "a".repeat(64),
    acknowledgedAt: "2026-08-06T12:00:00.000Z",
  },
  targetLiveDigest: null,
  startedAt: "2026-08-06T12:00:00.000Z",
};

const lifecycleGuardCases = [
  {
    label: "custom policy",
    transition: { customPolicyTransition: customTransition },
    expectedGuidance: "policy add with --from-file or --from-dir",
    shieldsError: null,
  },
  {
    label: "baseline policy",
    transition: { baselineExclusionTransition: baselineTransition },
    expectedGuidance: "nemoclaw alpha policy exclude baseline_api",
    shieldsError: null,
  },
  {
    label: "active Shields window",
    transition: {},
    expectedGuidance: "shields up",
    shieldsError:
      "Cannot change policy for 'alpha' while Shields are down. Run `nemoclaw alpha shields up` before retrying.",
  },
] as const;

describe.each(lifecycleGuardCases)("channel lifecycle guard for $label", ({
  transition,
  expectedGuidance,
  shieldsError,
}) => {
  let errorSpy: MockInstance;
  let exitSpy: MockInstance;
  let sandbox: SandboxEntry;
  let updateSandboxSpy: MockInstance;
  let getCredentialSpy: MockInstance;
  let saveCredentialSpy: MockInstance;
  let deleteCredentialSpy: MockInstance;
  let runOpenshellSpy: MockInstance;
  let recoverGatewaySpy: MockInstance;
  let applyPresetSpy: MockInstance;
  let removePresetSpy: MockInstance;
  let buildAddPlanSpy: MockInstance;
  let writePlanSpy: MockInstance;
  let providerSpy: MockInstance;
  let rebuildSpy: MockInstance;
  let stopTunnelSpy: MockInstance;
  let execSpy: MockInstance;
  let sshSpy: MockInstance;

  beforeEach(() => {
    sandbox = {
      name: "alpha",
      agent: "openclaw",
      policies: ["telegram", "googlechat", "whatsapp"],
      ...transition,
    } as SandboxEntry;

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitError(code);
    }) as never);

    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "openclaw",
    } as defs.AgentDefinition);
    vi.spyOn(registry, "getSandbox").mockImplementation(() => sandbox);
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue([
      "telegram",
      "googlechat",
      "whatsapp",
    ]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue(["telegram"]);
    updateSandboxSpy = vi.spyOn(registry, "updateSandbox");

    vi.spyOn(policies, "loadPresetForSandbox").mockReturnValue(
      "network_policies:\n  stub:\n    egress:\n      - host: example.com\n",
    );
    vi.spyOn(policies, "parsePresetPolicyKeys").mockReturnValue(["stub"]);
    vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("absent");
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["telegram", "googlechat", "whatsapp"]);
    vi.spyOn(policies, "listPresets").mockReturnValue([]);
    const shieldsGuard = vi.spyOn(policies, "assertInternalShieldsPolicyMutationAllowed");
    if (shieldsError) {
      shieldsGuard.mockImplementation(() => {
        throw new Error(shieldsError);
      });
    }
    applyPresetSpy = vi.spyOn(policies, "applyPreset");
    removePresetSpy = vi.spyOn(policies, "removePreset");

    getCredentialSpy = vi.spyOn(store, "getCredential");
    saveCredentialSpy = vi.spyOn(store, "saveCredential");
    deleteCredentialSpy = vi.spyOn(store, "deleteCredential");
    vi.spyOn(store, "prompt").mockResolvedValue("");
    vi.spyOn(onboardSession, "loadSession");
    vi.spyOn(onboardSession, "updateSession");

    buildAddPlanSpy = vi.spyOn(
      MessagingWorkflowPlanner.prototype,
      "buildChannelAddPlanFromSandboxEntry",
    );
    writePlanSpy = vi.spyOn(MessagingSetupApplier, "writePlanToEnv");
    providerSpy = vi.spyOn(policyChannelDependencies, "upsertMessagingProviders");
    rebuildSpy = vi.spyOn(policyChannelDependencies, "rebuildSandbox");
    stopTunnelSpy = vi.spyOn(policyChannelDependencies, "stopGooglechatWebhookTunnel");
    vi.spyOn(policyChannelDependencies, "googlechatTunnelRuntime");
    runOpenshellSpy = vi.spyOn(runtime, "runOpenshell");
    recoverGatewaySpy = vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime");
    execSpy = vi.spyOn(processRecovery, "executeSandboxExecCommand");
    sshSpy = vi.spyOn(processRecovery, "executeSandboxCommand");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function expectBlockedWithoutMutation(action: () => Promise<void>): Promise<void> {
    const before = structuredClone(sandbox);

    await expect(action()).rejects.toMatchObject({ code: 1 });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().map(String).join("\n")).toContain(expectedGuidance);
    expect(sandbox).toEqual(before);
    expect(buildAddPlanSpy).not.toHaveBeenCalled();
    expect(writePlanSpy).not.toHaveBeenCalled();
    expect(getCredentialSpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy).not.toHaveBeenCalled();
    expect(deleteCredentialSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(removePresetSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(recoverGatewaySpy).not.toHaveBeenCalled();
    expect(runOpenshellSpy).not.toHaveBeenCalled();
    expect(stopTunnelSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
    expect(sshSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
  }

  it("blocks add before credential, provider, policy, plan, or registry mutation (#8176)", async () => {
    await expectBlockedWithoutMutation(() => addSandboxChannel("alpha", { channel: "telegram" }));
  });

  it("blocks remove before a public tunnel or durable channel mutation (#8176)", async () => {
    await expectBlockedWithoutMutation(() =>
      removeSandboxChannel("alpha", { channel: "googlechat" }),
    );
  });

  it("blocks remove before in-sandbox QR state or durable channel mutation (#8176)", async () => {
    await expectBlockedWithoutMutation(() =>
      removeSandboxChannel("alpha", { channel: "whatsapp" }),
    );
  });

  it("blocks start before plan, policy, registry, or rebuild mutation (#8176)", async () => {
    await expectBlockedWithoutMutation(() => startSandboxChannel("alpha", { channel: "telegram" }));
  });
});
