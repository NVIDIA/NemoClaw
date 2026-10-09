// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as providerAdapters from "../../adapters/openshell/provider-adapter-cli";
import * as runtime from "../../adapters/openshell/runtime";
import * as defs from "../../agent/defs";
import * as store from "../../credentials/store";
import * as gatewayRuntime from "../../gateway-runtime-action";
import { createBuiltInMessagingHookRegistry } from "../../messaging";
import * as policy from "../../policy";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import { addSandboxChannel } from "./policy-channel";
import { policyChannelDependencies } from "./policy-channel-dependencies";

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock: async (_name: string, operation: () => Promise<void>) => operation(),
}));

describe("channel add lifecycle identity", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
    vi.stubEnv("NEMOCLAW_SKIP_TELEGRAM_REACHABILITY", "1");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:AAH-test-telegram-token");
    vi.stubEnv("TELEGRAM_ALLOWED_IDS", "12345");
    vi.stubEnv("TELEGRAM_REQUIRE_MENTION", "true");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "openclaw" } as defs.AgentDefinition);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);
    vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [], defaultSandbox: null });
    vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(store, "getCredential").mockReturnValue(null);
    vi.spyOn(store, "saveCredential").mockImplementation(() => undefined);
    vi.spyOn(store, "prompt").mockResolvedValue("");
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
    vi.spyOn(policy, "loadPreset").mockReturnValue("network_policies:\n  telegram: {}\n");
    vi.spyOn(policy, "parsePresetPolicyKeys").mockReturnValue(["telegram"]);
    vi.spyOn(policy, "listPresets").mockReturnValue([]);
    vi.spyOn(policy, "getPresetContentGatewayState").mockResolvedValue("absent");
    vi.spyOn(policy, "logPresetScopeForState").mockImplementation(() => undefined);
    vi.spyOn(policy, "getAppliedPresets").mockResolvedValue([]);
    vi.spyOn(policy, "applyPreset").mockResolvedValue(true);
    vi.spyOn(policyChannelDependencies, "revalidateChannelProviderPolicy").mockResolvedValue();
    vi.spyOn(policyChannelDependencies, "rebuildSandbox").mockResolvedValue();
    vi.spyOn(
      policyChannelDependencies,
      "recoverMessagingProviderAttachmentIdentity",
    ).mockReturnValue(null);
    vi.spyOn(policyChannelDependencies, "inspectMessagingProviderAttachmentTarget").mockReturnValue(
      "different-live-identity",
    );
    const healthy = {
      state: "healthy_named",
      activeGateway: "nemoclaw",
      diagnostic: "",
      recoveryBlocked: false,
      unavailable: false,
    } as const;
    vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: true,
      before: healthy,
      after: healthy,
      attempted: false,
    });
    vi.spyOn(runtime, "runOpenshell").mockImplementation(() => {
      throw new Error("Unexpected OpenShell command");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    { identity: "missing", force: false },
    { identity: "missing", force: true },
    { identity: "conflicting", force: false },
    { identity: "conflicting", force: true },
  ])(
    "rejects $identity lifecycle identity with force=$force before changing providers",
    async ({ identity, force }) => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        ...(identity === "conflicting"
          ? {
              lifecycleGeneration: "generation",
              lifecycleLiveIdentityFingerprint: "recorded-identity",
            }
          : {}),
      });
      const adapter = providerAdapters.createCliOpenShellProviderAdapter({
        run: runtime.runOpenshell,
      });
      vi.spyOn(adapter, "getProvider").mockResolvedValue({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      });
      vi.spyOn(adapter, "importProviderProfile").mockReturnValue({ ok: true });
      vi.spyOn(adapter, "createProvider");
      vi.spyOn(adapter, "updateProvider");
      vi.spyOn(adapter, "attachProvider");
      vi.spyOn(adapter, "detachProvider");
      vi.spyOn(adapter, "deleteProvider");
      vi.spyOn(adapter, "configureProviderRefresh");
      vi.spyOn(providerAdapters, "createCliOpenShellProviderAdapter").mockReturnValue(adapter);

      await expect(
        addSandboxChannel(
          "alpha",
          { channel: "telegram", force },
          {
            preEnableHookRegistry: createBuiltInMessagingHookRegistry(),
          },
        ),
      ).rejects.toThrow("process.exit(1)");

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          identity === "missing"
            ? "incomplete lifecycle identity"
            : "changed before messaging provider attachment",
        ),
      );
      expect(adapter.getProvider).toHaveBeenCalled();
      expect(adapter.createProvider).not.toHaveBeenCalled();
      expect(adapter.updateProvider).not.toHaveBeenCalled();
      expect(adapter.attachProvider).not.toHaveBeenCalled();
      expect(adapter.detachProvider).not.toHaveBeenCalled();
      expect(adapter.deleteProvider).not.toHaveBeenCalled();
      expect(adapter.configureProviderRefresh).not.toHaveBeenCalled();
      expect(runtime.runOpenshell).not.toHaveBeenCalled();
      expect(registry.updateSandbox).not.toHaveBeenCalled();
      expect(store.saveCredential).not.toHaveBeenCalled();
      expect(policyChannelDependencies.rebuildSandbox).not.toHaveBeenCalled();
    },
  );
});
