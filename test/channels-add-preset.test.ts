// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { addSandboxChannel, removeSandboxChannel } from "../src/lib/actions/sandbox/policy-channel";
import { policyChannelDependencies } from "../src/lib/actions/sandbox/policy-channel-dependencies";
import * as processRecovery from "../src/lib/actions/sandbox/process-recovery";
import * as httpProbe from "../src/lib/adapters/http/probe";
import * as runtime from "../src/lib/adapters/openshell/runtime";
import * as store from "../src/lib/credentials/store";
import * as gatewayRuntime from "../src/lib/gateway-runtime-action";
import { MessagingWorkflowPlanner, type SandboxMessagingPlan } from "../src/lib/messaging";
import {
  getMessagingChannelConfigEnvKeys,
  MESSAGING_CHANNEL_CONFIG_ENV_KEYS,
} from "../src/lib/messaging-channel-config";
import * as policies from "../src/lib/policy";
import { getChannelTokenKeys, knownChannelNames, listChannels } from "../src/lib/sandbox/channels";
import * as onboardSession from "../src/lib/state/onboard-session";
import type { SandboxEntry } from "../src/lib/state/registry";
import * as registry from "../src/lib/state/registry";

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

type ProbeResult = ReturnType<typeof httpProbe.runCurlProbe>;

const TEST_ENV_KEYS = new Set([
  ...listChannels().flatMap((channel) => getChannelTokenKeys(channel)),
  ...MESSAGING_CHANNEL_CONFIG_ENV_KEYS.flatMap((key) => getMessagingChannelConfigEnvKeys(key)),
  "NEMOCLAW_MESSAGING_PLAN_B64",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION",
  "NEMOCLAW_SKIP_TELEGRAM_REACHABILITY",
]);
const originalProcessEnv = { ...process.env };

function makeMessagingPlan(
  sandboxName: string,
  channelIds: string[] = [],
  disabledChannels: string[] = [],
  agent = "openclaw",
): SandboxMessagingPlan {
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName,
    agent: agent as SandboxMessagingPlan["agent"],
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId: channelId as SandboxMessagingPlan["channels"][number]["channelId"],
      displayName: channelId,
      authMode: channelId === "whatsapp" ? "in-sandbox-qr" : "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels: disabledChannels as SandboxMessagingPlan["disabledChannels"],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function makeRegistryEntry(
  channelIds: string[] = [],
  disabledChannels: string[] = [],
  agent = sandboxAgent,
): SandboxEntry {
  return {
    name: "test-sb",
    agent,
    ...(channelIds.length > 0
      ? {
          messaging: {
            schemaVersion: 1,
            plan: makeMessagingPlan("test-sb", channelIds, disabledChannels, agent),
          },
        }
      : {}),
  } as SandboxEntry;
}

function successfulOpenshellResult(): ReturnType<typeof runtime.runOpenshell> {
  return {
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  };
}

function successfulProbe(body = '{"ok":true}'): ProbeResult {
  return {
    ok: true,
    httpStatus: 200,
    curlStatus: 0,
    body,
    stderr: "",
    message: "",
  };
}

let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;
let promptSpy: MockInstance;
let getCredentialSpy: MockInstance;
let saveCredentialSpy: MockInstance;
let deleteCredentialSpy: MockInstance;
let updateSandboxSpy: MockInstance;
let applyPresetSpy: MockInstance;
let removePresetSpy: MockInstance;
let loadPresetForSandboxSpy: MockInstance;
let providerSpy: MockInstance;
let rebuildSpy: MockInstance;
let runOpenshellSpy: MockInstance;
let curlProbeSpy: MockInstance;
let execSpy: MockInstance;
let buildPlanSpy: MockInstance;

let sandboxAgent: string;
let registryEntry: SandboxEntry;
let appliedPresets: string[];
let presetContent: string | null;
let applyPresetResult: boolean;
let sessionState: onboardSession.Session | null;
let sessionUpdateThrows: boolean;
let sessionUpdates: Array<{ policyPresets: string[] | null }>;
let callOrder: string[];
let slackBotProbe: ProbeResult;
let slackAppProbe: ProbeResult;
let testConfig: Record<string, unknown>;
let testLog: string;
let testHome: string;

const originalBuildPlan = MessagingWorkflowPlanner.prototype.buildPlan;

function printedText(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
}

async function expectExit(action: () => Promise<void>): Promise<void> {
  await expect(action()).rejects.toMatchObject({ code: 1 });
  expect(exitSpy).toHaveBeenCalledWith(1);
}

function setSession(
  sandboxName: string | null = "test-sb",
  policyPresets: string[] | null = ["npm", "pypi", "huggingface", "brew"],
): void {
  sessionState = { sandboxName, policyPresets } as onboardSession.Session;
}

beforeEach(() => {
  for (const key of TEST_ENV_KEYS) delete process.env[key];
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-channels-add-preset-"));
  process.env.HOME = testHome;
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
  process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-slack-bot-token-for-test";
  process.env.SLACK_APP_TOKEN = "xapp-slack-app-token-for-test";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token";

  sandboxAgent = "openclaw";
  registryEntry = makeRegistryEntry();
  appliedPresets = [];
  presetContent = "network_policies:\n  stub:\n    egress:\n      - host: example.com\n";
  applyPresetResult = true;
  setSession();
  sessionUpdateThrows = false;
  sessionUpdates = [];
  callOrder = [];
  slackBotProbe = successfulProbe();
  slackAppProbe = successfulProbe('{"ok":true,"url":"wss://wss-primary.slack.com/link"}');
  testConfig = {};
  testLog = "";

  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    callOrder.push(
      ...(args.map(String).join(" ").includes("Change queued") ? ["promptAndRebuild"] : []),
    );
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);

  vi.spyOn(registry, "getSandbox").mockImplementation(() => registryEntry);
  vi.spyOn(registry, "listSandboxes").mockImplementation(() => ({
    sandboxes: [registryEntry],
    defaultSandbox: "test-sb",
  }));
  updateSandboxSpy = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

  loadPresetForSandboxSpy = vi
    .spyOn(policies, "loadPresetForSandbox")
    .mockImplementation((sandboxName, presetName) => {
      callOrder.push(`loadPresetForSandbox:${sandboxName}:${presetName}`);
      return presetContent;
    });
  vi.spyOn(policies, "listPresets").mockImplementation(() =>
    ["telegram", "slack", "discord", "whatsapp", "npm", "github"].map((name) => ({
      name,
      file: `${name}.yaml`,
      description: `${name} test preset`,
    })),
  );
  applyPresetSpy = vi.spyOn(policies, "applyPreset").mockImplementation((name, presetName) => {
    callOrder.push(`applyPreset:${presetName}`);
    return applyPresetResult;
  });
  removePresetSpy = vi.spyOn(policies, "removePreset").mockImplementation((_name, presetName) => {
    callOrder.push(`removePreset:${presetName}`);
    return true;
  });
  vi.spyOn(policies, "getAppliedPresets").mockImplementation(() => appliedPresets);

  getCredentialSpy = vi
    .spyOn(store, "getCredential")
    .mockImplementation((key) => process.env[key] || null);
  saveCredentialSpy = vi.spyOn(store, "saveCredential").mockImplementation((key) => {
    callOrder.push(`saveCredential:${key}`);
  });
  deleteCredentialSpy = vi.spyOn(store, "deleteCredential").mockImplementation(() => true);
  promptSpy = vi.spyOn(store, "prompt").mockResolvedValue("y");

  vi.spyOn(onboardSession, "loadSession").mockImplementation(() => sessionState);
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
    sessionUpdateThrows
      ? (() => {
          throw new Error("simulated save failure");
        })()
      : undefined;
    sessionState ??= { sandboxName: null, policyPresets: null } as onboardSession.Session;
    const next = mutator(sessionState as onboardSession.Session) || sessionState;
    sessionState = next as onboardSession.Session;
    sessionUpdates.push({
      policyPresets: Array.isArray(sessionState.policyPresets)
        ? [...sessionState.policyPresets]
        : sessionState.policyPresets,
    });
    return sessionState;
  });

  providerSpy = vi
    .spyOn(policyChannelDependencies, "upsertMessagingProviders")
    .mockImplementation(() => {
      callOrder.push("upsertMessagingProviders");
      return [];
    });
  rebuildSpy = vi
    .spyOn(policyChannelDependencies, "rebuildSandbox")
    .mockImplementation(async () => {
      callOrder.push("rebuildSandbox");
    });

  runOpenshellSpy = vi
    .spyOn(runtime, "runOpenshell")
    .mockImplementation(() => successfulOpenshellResult());
  const healthyGatewayState = {
    state: "healthy_named",
    status: "",
    gatewayInfo: "",
    activeGateway: "nemoclaw",
  } as const;
  vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
    recovered: true,
    before: healthyGatewayState,
    after: healthyGatewayState,
    attempted: false,
  });

  curlProbeSpy = vi.spyOn(httpProbe, "runCurlProbe").mockImplementation((argv) => {
    const url = argv.at(-1);
    const isBotProbe = url?.includes("auth.test") ?? false;
    const isAppProbe = url?.includes("apps.connections.open") ?? false;
    callOrder.push(...(isBotProbe ? ["slackProbe:bot"] : isAppProbe ? ["slackProbe:app"] : []));
    return isBotProbe ? slackBotProbe : isAppProbe ? slackAppProbe : successfulProbe();
  });

  execSpy = vi
    .spyOn(processRecovery, "executeSandboxExecCommand")
    .mockImplementation((_name, command) => {
      return command.includes("/sandbox/.openclaw/openclaw.json")
        ? { status: 0, stdout: JSON.stringify(testConfig), stderr: "" }
        : command.includes("tail -n 400") && command.includes("/tmp/gateway.log")
          ? { status: 0, stdout: testLog, stderr: "" }
          : { status: 0, stdout: "", stderr: "" };
    });
  vi.spyOn(processRecovery, "executeSandboxCommand").mockReturnValue(null);

  buildPlanSpy = vi
    .spyOn(MessagingWorkflowPlanner.prototype, "buildPlan")
    .mockImplementation(function (this: MessagingWorkflowPlanner, context) {
      return originalBuildPlan.call(this, context);
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalProcessEnv);
});

describe("channels add applies a matching policy preset (#3437)", () => {
  it("plans channel enrollment through the messaging manifest workflow", async () => {
    await addSandboxChannel("test-sb", { channel: "slack" });

    expect(buildPlanSpy).toHaveBeenCalledWith({
      sandboxName: "test-sb",
      agent: "openclaw",
      workflow: "add-channel",
      isInteractive: false,
      configuredChannels: ["slack"],
      disabledChannels: [],
      supportedChannelIds: ["telegram", "discord", "wechat", "slack", "whatsapp", "teams"],
      credentialAvailability: expect.any(Object),
    });
  });

  for (const channel of ["telegram", "slack", "discord"]) {
    it(`applies the '${channel}' preset before triggering rebuild`, async () => {
      await addSandboxChannel("test-sb", { channel });

      expect(applyPresetSpy).toHaveBeenCalledOnce();
      expect(applyPresetSpy).toHaveBeenCalledWith("test-sb", channel);
      expect(loadPresetForSandboxSpy).toHaveBeenCalledWith("test-sb", channel);
      expect(callOrder.indexOf(`applyPreset:${channel}`)).toBeLessThan(
        callOrder.indexOf("promptAndRebuild"),
      );
    });
  }

  it("applies the tokenless WhatsApp preset for Hermes before triggering rebuild", async () => {
    sandboxAgent = "hermes";
    registryEntry = makeRegistryEntry([], [], "hermes");
    process.env.WHATSAPP_BOT_TOKEN = "must-not-be-used";
    process.env.WHATSAPP_TOKEN = "must-not-be-used";
    process.env.WHATSAPP_SESSION_SECRET = "must-not-be-used";

    await addSandboxChannel("test-sb", { channel: "whatsapp" });

    expect(providerSpy).not.toHaveBeenCalled();
    const messagingUpdate = updateSandboxSpy.mock.calls.find(
      (call) => (call[1] as { messaging?: unknown }).messaging,
    );
    expect(updateSandboxSpy).toHaveBeenCalledOnce();
    expect(messagingUpdate).toBeDefined();
    expect(messagingUpdate?.[0]).toBe("test-sb");
    const plan = (messagingUpdate?.[1] as { messaging: { plan: SandboxMessagingPlan } }).messaging
      .plan;
    expect(plan.channels.map((channel) => channel.channelId)).toEqual(["whatsapp"]);
    expect(plan.agent).toBe("hermes");
    expect(plan.credentialBindings).toEqual([]);
    expect(messagingUpdate?.[1]).not.toHaveProperty("messagingChannels");
    expect(messagingUpdate?.[1]).not.toHaveProperty("disabledChannels");
    expect(applyPresetSpy).toHaveBeenCalledOnce();
    expect(applyPresetSpy).toHaveBeenCalledWith("test-sb", "whatsapp");
    expect(callOrder.indexOf("applyPreset:whatsapp")).toBeLessThan(
      callOrder.indexOf("promptAndRebuild"),
    );
  });

  it("aborts tokenless WhatsApp before registry and rebuild when preset apply fails", async () => {
    sandboxAgent = "hermes";
    registryEntry = makeRegistryEntry([], [], "hermes");
    applyPresetResult = false;

    await expectExit(() => addSandboxChannel("test-sb", { channel: "whatsapp" }));

    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(applyPresetSpy).toHaveBeenCalledWith("test-sb", "whatsapp");
    expect(callOrder).not.toContain("promptAndRebuild");
  });

  it("aborts non-QR channel when policy preset YAML is missing", async () => {
    presetContent = null;

    await expectExit(() => addSandboxChannel("test-sb", { channel: "telegram" }));

    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("promptAndRebuild");
    expect(printedText()).toContain(
      "Restore the preset YAML and re-run: nemoclaw test-sb channels add telegram",
    );
  });

  it("aborts non-QR channel when policy preset YAML has no network_policies section", async () => {
    presetContent = 'name: telegram\ndescription: "stub preset without network_policies"\n';

    await expectExit(() => addSandboxChannel("test-sb", { channel: "telegram" }));

    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy).not.toHaveBeenCalled();
    expect(deleteCredentialSpy).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("promptAndRebuild");
    expect(printedText()).toContain("has no parseable entries under 'network_policies:'");
    expect(printedText()).toContain(
      "Restore the preset YAML and re-run: nemoclaw test-sb channels add telegram",
    );
  });

  it("aborts non-QR channel when policy preset YAML body is malformed", async () => {
    presetContent = "network_policies:\n  - [unclosed\n";

    await expectExit(() => addSandboxChannel("test-sb", { channel: "telegram" }));

    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("promptAndRebuild");
    expect(printedText()).toContain("has no parseable entries under 'network_policies:'");
    expect(printedText()).toContain(
      "Restore the preset YAML and re-run: nemoclaw test-sb channels add telegram",
    );
  });

  it("dry-run validates the channel preset and avoids gateway, registry, and rebuild side effects", async () => {
    await addSandboxChannel("test-sb", { channel: "telegram", dryRun: true });

    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("promptAndRebuild");
    expect(printedText()).toContain("--dry-run: would enable channel 'telegram' for 'test-sb'");
  });

  it("dry-run fails when the matching policy preset YAML is missing", async () => {
    presetContent = null;

    await expectExit(() => addSandboxChannel("test-sb", { channel: "telegram", dryRun: true }));

    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("promptAndRebuild");
    expect(printedText()).toContain(
      "Restore the preset YAML and re-run: nemoclaw test-sb channels add telegram",
    );
  });

  it("aborts QR-paired WhatsApp before registry write when its preset YAML is missing", async () => {
    presetContent = null;

    await expectExit(() => addSandboxChannel("test-sb", { channel: "whatsapp" }));

    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("promptAndRebuild");
    expect(printedText()).toContain(
      "Restore the preset YAML and re-run: nemoclaw test-sb channels add whatsapp",
    );
  });

  it("rolls back providers and credentials without writing plan state when applyPreset fails", async () => {
    applyPresetResult = false;

    await expectExit(() => addSandboxChannel("test-sb", { channel: "telegram" }));

    expect(applyPresetSpy).toHaveBeenCalledWith("test-sb", "telegram");
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(deleteCredentialSpy).toHaveBeenCalledWith("TELEGRAM_BOT_TOKEN");
    expect(sessionUpdates).toEqual([]);
    expect(callOrder).not.toContain("promptAndRebuild");
  });

  it("leaves plan state untouched and reports residual gateway state when detach fails", async () => {
    applyPresetResult = false;
    runOpenshellSpy.mockImplementation((args: string[]) =>
      args.slice(0, 3).join(" ") === "sandbox provider detach"
        ? { ...successfulOpenshellResult(), status: 1, stderr: "permission denied" }
        : successfulOpenshellResult(),
    );

    await expectExit(() => addSandboxChannel("test-sb", { channel: "telegram" }));

    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(deleteCredentialSpy).toHaveBeenCalledWith("TELEGRAM_BOT_TOKEN");
    expect(printedText()).toContain("Rollback could not fully clean gateway-providers");
    expect(printedText()).toContain("'nemoclaw test-sb channels remove telegram'");
    expect(callOrder).not.toContain("promptAndRebuild");
  });

  it("restores prior channel credentials when re-add applyPreset fails on an already-enabled channel", async () => {
    applyPresetResult = false;
    registryEntry = makeRegistryEntry(["telegram"]);
    getCredentialSpy.mockImplementation((key: string) =>
      key === "TELEGRAM_BOT_TOKEN" ? "prior-telegram-token" : null,
    );

    await expectExit(() => addSandboxChannel("test-sb", { channel: "telegram" }));

    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy).toHaveBeenCalledWith("TELEGRAM_BOT_TOKEN", "prior-telegram-token");
    expect(providerSpy).toHaveBeenCalledTimes(2);
    expect(
      providerSpy.mock.calls.map(([definitions]) =>
        definitions.map((definition: { name: string }) => definition.name),
      ),
    ).toEqual([["test-sb-telegram-bridge"], ["test-sb-telegram-bridge"]]);
    expect(callOrder).not.toContain("promptAndRebuild");
    expect(printedText()).toContain("Rollback could not fully clean gateway-providers");
  });

  it("leaves prior plan state untouched even when re-upsert during re-add rollback throws", async () => {
    applyPresetResult = false;
    registryEntry = makeRegistryEntry(["telegram"]);
    getCredentialSpy.mockImplementation((key: string) =>
      key === "TELEGRAM_BOT_TOKEN" ? "prior-telegram-token" : null,
    );
    providerSpy
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => {
        throw new Error("simulated gateway upsert failure during restore");
      });

    await expectExit(() => addSandboxChannel("test-sb", { channel: "telegram" }));

    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy).toHaveBeenCalledWith("TELEGRAM_BOT_TOKEN", "prior-telegram-token");
    expect(printedText()).toContain("Failed to restore gateway providers for 'telegram'");
    expect(printedText()).toContain("Rollback could not fully clean gateway-providers");
  });

  it("validates Slack credentials before registering providers", async () => {
    await addSandboxChannel("test-sb", { channel: "slack" });

    expect(curlProbeSpy).toHaveBeenCalledTimes(2);
    expect(curlProbeSpy.mock.calls[0][0]).toContain("https://slack.com/api/auth.test");
    expect(curlProbeSpy.mock.calls[1][0]).toContain("https://slack.com/api/apps.connections.open");
    expect(saveCredentialSpy.mock.calls.map((call) => call[0])).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);
    expect(
      providerSpy.mock.calls[0][0].map((definition: { envKey: string }) => definition.envKey),
    ).toEqual(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]);
    expect(callOrder.indexOf("slackProbe:app")).toBeLessThan(
      callOrder.indexOf("saveCredential:SLACK_BOT_TOKEN"),
    );
    expect(callOrder.indexOf("saveCredential:SLACK_APP_TOKEN")).toBeLessThan(
      callOrder.indexOf("upsertMessagingProviders"),
    );
  });

  it("can explicitly skip live Slack validation for offline channel add", async () => {
    process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";
    slackBotProbe = successfulProbe('{"ok":false,"error":"invalid_auth"}');

    await addSandboxChannel("test-sb", { channel: "slack" });

    expect(curlProbeSpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy.mock.calls.map((call) => call[0])).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);
    expect(
      providerSpy.mock.calls[0][0].map((definition: { envKey: string }) => definition.envKey),
    ).toEqual(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]);
    expect(callOrder.indexOf("saveCredential:SLACK_APP_TOKEN")).toBeLessThan(
      callOrder.indexOf("upsertMessagingProviders"),
    );
  });

  it("aborts Slack channel add on rejected Slack API validation before provider registration", async () => {
    slackBotProbe = successfulProbe('{"ok":false,"error":"invalid_auth"}');

    await expectExit(() => addSandboxChannel("test-sb", { channel: "slack" }));

    expect(saveCredentialSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(applyPresetSpy).not.toHaveBeenCalled();
  });

  it("aborts Slack channel add on indeterminate Slack API validation before provider registration", async () => {
    slackBotProbe = {
      ok: false,
      httpStatus: 0,
      curlStatus: 28,
      body: "",
      stderr: "operation timed out",
      message: "curl failed (exit 28): operation timed out",
    };

    await expectExit(() => addSandboxChannel("test-sb", { channel: "slack" }));

    expect(saveCredentialSpy).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(applyPresetSpy).not.toHaveBeenCalled();
  });
});

describe("channels add/remove keeps session.policyPresets in sync with registry", () => {
  it("appends the channel preset to session.policyPresets after a successful add", async () => {
    await addSandboxChannel("test-sb", { channel: "slack" });

    expect(sessionUpdates).toEqual([
      { policyPresets: ["npm", "pypi", "huggingface", "brew", "slack"] },
    ]);
    expect(sessionState?.policyPresets).toEqual(["npm", "pypi", "huggingface", "brew", "slack"]);
  });

  it("does not touch the session when it tracks a different sandbox", async () => {
    setSession("other-sb", ["npm", "github"]);

    await addSandboxChannel("test-sb", { channel: "slack" });

    expect(applyPresetSpy).toHaveBeenCalledWith("test-sb", "slack");
    expect(sessionUpdates).toEqual([]);
    expect(sessionState?.policyPresets).toEqual(["npm", "github"]);
  });

  it("succeeds even when no onboard session file exists", async () => {
    sessionState = null;

    await addSandboxChannel("test-sb", { channel: "slack" });

    expect(applyPresetSpy).toHaveBeenCalledWith("test-sb", "slack");
    expect(sessionUpdates).toEqual([]);
    expect(callOrder).toContain("promptAndRebuild");
  });

  it("does not abort channels-add when session save fails", async () => {
    sessionUpdateThrows = true;

    await addSandboxChannel("test-sb", { channel: "slack" });

    expect(applyPresetSpy).toHaveBeenCalledWith("test-sb", "slack");
    expect(callOrder).toContain("promptAndRebuild");
  });

  it("removes the channel preset from session.policyPresets after a successful remove", async () => {
    appliedPresets = ["slack"];
    setSession("test-sb", ["npm", "slack", "github"]);

    await removeSandboxChannel("test-sb", { channel: "slack" });

    expect(removePresetSpy).toHaveBeenCalledWith("test-sb", "slack");
    expect(sessionUpdates).toEqual([{ policyPresets: ["npm", "github"] }]);
    expect(sessionState?.policyPresets).toEqual(["npm", "github"]);
    expect(callOrder).toContain("promptAndRebuild");
  });

  it("does not touch a foreign session during channels-remove", async () => {
    appliedPresets = ["slack"];
    setSession("other-sb", ["slack", "npm"]);

    await removeSandboxChannel("test-sb", { channel: "slack" });

    expect(removePresetSpy).toHaveBeenCalledWith("test-sb", "slack");
    expect(sessionUpdates).toEqual([]);
    expect(sessionState?.policyPresets).toEqual(["slack", "npm"]);
  });

  it("succeeds during channels-remove when no onboard session file exists", async () => {
    appliedPresets = ["slack"];
    sessionState = null;

    await removeSandboxChannel("test-sb", { channel: "slack" });

    expect(removePresetSpy).toHaveBeenCalledWith("test-sb", "slack");
    expect(sessionUpdates).toEqual([]);
    expect(callOrder).toContain("promptAndRebuild");
  });

  it("does not abort channels-remove when session save fails", async () => {
    appliedPresets = ["slack"];
    setSession("test-sb", ["npm", "slack"]);
    sessionUpdateThrows = true;

    await removeSandboxChannel("test-sb", { channel: "slack" });

    expect(removePresetSpy).toHaveBeenCalledWith("test-sb", "slack");
    expect(callOrder).toContain("promptAndRebuild");
  });
});

describe("channels add verifies bridge startup after rebuild (#4314, #4390)", () => {
  beforeEach(() => {
    delete process.env.NEMOCLAW_NON_INTERACTIVE;
    promptSpy.mockResolvedValue("y");
    testConfig = { channels: { telegram: { enabled: true, accounts: { default: {} } } } };
  });

  it("confirms the startup breadcrumb when the bridge logs the starting-provider line", async () => {
    testLog = [
      "[telegram] [default] starting provider",
      "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
    ].join("\n");

    await addSandboxChannel("test-sb", { channel: "telegram" });

    expect(rebuildSpy).toHaveBeenCalledOnce();
    expect(printedText()).toContain("'telegram' bridge startup detected");
  });

  it("warns when the baked config does not mark the channel enabled", async () => {
    testConfig = { channels: { telegram: { accounts: { default: {} } } } };

    await addSandboxChannel("test-sb", { channel: "telegram" });

    expect(printedText()).toContain("was not marked enabled in baked");
  });

  it("warns when the gateway log shows no bridge breadcrumb yet", async () => {
    await addSandboxChannel("test-sb", { channel: "telegram" });

    expect(printedText()).toContain("did not log a startup breadcrumb");
  });

  it("does NOT claim success when only the no-start breadcrumb is present", async () => {
    testLog =
      "[telegram] [default] bridge did not start within 15s; check channels.telegram.enabled, plugin entries, and gateway log";

    await addSandboxChannel("test-sb", { channel: "telegram" });

    expect(printedText()).not.toContain("bridge startup detected");
    expect(printedText()).toMatch(/logged credential\/startup warnings|did not start within/);
  });

  it("forwards credential-placeholder warnings surfaced by the bridge", async () => {
    testLog =
      "[telegram] [default] credential placeholder mismatch: openclaw.json botToken does not match runtime TELEGRAM_BOT_TOKEN placeholder";

    await addSandboxChannel("test-sb", { channel: "telegram" });

    expect(printedText()).toContain("logged credential/startup warnings");
  });

  it("skips the OpenClaw-shaped probe for Hermes sandboxes (avoids false negatives)", async () => {
    sandboxAgent = "hermes";
    registryEntry = makeRegistryEntry([], [], "hermes");
    testConfig = { channels: { telegram: {} } };

    await addSandboxChannel("test-sb", { channel: "telegram" });

    expect(execSpy).not.toHaveBeenCalled();
    expect(printedText()).not.toContain("was not marked enabled in baked");
    expect(printedText()).not.toContain("bridge startup detected");
  });

  it("skips the verifier for WhatsApp's QR-only runtime", async () => {
    testConfig = { channels: {} };

    await addSandboxChannel("test-sb", { channel: "whatsapp" });

    expect(execSpy).not.toHaveBeenCalled();
    expect(printedText()).not.toContain("was not marked enabled in baked openclaw.json");
  });
});

describe("channel preset source-of-truth", () => {
  it("every channel registered in KNOWN_CHANNELS ships a preset YAML that parsePresetPolicyKeys() accepts", () => {
    const failures: string[] = [];
    for (const name of knownChannelNames()) {
      const content = policies.loadPreset(name);
      if (content === null) {
        failures.push(`${name}: preset YAML not found on disk`);
        continue;
      }
      if (policies.parsePresetPolicyKeys(content).length === 0) {
        failures.push(`${name}: parsePresetPolicyKeys returned no entries`);
      }
    }

    expect(failures).toEqual([]);
  });
});
