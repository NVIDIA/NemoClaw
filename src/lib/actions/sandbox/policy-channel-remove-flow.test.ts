// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as channels from "../../sandbox/channels";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as defs from "../../agent/defs";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInMessagingHookRegistry,
  createBuiltInRenderTemplateResolver,
  MessagingWorkflowPlanner,
} from "../../messaging";
import * as policies from "../../policy";
import type { SandboxEntry } from "../../state/registry/types";
import * as registry from "../../state/registry";
import { removeSandboxChannel, startSandboxChannel, stopSandboxChannel } from "./policy-channel";
import { policyChannelDependencies } from "./policy-channel-dependencies";
import * as commandTransport from "../../adapters/sandbox/command-transport";

describe("policy channel remove/enable flows", () => {
  let exitSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(commandTransport, "executeSandboxExecCommand").mockResolvedValue({
      status: 0,
      stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n",
      stderr: "",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function arrangeHermesChannelRemoval(channel = "whatsapp") {
    const plan = await new MessagingWorkflowPlanner(
      createBuiltInChannelManifestRegistry(),
      // WhatsApp declares an enroll hook for its reply mode, so the planner
      // needs the built-in handlers. This plan is non-interactive, so the hook
      // records the manifest default without asking anything.
      createBuiltInMessagingHookRegistry(),
      createBuiltInRenderTemplateResolver(),
    ).buildPlan({
      sandboxName: "alpha",
      agent: "hermes",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: [channel],
    });
    const current = {
      name: "alpha",
      agent: "hermes",
      messaging: {
        schemaVersion: 1,
        plan,
      },
    } as SandboxEntry;
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "hermes",
      displayName: "Hermes",
      configPaths: { dir: "/sandbox/.hermes" },
      stateDirs: ["platforms", "profiles", "dashboard-home"],
    } as unknown as defs.AgentDefinition);
    vi.spyOn(registry, "getSandbox").mockReturnValue(current);
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue([channel]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation(((args: string[]) =>
      args.includes("cat") ? { status: 1, stderr: "missing" } : { status: 0 }) as never);
    vi.spyOn(policies, "getAppliedPresets").mockResolvedValue([channel]);
    vi.spyOn(policies, "listPresets").mockReturnValue([{ name: channel } as never]);
    const removePreset = vi.spyOn(policies, "removePreset").mockResolvedValue(true);
    const rebuildSandbox = vi
      .spyOn(policyChannelDependencies, "rebuildSandbox")
      .mockResolvedValue(undefined);
    return { rebuildSandbox, removePreset, updateSandbox };
  }

  function expectHermesSessionCleanup(command: unknown) {
    expect(String(command)).toContain("/sandbox/.hermes/platforms/whatsapp");
    expect(String(command)).toContain(
      "/sandbox/.hermes/profiles/dashboard-home/platforms/whatsapp/session",
    );
    expect(String(command)).toContain("/sandbox/.hermes/dashboard-home/platforms/whatsapp/session");
  }

  async function removeChannelNonInteractive(channel = "whatsapp") {
    const previousNonInteractive = process.env.NEMOCLAW_NON_INTERACTIVE;
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    try {
      await removeSandboxChannel("alpha", { channel });
    } finally {
      Reflect.deleteProperty(process.env, "NEMOCLAW_NON_INTERACTIVE");
      Object.assign(
        process.env,
        previousNonInteractive === undefined
          ? {}
          : { NEMOCLAW_NON_INTERACTIVE: previousNonInteractive },
      );
    }
  }

  it.each([
    {
      label: "failed command",
      outcome: () => Promise.resolve({ status: 1, stdout: "", stderr: "cleanup denied" }),
    },
    {
      label: "missing confirmation",
      outcome: () => Promise.resolve({ status: 0, stdout: "", stderr: "" }),
    },
    {
      label: "confirmation with failure",
      outcome: () =>
        Promise.resolve({
          status: 1,
          stdout: "NEMOCLAW_CHANNEL_CLEAR_OK",
          stderr: "cleanup failed",
        }),
    },
    {
      label: "unavailable transport",
      outcome: () => Promise.reject(new SandboxCommandTransportError("unavailable")),
    },
    {
      label: "malformed transport",
      outcome: () => Promise.reject(new SandboxCommandTransportError("malformed")),
    },
  ])("retains orphaned WeChat state after $label", async ({ outcome }) => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      configPaths: { dir: "/sandbox/.openclaw" },
      stateDirs: ["wechat", "openclaw-weixin"],
    } as unknown as defs.AgentDefinition);
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: "openclaw" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue([]);
    vi.spyOn(policies, "getAppliedPresets").mockResolvedValue([]);
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    const removePreset = vi.spyOn(policies, "removePreset").mockResolvedValue(true);
    const rebuildSandbox = vi
      .spyOn(policyChannelDependencies, "rebuildSandbox")
      .mockResolvedValue(undefined);
    const stoppedCleanup = vi
      .spyOn(policyChannelDependencies, "clearStoppedSandboxStateRoots")
      .mockReturnValue({ cleared: false, failure: "provider-cleanup-unavailable" });
    vi.mocked(commandTransport.executeSandboxExecCommand).mockImplementation(outcome);
    await expect(removeChannelNonInteractive("wechat")).rejects.toThrow("process.exit(1)");
    expect(stoppedCleanup).toHaveBeenCalledOnce();
    expect(commandTransport.executeSandboxExecCommand).toHaveBeenCalledOnce();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(removePreset).not.toHaveBeenCalled();
    expect(rebuildSandbox).not.toHaveBeenCalled();
  });

  it("reports remove usage and exits before touching channel state when no channel is supplied", async () => {
    await expect(removeSandboxChannel("alpha", {})).rejects.toThrow("process.exit(1)");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("supports a remove dry run without gateway, registry, or rebuild side effects", async () => {
    await expect(
      removeSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "--dry-run: would remove channel 'telegram' for 'alpha'.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not clean manifest state for an unsupported sandbox agent", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "custom-agent",
      configPaths: { dir: "/sandbox/.custom-agent" },
      stateDirs: ["wechat"],
    } as unknown as defs.AgentDefinition);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "custom-agent",
      policies: ["wechat"],
      messaging: { schemaVersion: 1, plan: { channels: [] } as never },
    } as SandboxEntry);
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["wechat"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);
    vi.spyOn(policies, "getAppliedPresets").mockResolvedValue(["wechat"]);

    await expect(removeSandboxChannel("alpha", { channel: "wechat" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(commandTransport.executeSandboxExecCommand).not.toHaveBeenCalled();
  });

  it("clears Hermes WhatsApp default, profile, and legacy sessions before removal", async () => {
    const { updateSandbox } = await arrangeHermesChannelRemoval();

    await expect(removeChannelNonInteractive()).resolves.toBeUndefined();

    const clearCommand = String(
      vi.mocked(commandTransport.executeSandboxExecCommand).mock.calls[0]?.[1] ?? "",
    );
    expect(clearCommand).toContain("rm -rf --");
    expect(clearCommand).toContain("/sandbox/.hermes/platforms/whatsapp");
    expect(clearCommand).toContain(
      "/sandbox/.hermes/profiles/dashboard-home/platforms/whatsapp/session",
    );
    expect(clearCommand).toContain("/sandbox/.hermes/dashboard-home/platforms/whatsapp/session");
    expect(commandTransport.executeSandboxExecCommand).toHaveBeenCalledTimes(1);
    expect(updateSandbox).toHaveBeenCalled();
    expect(
      vi.mocked(commandTransport.executeSandboxExecCommand).mock.invocationCallOrder[0],
    ).toBeLessThan(updateSandbox.mock.invocationCallOrder[0]);
  });

  it.each(["cancelled", "timeout", "malformed", "unavailable", "capture", "invocation"] as const)(
    "keeps channel state unchanged after %s without another transport",
    async (kind) => {
      const { rebuildSandbox, removePreset, updateSandbox } = await arrangeHermesChannelRemoval();
      const error = new SandboxCommandTransportError(kind);
      vi.mocked(commandTransport.executeSandboxExecCommand).mockRejectedValue(error);
      await expect(removeChannelNonInteractive()).rejects.toThrow("process.exit(1)");
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(error.message));
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Restore sandbox lifecycle access"),
      );
      expect(commandTransport.executeSandboxExecCommand).toHaveBeenCalledOnce();
      expect(updateSandbox).not.toHaveBeenCalled();
      expect(removePreset).not.toHaveBeenCalled();
      expect(rebuildSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(["cancelled", "timeout", "malformed", "unavailable", "capture", "invocation"] as const)(
    "keeps the token-channel rebuild path after %s cleanup failure",
    async (kind) => {
      const { updateSandbox, removePreset } = await arrangeHermesChannelRemoval("telegram");
      vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
        recovered: true,
      } as never);
      const clearTokens = vi
        .spyOn(channels, "clearChannelTokens")
        .mockImplementation(() => undefined);
      const cleanup = vi
        .spyOn(policyChannelDependencies, "cleanupMessagingProviders")
        .mockResolvedValue({
          removedProviderNames: [],
          absentProviderNames: [],
          detachedAttachments: [],
          residualProviders: [],
        });
      const error = new SandboxCommandTransportError(kind);
      vi.mocked(commandTransport.executeSandboxExecCommand).mockImplementation(
        async (_name, command) =>
          command.includes("rm -rf --")
            ? Promise.reject(error)
            : { status: 0, stdout: "NEMOCLAW_CHANNEL_CLEAR_OK", stderr: "" },
      );
      await expect(removeChannelNonInteractive("telegram")).resolves.toBeUndefined();
      expect(updateSandbox).toHaveBeenCalled();
      expect(removePreset).toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalled();
      expect(clearTokens).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(error.message));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("rebuild' to apply (remove 'telegram')"),
      );
      expect(
        vi
          .mocked(commandTransport.executeSandboxExecCommand)
          .mock.calls.filter(([, command]) => command.includes("rm -rf --")),
      ).toHaveLength(1);
    },
  );

  it("propagates unexpected cleanup authority errors before changing channel state", async () => {
    const { updateSandbox } = await arrangeHermesChannelRemoval();
    const error = new Error("authority refused");
    vi.mocked(commandTransport.executeSandboxExecCommand).mockRejectedValue(error);
    await expect(removeChannelNonInteractive()).rejects.toBe(error);
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it.each(["", "NEMOCLAW_CHANNEL_CLEAR_OK"])(
    "keeps channel state unchanged after a remote failure with stdout %j",
    async (stdout) => {
      const { rebuildSandbox, removePreset, updateSandbox } = await arrangeHermesChannelRemoval();
      const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");
      vi.mocked(commandTransport.executeSandboxExecCommand).mockResolvedValue({
        status: 1,
        stdout,
        stderr: "exec unavailable",
      });

      await expect(removeChannelNonInteractive()).rejects.toThrow("process.exit(1)");

      expectHermesSessionCleanup(
        vi.mocked(commandTransport.executeSandboxExecCommand).mock.calls[0]?.[1],
      );
      expect(commandTransport.executeSandboxExecCommand).toHaveBeenCalledOnce();

      expect(runOpenshell).not.toHaveBeenCalled();
      expect(updateSandbox).not.toHaveBeenCalled();
      expect(removePreset).not.toHaveBeenCalled();
      expect(rebuildSandbox).not.toHaveBeenCalled();
    },
  );

  it("supports stop dry runs for configured Hermes channels", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: "hermes" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["teams"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);

    await expect(
      stopSandboxChannel("alpha", { channel: "teams", dryRun: true }),
    ).resolves.toBeUndefined();

    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "--dry-run: would stop channel 'teams' for 'alpha'.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("supports start dry runs without applying a preset or persisting the enabled plan, and discloses effective egress first (#7179)", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue(["telegram"]);
    const updateSandboxSpy = vi.spyOn(registry, "updateSandbox");
    const applyPresetSpy = vi.spyOn(policies, "applyPreset");
    const rebuildSpy = vi.spyOn(policyChannelDependencies, "rebuildSandbox");
    vi.spyOn(policies, "getPresetContentGatewayState").mockResolvedValue("absent");
    await expect(
      startSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    const lines = logSpy.mock.calls.map((call) => call.map(String).join(" "));
    const joined = lines.join("\n");
    expect(joined).toContain("Effective egress that would be opened:");
    expect(joined).toContain("- api.telegram.org:443 (protocol: rest, enforcement: enforce)");
    const scopeHeader = lines.findIndex((line) =>
      line.includes("Effective egress that would be opened:"),
    );
    const wouldStart = lines.findIndex((line) => line.includes("--dry-run: would start channel"));
    expect(scopeHeader).toBeGreaterThan(-1);
    expect(wouldStart).toBeGreaterThan(scopeHeader);
    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not claim new egress on a start dry run when the preset already matches the live policy (#7179)", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue(["telegram"]);
    vi.spyOn(policies, "getPresetContentGatewayState").mockResolvedValue("match");

    await expect(
      startSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    const joined = logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(joined).not.toContain("Effective egress that would be opened:");
    expect(joined).toContain("is already effective; no new egress would be opened.");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
