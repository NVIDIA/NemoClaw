// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

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
import * as processRecovery from "./process-recovery";

describe("policy channel remove/enable flows", () => {
  let exitSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n",
      stderr: "",
    });
    vi.spyOn(processRecovery, "executeSandboxCommand").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function arrangeHermesWhatsappRemoval() {
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
      configuredChannels: ["whatsapp"],
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
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["whatsapp"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation(
      ((args: string[]) =>
        args.includes("cat") ? { status: 1, stderr: "missing" } : { status: 0 }) as never,
    );
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["whatsapp"]);
    vi.spyOn(policies, "listPresets").mockReturnValue([{ name: "whatsapp" } as never]);
    const removePreset = vi.spyOn(policies, "removePreset").mockReturnValue(true);
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

  async function removeWhatsappNonInteractive() {
    const previousNonInteractive = process.env.NEMOCLAW_NON_INTERACTIVE;
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    try {
      await removeSandboxChannel("alpha", { channel: "whatsapp" });
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

  it("clears Hermes WhatsApp default, profile, and legacy sessions before removal", async () => {
    const { updateSandbox } = await arrangeHermesWhatsappRemoval();

    await expect(removeWhatsappNonInteractive()).resolves.toBeUndefined();

    const clearCommand = String(
      vi.mocked(processRecovery.executeSandboxExecCommand).mock.calls[0]?.[1] ?? "",
    );
    expect(clearCommand).toContain("rm -rf --");
    expect(clearCommand).toContain("/sandbox/.hermes/platforms/whatsapp");
    expect(clearCommand).toContain(
      "/sandbox/.hermes/profiles/dashboard-home/platforms/whatsapp/session",
    );
    expect(clearCommand).toContain("/sandbox/.hermes/dashboard-home/platforms/whatsapp/session");
    expect(updateSandbox).toHaveBeenCalled();
    expect(
      vi.mocked(processRecovery.executeSandboxExecCommand).mock.invocationCallOrder[0],
    ).toBeLessThan(updateSandbox.mock.invocationCallOrder[0]);
  });

  it.each([
    { scenario: "exec transport", execStatus: 0, usesSsh: false },
    { scenario: "SSH fallback", execStatus: 1, usesSsh: true },
  ])(
    "clears every Hermes WhatsApp session path through $scenario",
    async ({ execStatus, usesSsh }) => {
      const { updateSandbox } = await arrangeHermesWhatsappRemoval();
      vi.mocked(processRecovery.executeSandboxExecCommand).mockReturnValue({
        status: execStatus,
        stdout: execStatus === 0 ? "NEMOCLAW_CHANNEL_CLEAR_OK\n" : "",
        stderr: execStatus === 0 ? "" : "exec unavailable",
      });
      vi.mocked(processRecovery.executeSandboxCommand).mockReturnValue({
        status: 0,
        stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n",
        stderr: "",
      });

      await expect(removeWhatsappNonInteractive()).resolves.toBeUndefined();

      const transport = usesSsh
        ? vi.mocked(processRecovery.executeSandboxCommand)
        : vi.mocked(processRecovery.executeSandboxExecCommand);
      expectHermesSessionCleanup(transport.mock.calls[0]?.[1]);
      const sshCleanupCommands = vi
        .mocked(processRecovery.executeSandboxCommand)
        .mock.calls.filter(([, command]) =>
          String(command).includes("/sandbox/.hermes/platforms/whatsapp"),
        );
      expect(sshCleanupCommands).toHaveLength(usesSsh ? 1 : 0);

      expect(updateSandbox).toHaveBeenCalled();
      expect(transport.mock.invocationCallOrder[0]).toBeLessThan(
        updateSandbox.mock.invocationCallOrder[0],
      );
    },
  );

  it("keeps channel state unchanged when both Hermes cleanup transports fail", async () => {
    const { rebuildSandbox, removePreset, updateSandbox } = await arrangeHermesWhatsappRemoval();
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");
    vi.mocked(processRecovery.executeSandboxExecCommand).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "exec unavailable",
    });
    vi.mocked(processRecovery.executeSandboxCommand).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "ssh unavailable",
    });

    await expect(removeWhatsappNonInteractive()).rejects.toThrow("process.exit(1)");

    expectHermesSessionCleanup(
      vi.mocked(processRecovery.executeSandboxExecCommand).mock.calls[0]?.[1],
    );
    expectHermesSessionCleanup(vi.mocked(processRecovery.executeSandboxCommand).mock.calls[0]?.[1]);

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(removePreset).not.toHaveBeenCalled();
    expect(rebuildSandbox).not.toHaveBeenCalled();
  });

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
    vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("absent");
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
    vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("match");

    await expect(
      startSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    const joined = logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(joined).not.toContain("Effective egress that would be opened:");
    expect(joined).toContain("is already effective; no new egress would be opened.");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
