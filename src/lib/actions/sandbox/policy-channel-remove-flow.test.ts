// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as defs from "../../agent/defs";
import * as credentials from "../../credentials/store";
import * as gatewayRuntimeAction from "../../gateway-runtime-action";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInMessagingHookRegistry,
  createBuiltInRenderTemplateResolver,
  MessagingWorkflowPlanner,
} from "../../messaging";
import * as policies from "../../policy";
import * as runner from "../../runner";
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
    vi.spyOn(policyChannelDependencies, "preflightSandboxPolicyAuthority").mockReturnValue(
      "nemoclaw-managed",
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "NEMOCLAW_CHANNEL_CLEAR_OK\n",
      stderr: "",
    });
    vi.spyOn(processRecovery, "executeSandboxCommand").mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      policies: ["whatsapp"],
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
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["whatsapp"]);
    vi.spyOn(policies, "listPresets").mockReturnValue([{ name: "whatsapp" } as never]);
    const removePreset = vi.spyOn(policies, "removePreset").mockReturnValue(true);
    const rebuildSandbox = vi
      .spyOn(policyChannelDependencies, "rebuildSandbox")
      .mockResolvedValue(undefined);
    return { rebuildSandbox, removePreset, updateSandbox };
  }

  async function arrangeOpenClawSlackRemoval() {
    const plan = await new MessagingWorkflowPlanner(
      createBuiltInChannelManifestRegistry(),
      createBuiltInMessagingHookRegistry(),
      createBuiltInRenderTemplateResolver(),
    ).buildPlan({
      sandboxName: "alpha",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["slack"],
      credentialAvailability: {
        SLACK_APP_TOKEN: true,
        SLACK_BOT_TOKEN: true,
      },
    });
    const current = {
      name: "alpha",
      agent: "openclaw",
      policyAuthority: "externally-managed",
      messaging: { schemaVersion: 1, plan },
    } as SandboxEntry;
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      configPaths: { dir: "/sandbox/.openclaw" },
      stateDirs: [],
    } as unknown as defs.AgentDefinition);
    vi.spyOn(registry, "getSandbox").mockReturnValue(current);
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["slack"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["slack"]);
    vi.spyOn(policies, "listPresets").mockReturnValue([{ name: "slack" } as never]);
    const removePreset = vi.spyOn(policies, "removePreset").mockImplementation(() => {
      throw new PolicyAuthorityRefusalError("Slack policy is externally managed");
    });
    vi.spyOn(gatewayRuntimeAction, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: true,
      before: { state: "healthy_named" },
      after: { state: "healthy_named" },
      attempted: false,
    } as never);
    const commands: string[][] = [];
    const runOpenshell = vi
      .spyOn(policyChannelDependencies, "runOpenshell")
      .mockImplementation((args) => {
        commands.push([...args]);
        return { status: 0, stdout: "", stderr: "" } as never;
      });
    return { commands, removePreset, runOpenshell, updateSandbox };
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

  it("does not report tokenless removal before the messaging plan is persisted (#9833)", async () => {
    const { updateSandbox } = await arrangeHermesWhatsappRemoval();
    updateSandbox.mockReturnValue(false);

    await expect(removeWhatsappNonInteractive()).rejects.toThrow("process.exit(1)");

    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("Removed whatsapp channel.");
  });

  it("continues owned channel cleanup when external policy removal refuses (#9833)", async () => {
    const { commands, removePreset, runOpenshell, updateSandbox } =
      await arrangeOpenClawSlackRemoval();
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-host-only");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-host-only");
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");

    await expect(removeSandboxChannel("alpha", { channel: "slack" })).resolves.toBeUndefined();

    expect(credentials.getCredential("SLACK_BOT_TOKEN")).toBeNull();
    expect(credentials.getCredential("SLACK_APP_TOKEN")).toBeNull();
    expect(
      commands.filter(
        (args) => args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach",
      ),
    ).toHaveLength(2);
    expect(commands.filter((args) => args[0] === "provider" && args[1] === "delete")).toHaveLength(
      2,
    );
    const firstDetach = commands.findIndex(
      (args) => args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach",
    );
    expect(firstDetach).toBeGreaterThanOrEqual(0);
    expect(runOpenshell.mock.invocationCallOrder[firstDetach]).toBeLessThan(
      removePreset.mock.invocationCallOrder[0],
    );
    expect(removePreset).toHaveBeenCalledWith("alpha", "slack");
    expect(updateSandbox).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("stops an owned Google Chat tunnel when external policy removal refuses (#9833)", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      configPaths: { dir: "/sandbox/.openclaw" },
      stateDirs: [],
    } as unknown as defs.AgentDefinition);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      policyAuthority: "externally-managed",
    });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue([]);
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["googlechat"]);
    vi.spyOn(policies, "listPresets").mockReturnValue([{ name: "googlechat" } as never]);
    const removePreset = vi.spyOn(policies, "removePreset").mockImplementation(() => {
      throw new PolicyAuthorityRefusalError("Google Chat policy is externally managed");
    });
    vi.spyOn(gatewayRuntimeAction, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: true,
      before: { state: "healthy_named" },
      after: { state: "healthy_named" },
      attempted: false,
    } as never);
    vi.spyOn(policyChannelDependencies, "runOpenshell").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as never);
    const stopTunnel = vi
      .spyOn(policyChannelDependencies, "stopGooglechatWebhookTunnel")
      .mockImplementation(() => undefined);
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");

    await expect(removeSandboxChannel("alpha", { channel: "googlechat" })).resolves.toBeUndefined();

    expect(stopTunnel).toHaveBeenCalledWith("alpha");
    expect(removePreset).toHaveBeenCalledWith("alpha", "googlechat");
    expect(stopTunnel.mock.invocationCallOrder[0]).toBeLessThan(
      removePreset.mock.invocationCallOrder[0],
    );
    expect(exitSpy).not.toHaveBeenCalled();
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
    vi.spyOn(runner, "runCapture").mockReturnValue("version: 1\nnetwork_policies: {}\n");
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
    const liveTelegramPolicy = [
      "version: 1",
      "network_policies:",
      "  telegram_bot:",
      "    name: telegram_bot",
      "    endpoints:",
      "      - host: api.telegram.org",
      "        port: 443",
      "        protocol: rest",
      "        enforcement: enforce",
      // An already-matching live policy carries the materialized provider.
      "        credential_binding:",
      "          provider: alpha-telegram-bridge",
      "        rules:",
      "          - allow: { method: GET, path: '/bot*/**' }",
      "          - allow: { method: POST, path: '/bot*/**' }",
      "          - allow: { method: GET, path: '/file/bot*/**' }",
      "    binaries:",
      "      - { path: /usr/local/bin/node }",
      "      - { path: /usr/bin/node }",
      "",
    ].join("\n");
    vi.spyOn(runner, "runCapture").mockReturnValue(liveTelegramPolicy);

    await expect(
      startSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    const joined = logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(joined).not.toContain("Effective egress that would be opened:");
    expect(joined).toContain("is already effective; no new egress would be opened.");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
