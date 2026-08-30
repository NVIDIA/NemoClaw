// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Cross-sandbox messaging-credential conflict detection on `channels add`
// (issue #4305). These tests drive the public `addSandboxChannel` action and
// assert only on the mocked module boundaries — never on the private helper
// names — so they survive a refactor of the internal conflict-check plumbing.
//
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as runtime from "../../adapters/openshell/runtime";
import * as defs from "../../agent/defs";
import * as store from "../../credentials/store";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as policy from "../../policy";
import { hashCredential } from "../../security/credential-hash";
import * as onboardSession from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import * as messagingHostForwardLifecycle from "./messaging-host-forward-lifecycle";
import { addSandboxChannel, startSandboxChannel } from "./policy-channel";
import { policyChannelDependencies } from "./policy-channel-dependencies";
import * as processRecovery from "./process-recovery";

function agentFixture(name: string): defs.AgentDefinition {
  return { name } as defs.AgentDefinition;
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

const TELEGRAM_TOKEN = "123456:AAH-secret-bot-token-value";
const TELEGRAM_HASH = hashCredential(TELEGRAM_TOKEN) as string;
const DISCORD_TOKEN = "discord-test-token";

// Build a minimal plan-backed SandboxEntry for conflict-detection fixtures.
// Callers supply credential bindings as { providerEnvKey, credentialHash? }.
function makePlanEntry(
  name: string,
  channelId: "telegram" | "slack" | "discord" | "wechat" | "whatsapp",
  bindings: Array<{ providerEnvKey: string; credentialHash?: string }>,
): SandboxEntry {
  return {
    name,
    messaging: {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: name,
        agent: "openclaw",
        workflow: "onboard",
        channels: [
          {
            channelId,
            displayName: channelId,
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
        credentialBindings: bindings.map((b) => ({
          channelId,
          credentialId: b.providerEnvKey.toLowerCase(),
          sourceInput: b.providerEnvKey.toLowerCase(),
          providerName: `${name}-${channelId}-bridge`,
          providerEnvKey: b.providerEnvKey,
          placeholder: `openshell:resolve:env:${b.providerEnvKey}`,
          credentialAvailable: true,
          ...(b.credentialHash ? { credentialHash: b.credentialHash } : {}),
        })),
        networkPolicy: { presets: [], entries: [] },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      },
    },
  } as unknown as SandboxEntry;
}

function makeEmptyEntry(name: string): SandboxEntry {
  return { name } as SandboxEntry;
}

function makeTeamsEntry(
  name: string,
  { disabled = false, port = "3978" }: { disabled?: boolean; port?: string } = {},
): SandboxEntry {
  const active = !disabled;
  return {
    name,
    agent: "openclaw",
    messaging: {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: name,
        agent: "openclaw",
        workflow: "onboard",
        channels: [
          {
            channelId: "teams",
            displayName: "Microsoft Teams",
            authMode: "token-paste",
            active,
            selected: true,
            configured: true,
            disabled,
            inputs: [
              {
                channelId: "teams",
                inputId: "appId",
                kind: "config",
                required: true,
                sourceEnv: "MSTEAMS_APP_ID",
                statePath: "teamsConfig.appId",
                value: "teams-app-id",
              },
              {
                channelId: "teams",
                inputId: "clientSecret",
                kind: "secret",
                required: true,
                sourceEnv: "MSTEAMS_APP_PASSWORD",
                credentialAvailable: true,
              },
              {
                channelId: "teams",
                inputId: "tenantId",
                kind: "config",
                required: true,
                sourceEnv: "MSTEAMS_TENANT_ID",
                statePath: "teamsConfig.tenantId",
                value: "teams-tenant-id",
              },
              {
                channelId: "teams",
                inputId: "allowedUsers",
                kind: "config",
                required: false,
                sourceEnv: "TEAMS_ALLOWED_USERS",
                statePath: "allowedIds.teams",
                value: "",
              },
              {
                channelId: "teams",
                inputId: "webhookPort",
                kind: "config",
                required: false,
                sourceEnv: "MSTEAMS_PORT",
                statePath: "teamsConfig.webhookPort",
                value: port,
              },
              {
                channelId: "teams",
                inputId: "requireMention",
                kind: "config",
                required: false,
                sourceEnv: "TEAMS_REQUIRE_MENTION",
                statePath: "teamsConfig.requireMention",
                value: "1",
              },
            ],
            ...(active
              ? {
                  hostForward: {
                    channelId: "teams",
                    port: Number(port),
                    label: "Microsoft Teams webhook",
                  },
                }
              : {}),
            hooks: [],
          },
        ],
        disabledChannels: disabled ? ["teams"] : [],
        credentialBindings: [
          {
            channelId: "teams",
            credentialId: "teamsClientSecret",
            sourceInput: "clientSecret",
            providerName: `${name}-teams-bridge`,
            providerEnvKey: "MSTEAMS_APP_PASSWORD",
            placeholder: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
            credentialAvailable: true,
          },
        ],
        networkPolicy: {
          presets: active ? ["teams"] : [],
          entries: active
            ? [
                {
                  channelId: "teams",
                  presetName: "teams",
                  policyKeys: ["teams"],
                  source: "manifest",
                },
              ]
            : [],
        },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      },
    },
  } as unknown as SandboxEntry;
}

function makeHermesDiscordEntry(name: string): SandboxEntry {
  return {
    name,
    agent: "hermes",
    messaging: {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: name,
        agent: "hermes",
        workflow: "stop-channel",
        channels: [
          {
            channelId: "discord",
            displayName: "Discord",
            authMode: "token-paste",
            active: false,
            selected: true,
            configured: true,
            disabled: true,
            inputs: [],
            hooks: [],
          },
        ],
        disabledChannels: ["discord"],
        credentialBindings: [
          {
            channelId: "discord",
            credentialId: "botToken",
            sourceInput: "botToken",
            providerName: `${name}-discord-bridge`,
            providerEnvKey: "DISCORD_BOT_TOKEN",
            placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
            credentialAvailable: true,
          },
        ],
        networkPolicy: { presets: [], entries: [] },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      },
    },
  } as unknown as SandboxEntry;
}

let spies: MockInstance[];
let logSpy: MockInstance;
let errSpy: MockInstance;
let exitMock: MockInstance;
let promptMock: MockInstance;
let getCredentialMock: MockInstance;
let saveCredentialMock: MockInstance;
let updateSandboxMock: MockInstance;
let upsertMock: MockInstance;
let runOpenshellMock: MockInstance;
let applyPresetMock: MockInstance;
let getSandboxMock: MockInstance;
let getDisabledChannelsMock: MockInstance;
let listSandboxesMock: MockInstance;
let rebuildSandboxMock: MockInstance;
let ensureMessagingHostForwardAfterRebuildMock: MockInstance;
let scopeDisclosureMock: MockInstance;

function arrangeRegistry(opts: { current: SandboxEntry; others?: SandboxEntry[] }): void {
  const all = [opts.current, ...(opts.others ?? [])];
  listSandboxesMock.mockReturnValue({ sandboxes: all, defaultSandbox: opts.current.name });
  getSandboxMock.mockImplementation((name: string) => all.find((s) => s.name === name) ?? null);
}

function loggedText(): string {
  const lines: string[] = [];
  for (const call of (logSpy.mock.calls as unknown[][]) ?? [])
    lines.push(call.map(String).join(" "));
  for (const call of (errSpy.mock.calls as unknown[][]) ?? [])
    lines.push(call.map(String).join(" "));
  return lines.join("\n");
}

// True iff the conflict-resolution "Continue anyway?" prompt was shown.
// (The unrelated "Rebuild now?" prompt fires after a successful add and must
// not be conflated with the conflict prompt.)
function conflictPromptShown(): boolean {
  return (promptMock.mock.calls as unknown[][]).some((call) =>
    String(call[0]).includes("Continue anyway?"),
  );
}

let stdinIsTty: PropertyDescriptor | undefined;

beforeEach(() => {
  spies = [];
  stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_IDS;
  delete process.env.TELEGRAM_REQUIRE_MENTION;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_ALLOWED_USERS;
  delete process.env.SLACK_ALLOWED_CHANNELS;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY;
  delete process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION;
  delete process.env.WECHAT_BOT_TOKEN;
  delete process.env.WECHAT_ACCOUNT_ID;
  delete process.env.WECHAT_BASE_URL;
  delete process.env.WECHAT_USER_ID;
  delete process.env.MSTEAMS_APP_ID;
  delete process.env.MSTEAMS_APP_PASSWORD;
  delete process.env.MSTEAMS_TENANT_ID;
  delete process.env.MSTEAMS_PORT;
  delete process.env.TEAMS_ALLOWED_USERS;
  delete process.env.TEAMS_REQUIRE_MENTION;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitMock = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  // Registry seam.
  getSandboxMock = vi.spyOn(registry, "getSandbox").mockReturnValue(null);
  getDisabledChannelsMock = vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);
  listSandboxesMock = vi
    .spyOn(registry, "listSandboxes")
    .mockReturnValue({ sandboxes: [], defaultSandbox: null });
  updateSandboxMock = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

  // Lazy legacy-provider seam: no onboarding graph is loaded for this suite.
  upsertMock = vi.spyOn(policyChannelDependencies, "upsertMessagingProviders").mockReturnValue([]);
  vi.spyOn(policyChannelDependencies, "revalidateChannelProviderPolicy").mockImplementation(
    () => undefined,
  );

  // openshell runtime + gateway recovery.
  runOpenshellMock = vi.spyOn(runtime, "runOpenshell").mockReturnValue(successfulOpenshellResult());
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

  // Credentials store: staged token (no real prompt) + controllable prompt.
  getCredentialMock = vi.spyOn(store, "getCredential").mockReturnValue(null);
  promptMock = vi.spyOn(store, "prompt").mockResolvedValue("");
  saveCredentialMock = vi.spyOn(store, "saveCredential").mockImplementation(() => undefined);

  // Agent gate: OpenClaw support is derived from channel manifests.
  vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("openclaw"));

  // Policy seam. addSandboxChannel gates on loadPreset()/parsePresetPolicyKeys()
  // up front (the channel must ship a preset with network_policies); stub both
  // so the gate passes without reading preset YAML off disk. listPresets [] so
  // no preset is treated as "built-in" for any channel
  // (applyChannelPresetIfAvailable then short-circuits to success).
  vi.spyOn(policy, "loadPreset").mockReturnValue("network_policies:\n  stub: {}\n");
  vi.spyOn(policy, "parsePresetPolicyKeys").mockReturnValue(["stub"]);
  vi.spyOn(policy, "listPresets").mockReturnValue([]);
  vi.spyOn(policy, "getPresetContentGatewayState").mockReturnValue("absent");
  scopeDisclosureMock = vi
    .spyOn(policy, "logPresetScopeForState")
    .mockImplementation(() => undefined);
  applyPresetMock = vi.spyOn(policy, "applyPreset").mockReturnValue(true);
  vi.spyOn(policy, "getAppliedPresets").mockReturnValue([]);

  // Downstream rebuild is not under test.
  rebuildSandboxMock = vi
    .spyOn(policyChannelDependencies, "rebuildSandbox")
    .mockResolvedValue(undefined);
  ensureMessagingHostForwardAfterRebuildMock = vi
    .spyOn(messagingHostForwardLifecycle, "ensureMessagingHostForwardAfterRebuild")
    .mockReturnValue(true);

  // After a successful interactive add, channel health-check hooks can probe
  // the sandbox via executeSandboxExecCommand, which calls getOpenshellBinary()
  // -> process.exit(1) when the openshell binary is absent (e.g. the CI
  // unit-test runner; locally it is installed, so this only bites in CI). Stub
  // the exec path so the post-add verification never shells out and never trips
  // the exit spy unless a test explicitly overrides it.
  vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue(null);
  vi.spyOn(processRecovery, "executeSandboxCommand").mockReturnValue(null);

  process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
  process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";

  // onboard-session for the wechat host-qr branch.
  vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
  vi.spyOn(onboardSession, "updateSession").mockReturnValue(
    undefined as unknown as onboardSession.Session,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const s of spies) s.mockRestore();
  stdinIsTty
    ? Object.defineProperty(process.stdin, "isTTY", stdinIsTty)
    : Reflect.deleteProperty(process.stdin, "isTTY");
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  delete process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY;
  delete process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_IDS;
  delete process.env.TELEGRAM_REQUIRE_MENTION;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_ALLOWED_USERS;
  delete process.env.SLACK_ALLOWED_CHANNELS;
  delete process.env.WECHAT_BOT_TOKEN;
  delete process.env.WECHAT_ACCOUNT_ID;
  delete process.env.WECHAT_BASE_URL;
  delete process.env.WECHAT_USER_ID;
  delete process.env.MSTEAMS_APP_ID;
  delete process.env.MSTEAMS_APP_PASSWORD;
  delete process.env.MSTEAMS_TENANT_ID;
  delete process.env.MSTEAMS_PORT;
  delete process.env.TEAMS_ALLOWED_USERS;
  delete process.env.TEAMS_REQUIRE_MENTION;
});

describe("addSandboxChannel cross-sandbox conflict check (#4305)", () => {
  // Scenario 1
  it("aborts interactive credential conflicts without prompting (#7808)", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    promptMock.mockResolvedValue("y");

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    const text = loggedText();
    expect(text).toContain("bob");
    expect(text).toContain("same telegram credential");
    expect(conflictPromptShown()).toBe(false);
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  // Scenario 3
  it("non-interactive matching-token conflict: aborts with exit(1) and guidance", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(exitMock).toHaveBeenCalledWith(1);
    const text = loggedText();
    expect(text).toContain("same telegram credential");
    expect(text).toContain("Aborting");
    expect(text).toContain("--force");
    expect(text).toContain("channels remove");
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(promptMock).not.toHaveBeenCalled();
  });

  // Scenario 4
  it("bypasses the conflict with --force even in non-interactive mode", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await addSandboxChannel("alpha", { channel: "telegram", force: true });

    const text = loggedText();
    expect(text).toContain("same telegram credential"); // warning still shown
    expect(text).toContain("--force"); // proceed line
    expect(exitMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(updateSandboxMock).toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(promptMock).not.toHaveBeenCalled();
  });

  // Scenario 5a
  it("aborts when the other sandbox has the channel but no credential hash", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [makePlanEntry("bob", "telegram", [{ providerEnvKey: "TELEGRAM_BOT_TOKEN" }])],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    promptMock.mockResolvedValue("y");

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    const text = loggedText();
    expect(text).toContain("credential hash is unavailable");
    expect(text).not.toContain("same telegram credential");
    expect(conflictPromptShown()).toBe(false);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("does not create or attach a provider when credential-free policy fails", async () => {
    arrangeRegistry({ current: makeEmptyEntry("alpha") });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    applyPresetMock.mockReturnValueOnce(false);

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(applyPresetMock).toHaveBeenCalledWith(
      "alpha",
      "telegram",
      expect.objectContaining({ includeMessagingCredentialBindings: false }),
    );
    expect(upsertMock).not.toHaveBeenCalled();
    expect(runOpenshellMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["provider", "attach"]),
      expect.anything(),
    );
  });

  it("removes credential-free policy when provider attachment fails", async () => {
    arrangeRegistry({ current: makeEmptyEntry("alpha") });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    upsertMock.mockReturnValue(["alpha-telegram-bridge"]);
    vi.mocked(policy.listPresets).mockReturnValue([
      { file: "telegram.yaml", name: "telegram", description: "Telegram" },
    ]);
    vi.mocked(policy.getAppliedPresets).mockReturnValue(["telegram"]);
    const removePresetMock = vi.spyOn(policy, "removePreset").mockReturnValue(true);
    runOpenshellMock.mockImplementation((args: readonly string[]) =>
      args.includes("attach")
        ? { ...successfulOpenshellResult(), status: 1 }
        : successfulOpenshellResult(),
    );

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(removePresetMock).toHaveBeenCalledWith("alpha", "telegram");
  });

  // Scenario 5b
  it("different hash on the other sandbox is NOT a conflict (no warning, add proceeds)", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          {
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialHash: hashCredential("a-completely-different-token") as string,
          },
        ]),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    promptMock.mockResolvedValue("n"); // would abort IF prompted; proves no prompt happens

    await addSandboxChannel("alpha", { channel: "telegram" });

    const text = loggedText();
    expect(text).not.toContain("credential hash is unavailable");
    expect(text).not.toContain("same telegram credential");
    expect(conflictPromptShown()).toBe(false);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(updateSandboxMock).toHaveBeenCalledWith("alpha", expect.any(Object));
  });

  it("registers Hermes Discord with the exact static provider binding", async () => {
    arrangeRegistry({
      current: { ...makeEmptyEntry("alpha"), agent: "hermes" } as SandboxEntry,
    });
    vi.mocked(defs.loadAgent).mockReturnValue(agentFixture("hermes"));
    getCredentialMock.mockImplementation((key: string) =>
      key === "DISCORD_BOT_TOKEN" ? DISCORD_TOKEN : null,
    );

    await addSandboxChannel("alpha", { channel: "discord" });

    expect(upsertMock).toHaveBeenCalledWith(
      [
        {
          name: "alpha-discord-bridge",
          envKey: "DISCORD_BOT_TOKEN",
          token: DISCORD_TOKEN,
          providerType: "discord-hermes-static-v1",
        },
      ],
      "nemoclaw",
      { bestEffort: true, requireExactBindings: true },
    );
  });

  it("does not remove a pre-existing provider after a Hermes Discord identity conflict", async () => {
    const originalEntry = { ...makeEmptyEntry("alpha"), agent: "hermes" } as SandboxEntry;
    arrangeRegistry({ current: originalEntry });
    vi.mocked(defs.loadAgent).mockReturnValue(agentFixture("hermes"));
    getCredentialMock.mockImplementation((key: string) =>
      key === "DISCORD_BOT_TOKEN" ? DISCORD_TOKEN : null,
    );
    upsertMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("alpha-discord-bridge does not match the required binding"), {
        code: "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT",
        mutatedProviderNames: [],
      });
    });

    await expect(addSandboxChannel("alpha", { channel: "discord" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(updateSandboxMock).not.toHaveBeenCalled();
    expect(registry.getSandbox("alpha")).toBe(originalEntry);
    expect(
      runOpenshellMock.mock.calls
        .map(([args]) => (args as string[]).join(" "))
        .filter((command) => command.includes("provider detach") || command.includes("delete")),
    ).toEqual([]);
  });

  it("does not persist a multi-provider add when identity preflight fails", async () => {
    const originalEntry = makeEmptyEntry("alpha");
    arrangeRegistry({ current: originalEntry });
    const slackBot = "xoxb-alpha-slack-bot-token";
    const slackApp = "xapp-alpha-slack-app-token";
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN" ? slackBot : key === "SLACK_APP_TOKEN" ? slackApp : null,
    );
    upsertMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("alpha-slack-app does not match the required binding"), {
        code: "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT",
        mutatedProviderNames: [],
      });
    });

    await expect(addSandboxChannel("alpha", { channel: "slack" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(upsertMock.mock.calls[0]?.[0]).toHaveLength(2);
    expect(saveCredentialMock).not.toHaveBeenCalled();
    expect(applyPresetMock).toHaveBeenCalledWith(
      "alpha",
      "slack",
      expect.objectContaining({ includeMessagingCredentialBindings: false }),
    );
    expect(applyPresetMock).not.toHaveBeenCalledWith(
      "alpha",
      "slack",
      expect.objectContaining({ includeMessagingCredentialBindings: true }),
    );
    expect(updateSandboxMock).not.toHaveBeenCalled();
    expect(rebuildSandboxMock).not.toHaveBeenCalled();
    expect(registry.getSandbox("alpha")).toBe(originalEntry);
    expect(
      runOpenshellMock.mock.calls
        .map(([args]) => (args as string[]).join(" "))
        .filter((command) => command.includes("provider detach") || command.includes("delete")),
    ).toEqual([]);
  });

  // Scenario 6
  it("idempotent same-sandbox re-add does not self-conflict", async () => {
    arrangeRegistry({
      current: makePlanEntry("alpha", "telegram", [
        { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
      ]),
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    promptMock.mockResolvedValue("n"); // would abort IF prompted

    await addSandboxChannel("alpha", { channel: "telegram" });

    const text = loggedText();
    expect(text).not.toContain("same telegram credential");
    expect(text).not.toContain("credential hash is unavailable");
    expect(conflictPromptShown()).toBe(false);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(updateSandboxMock).toHaveBeenCalledWith("alpha", expect.any(Object));
  });

  // Scenario 7
  it("avoids the conflict check and credentials with --dry-run", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
      ],
    });

    await addSandboxChannel("alpha", { channel: "telegram", dryRun: true });

    const text = loggedText();
    expect(text).toContain("--dry-run: would enable channel 'telegram'");
    expect(text).not.toContain("same telegram credential");
    expect(text).not.toContain("credential hash is unavailable");
    expect(getCredentialMock).not.toHaveBeenCalled();
    expect(runOpenshellMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });

  // Scenario 8: WeChat is host-qr (token-bearing) -> non-empty acquired -> IS conflict-checked.
  it("host-qr wechat (token-bearing) IS conflict-checked", async () => {
    const wechatToken = "wx-secret-token-abc";
    const wechatHash = hashCredential(wechatToken) as string;
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "wechat", [
          { providerEnvKey: "WECHAT_BOT_TOKEN", credentialHash: wechatHash },
        ]),
      ],
    });
    // The hook planner skips non-interactive host-QR enrollment, but the
    // conflict guard should still see a cached WeChat credential.
    getCredentialMock.mockImplementation((key: string) =>
      key === "WECHAT_BOT_TOKEN" ? wechatToken : null,
    );
    process.env.WECHAT_ACCOUNT_ID = "acct-1";
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(addSandboxChannel("alpha", { channel: "wechat" })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(loggedText()).toContain("same wechat credential");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  // Scenario 8 (companion): genuinely in-sandbox-QR channel (whatsapp) has empty
  // acquired and skips the credential conflict check entirely.
  it("in-sandbox-qr whatsapp skips the credential conflict check", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [makePlanEntry("bob", "whatsapp", [])],
    });
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await addSandboxChannel("alpha", { channel: "whatsapp" });

    const text = loggedText();
    expect(text).not.toContain("Continue anyway?");
    expect(text).toContain("Enabled whatsapp channel");
    expect(exitMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("in-sandbox-qr whatsapp aborts when plan persistence fails", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [],
    });
    updateSandboxMock.mockReturnValue(false);
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(addSandboxChannel("alpha", { channel: "whatsapp" })).rejects.toThrow(
      "process.exit(1)",
    );

    const text = loggedText();
    expect(text).toContain("Could not persist messaging plan for 'alpha'");
    expect(text).not.toContain("Enabled whatsapp channel");
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(promptMock).not.toHaveBeenCalled();
  });

  // Scenario 9
  it("entries without messaging plans are ignored while plan-backed conflicts still abort", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
        makeEmptyEntry("legacy"),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(loggedText()).toContain("same telegram credential");
  });

  it("entries without messaging plans do not block an add", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [makeEmptyEntry("legacy")],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);

    await addSandboxChannel("alpha", { channel: "telegram" });

    expect(exitMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(updateSandboxMock).toHaveBeenCalledWith("alpha", expect.any(Object));
  });

  it("aborts without prompting when the conflict check throws", async () => {
    arrangeRegistry({ current: makeEmptyEntry("alpha"), others: [] });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    listSandboxesMock.mockImplementation(() => {
      throw new Error("malformed messaging plan");
    });
    promptMock.mockResolvedValue("y");

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    const text = loggedText();
    expect(text).toContain("Could not verify messaging channel conflicts");
    expect(text).toContain("re-run with --force");
    expect(conflictPromptShown()).toBe(false);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("proceeds with --force when the conflict check throws", async () => {
    arrangeRegistry({ current: makeEmptyEntry("alpha"), others: [] });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    listSandboxesMock.mockImplementation(() => {
      throw new Error("malformed messaging plan");
    });
    await addSandboxChannel("alpha", { channel: "telegram", force: true });

    const text = loggedText();
    expect(text).toContain("proceeding without a completed messaging channel conflict check");
    expect(exitMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  // Scenario 10
  it("never prints raw credential material in the --force conflict path", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    await addSandboxChannel("alpha", { channel: "telegram", force: true });

    const text = loggedText();
    expect(text).toContain("same telegram credential"); // sanity
    expect(text).not.toContain(TELEGRAM_TOKEN); // no raw secret
    expect(text).not.toContain(TELEGRAM_HASH); // hash not in conflict output
  });

  it("non-interactive abort path also keeps the raw token out of output", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(loggedText()).not.toContain(TELEGRAM_TOKEN);
  });

  // Scenario 11
  it("rejects a reused Slack app token across gateways without prompting (#7808)", async () => {
    const slackBot = "xoxb-alpha-slack-bot-token";
    const slackApp = "xapp-shared-slack-app-token";
    const bob = makePlanEntry("bob", "slack", [
      {
        providerEnvKey: "SLACK_BOT_TOKEN",
        credentialHash: hashCredential("xoxb-bob-slack-bot-token") as string,
      },
      {
        providerEnvKey: "SLACK_APP_TOKEN",
        credentialHash: hashCredential(slackApp) as string,
      },
    ]);
    (bob as { gatewayName?: string }).gatewayName = "nemoclaw-9090";
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [bob],
    });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN" ? slackBot : key === "SLACK_APP_TOKEN" ? slackApp : null,
    );
    promptMock.mockResolvedValue("y");

    await expect(addSandboxChannel("alpha", { channel: "slack" })).rejects.toThrow(
      "process.exit(1)",
    );

    const text = loggedText();
    expect(text).toContain("bob");
    expect(text).toContain("same slack credential");
    expect(text).not.toContain(slackBot);
    expect(text).not.toContain(slackApp);
    expect(text).not.toContain("proceeding despite");
    expect(conflictPromptShown()).toBe(false);
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("allows --force for a reused Slack app token across gateways (#7808)", async () => {
    const slackBot = "xoxb-alpha-slack-bot-token";
    const slackApp = "xapp-shared-slack-app-token";
    const bob = makePlanEntry("bob", "slack", [
      {
        providerEnvKey: "SLACK_BOT_TOKEN",
        credentialHash: hashCredential("xoxb-bob-slack-bot-token") as string,
      },
      {
        providerEnvKey: "SLACK_APP_TOKEN",
        credentialHash: hashCredential(slackApp) as string,
      },
    ]);
    (bob as { gatewayName?: string }).gatewayName = "nemoclaw-9090";
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [bob],
    });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN" ? slackBot : key === "SLACK_APP_TOKEN" ? slackApp : null,
    );
    promptMock.mockResolvedValue("y");

    await addSandboxChannel("alpha", { channel: "slack", force: true });

    const text = loggedText();
    expect(text).toContain("same slack credential");
    expect(text).toContain("--force: proceeding despite");
    expect(text).not.toContain(slackBot);
    expect(text).not.toContain(slackApp);
    expect(conflictPromptShown()).toBe(false);
    expect(exitMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("allows --force for a second Slack sandbox on the same gateway (#7808)", async () => {
    const slackBot = "xoxb-alpha-bot-token";
    const slackApp = "xapp-alpha-app-token";
    arrangeRegistry({
      current: { name: "alpha" } as SandboxEntry,
      // bob holds Slack on the default gateway with entirely different tokens —
      // the credential axis would NOT flag this, but the gateway axis must.
      others: [
        makePlanEntry("bob", "slack", [
          {
            providerEnvKey: "SLACK_BOT_TOKEN",
            credentialHash: hashCredential("xoxb-bob-bot") as string,
          },
          {
            providerEnvKey: "SLACK_APP_TOKEN",
            credentialHash: hashCredential("xapp-bob-app") as string,
          },
        ]),
      ],
    });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN" ? slackBot : key === "SLACK_APP_TOKEN" ? slackApp : null,
    );
    promptMock.mockResolvedValue("y");

    await addSandboxChannel("alpha", { channel: "slack", force: true });

    const text = loggedText();
    expect(text).toContain("Slack Socket Mode is already enabled for sandbox 'bob'");
    expect(text).not.toContain("same slack credential"); // gateway axis, not a token match
    expect(text).not.toContain(slackBot);
    expect(text).not.toContain(slackApp);
    expect(text).toContain("--force: proceeding despite");
    expect(conflictPromptShown()).toBe(false);
    expect(exitMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("slack: a second sandbox on the SAME non-default gateway is blocked", async () => {
    // Both sandboxes are bound to `nemoclaw-8090`. The credential axis would
    // not flag distinct tokens, but the channel-owned pre-enable gateway axis
    // must check the same target gateway the provider mutation uses.
    const slackBot = "xoxb-alpha-bot-token";
    const slackApp = "xapp-alpha-app-token";
    const alpha = { name: "alpha", gatewayName: "nemoclaw-8090", gatewayPort: 8090 } as never;
    const bob = makePlanEntry("bob", "slack", [
      {
        providerEnvKey: "SLACK_BOT_TOKEN",
        credentialHash: hashCredential("xoxb-bob-bot") as string,
      },
      {
        providerEnvKey: "SLACK_APP_TOKEN",
        credentialHash: hashCredential("xapp-bob-app") as string,
      },
    ]);
    (bob as { gatewayName?: string; gatewayPort?: number }).gatewayName = "nemoclaw-8090";
    (bob as { gatewayName?: string; gatewayPort?: number }).gatewayPort = 8090;
    arrangeRegistry({ current: alpha, others: [bob] });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN" ? slackBot : key === "SLACK_APP_TOKEN" ? slackApp : null,
    );
    promptMock.mockResolvedValue("y");

    await expect(addSandboxChannel("alpha", { channel: "slack" })).rejects.toThrow(
      "process.exit(1)",
    );

    const text = loggedText();
    expect(text).toContain("Slack Socket Mode is already enabled for sandbox 'bob'");
    expect(text).not.toContain(slackBot);
    expect(text).not.toContain(slackApp);
    expect(conflictPromptShown()).toBe(false);
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("slack: shared token on the same gateway reports the credential conflict first (#4953)", async () => {
    // The credential axis runs before the gateway axis, so a shared Slack token
    // surfaces the gateway-independent "same slack credential" conflict (more
    // actionable: it conflicts even after moving to another gateway) instead of
    // only the same-gateway remediation.
    const slackBot = "xoxb-shared-bot-token";
    const slackApp = "xapp-shared-app-token";
    arrangeRegistry({
      current: { name: "alpha" } as SandboxEntry,
      others: [
        makePlanEntry("bob", "slack", [
          { providerEnvKey: "SLACK_BOT_TOKEN", credentialHash: hashCredential(slackBot) as string },
          { providerEnvKey: "SLACK_APP_TOKEN", credentialHash: hashCredential(slackApp) as string },
        ]),
      ],
    });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN" ? slackBot : key === "SLACK_APP_TOKEN" ? slackApp : null,
    );
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(addSandboxChannel("alpha", { channel: "slack" })).rejects.toThrow(
      "process.exit(1)",
    );

    const text = loggedText();
    expect(text).toContain("same slack credential"); // credential axis fired first
    expect(text).not.toContain(slackBot);
    expect(text).not.toContain(slackApp);
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("slack: a second sandbox on a DIFFERENT gateway is not gateway-blocked (#4953)", async () => {
    const bob = makePlanEntry("bob", "slack", [
      {
        providerEnvKey: "SLACK_BOT_TOKEN",
        credentialHash: hashCredential("xoxb-bob-bot") as string,
      },
      {
        providerEnvKey: "SLACK_APP_TOKEN",
        credentialHash: hashCredential("xapp-bob-app") as string,
      },
    ]);
    (bob as { gatewayName?: string }).gatewayName = "nemoclaw-9090";
    arrangeRegistry({
      current: { name: "alpha" } as SandboxEntry,
      others: [bob],
    });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN"
        ? "xoxb-alpha-bot"
        : key === "SLACK_APP_TOKEN"
          ? "xapp-alpha-app"
          : null,
    );
    promptMock.mockResolvedValue("n"); // would abort if any conflict prompt were shown

    await addSandboxChannel("alpha", { channel: "slack" });

    const text = loggedText();
    expect(text).not.toContain("Slack Socket Mode is already enabled");
    expect(conflictPromptShown()).toBe(false);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("rejects Slack setup when the conflict check cannot read the registry (#7808)", async () => {
    arrangeRegistry({ current: { name: "alpha" } as SandboxEntry });
    listSandboxesMock.mockImplementation(() => {
      throw new Error("registry boom");
    });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN"
        ? "xoxb-alpha-bot"
        : key === "SLACK_APP_TOKEN"
          ? "xapp-alpha-app"
          : null,
    );
    promptMock.mockResolvedValue("y");

    await expect(addSandboxChannel("alpha", { channel: "slack" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(loggedText()).toContain("Could not verify messaging channel conflicts for slack");
    expect(loggedText()).toContain("re-run with --force");
    expect(conflictPromptShown()).toBe(false);
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("allows --force when the Slack conflict check cannot read the registry (#7808)", async () => {
    arrangeRegistry({ current: { name: "alpha" } as SandboxEntry });
    listSandboxesMock.mockImplementation(() => {
      throw new Error("registry boom");
    });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN"
        ? "xoxb-alpha-bot"
        : key === "SLACK_APP_TOKEN"
          ? "xapp-alpha-app"
          : null,
    );

    await addSandboxChannel("alpha", { channel: "slack", force: true });

    expect(loggedText()).toContain(
      "--force: proceeding without a completed messaging channel conflict check",
    );
    expect(conflictPromptShown()).toBe(false);
    expect(exitMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("runs Telegram post-rebuild bridge verification through the channel hook", async () => {
    arrangeRegistry({ current: { name: "alpha" } as SandboxEntry });
    getCredentialMock.mockImplementation((key: string) =>
      key === "TELEGRAM_BOT_TOKEN" ? TELEGRAM_TOKEN : null,
    );
    mockBridgeHealthExec({
      config: {
        channels: {
          telegram: {
            enabled: true,
            accounts: {
              default: {
                dmPolicy: "allowlist",
                allowFrom: [],
              },
            },
          },
        },
      },
      log: "[telegram] [default] starting provider\n",
    });

    await addSandboxChannel("alpha", { channel: "telegram" });

    const text = loggedText();
    expect(text).toContain("'telegram' bridge startup detected");
    expect(text).toContain("Telegram direct-message allowlist is empty");
    const execCommands = vi
      .mocked(processRecovery.executeSandboxExecCommand)
      .mock.calls.map((call: unknown[]) => String(call[1]));
    expect(execCommands.some((cmd: string) => cmd.includes("grep"))).toBe(false);
    expect(
      execCommands.some(
        (cmd: string) => cmd.includes("tail -n 400") && cmd.includes("gateway.log"),
      ),
    ).toBe(true);
  });

  it("runs Slack post-rebuild warning detection through the channel hook", async () => {
    arrangeRegistry({ current: { name: "alpha" } as SandboxEntry });
    getCredentialMock.mockImplementation((key: string) =>
      key === "SLACK_BOT_TOKEN"
        ? "xoxb-alpha-bot"
        : key === "SLACK_APP_TOKEN"
          ? "xapp-alpha-app"
          : null,
    );
    mockBridgeHealthExec({
      config: {
        channels: {
          slack: {
            enabled: true,
          },
        },
      },
      log: "[channels] [slack] provider failed to start: invalid_auth\n",
    });

    await addSandboxChannel("alpha", { channel: "slack" });

    const text = loggedText();
    expect(text).toContain("'slack' bridge logged credential/startup warnings");
    expect(text).toContain("invalid_auth");
    expect(exitMock).not.toHaveBeenCalled();
  });
});

describe("Teams host-forward lifecycle (PRA-2)", () => {
  function setTeamsEnv(port = "3978"): void {
    process.env.MSTEAMS_APP_ID = "teams-app-id";
    process.env.MSTEAMS_APP_PASSWORD = "teams-client-secret";
    process.env.MSTEAMS_TENANT_ID = "teams-tenant-id";
    process.env.MSTEAMS_PORT = port;
    process.env.TEAMS_REQUIRE_MENTION = "1";
  }

  function teamsForwardFromFirstEnsureCall(): unknown {
    const plan = ensureMessagingHostForwardAfterRebuildMock.mock.calls[0]?.[1] as
      | { channels?: Array<{ channelId?: string; hostForward?: unknown }> }
      | undefined;
    return plan?.channels?.find((channel) => channel.channelId === "teams")?.hostForward;
  }

  it("channels add teams starts the MSTEAMS_PORT host forward after rebuild-now completes", async () => {
    setTeamsEnv();
    arrangeRegistry({ current: makeEmptyEntry("alpha") });

    await addSandboxChannel("alpha", { channel: "teams" });

    expect(rebuildSandboxMock).toHaveBeenCalledWith("alpha", ["--yes"]);
    expect(ensureMessagingHostForwardAfterRebuildMock).toHaveBeenCalledWith(
      "alpha",
      expect.any(Object),
    );
    expect(ensureMessagingHostForwardAfterRebuildMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      rebuildSandboxMock.mock.invocationCallOrder[0],
    );
    expect(teamsForwardFromFirstEnsureCall()).toEqual({
      channelId: "teams",
      port: 3978,
      label: "Microsoft Teams webhook",
    });
  });

  it("channels start teams re-establishes the MSTEAMS_PORT host forward after rebuild-now completes", async () => {
    arrangeRegistry({ current: makeTeamsEntry("alpha", { disabled: true, port: "3978" }) });
    getDisabledChannelsMock.mockReturnValue(["teams"]);

    await startSandboxChannel("alpha", { channel: "teams" });

    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(rebuildSandboxMock).toHaveBeenCalledWith("alpha", ["--yes"]);
    expect(ensureMessagingHostForwardAfterRebuildMock).toHaveBeenCalledWith(
      "alpha",
      expect.any(Object),
    );
    expect(ensureMessagingHostForwardAfterRebuildMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      rebuildSandboxMock.mock.invocationCallOrder[0],
    );
    expect(teamsForwardFromFirstEnsureCall()).toEqual({
      channelId: "teams",
      port: 3978,
      label: "Microsoft Teams webhook",
    });
  });

  it("rebuilds before a credential-bound Hermes Discord policy reaches the replacement sandbox", async () => {
    const current = makeHermesDiscordEntry("alpha");
    arrangeRegistry({ current });
    vi.mocked(defs.loadAgent).mockReturnValue(agentFixture("hermes"));
    getDisabledChannelsMock.mockImplementation(
      () => current.messaging?.plan.disabledChannels ?? [],
    );
    updateSandboxMock.mockImplementation((_name: string, updates: Partial<SandboxEntry>) => {
      Object.assign(current, updates);
      return true;
    });
    applyPresetMock.mockImplementation(() => {
      throw new Error(
        "credential_binding references provider 'alpha-discord-bridge', but that provider is not attached to the sandbox",
      );
    });
    rebuildSandboxMock.mockImplementation(async () => {
      expect(current.messaging?.plan.disabledChannels).toEqual([]);
      expect(current.messaging?.plan.networkPolicy.presets).toEqual(["discord"]);
      expect(current.messaging?.plan.credentialBindings).toContainEqual(
        expect.objectContaining({
          providerName: "alpha-discord-bridge",
          providerEnvKey: "DISCORD_BOT_TOKEN",
        }),
      );
    });

    await startSandboxChannel("alpha", { channel: "discord" });

    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(rebuildSandboxMock).toHaveBeenCalledWith("alpha", ["--yes"]);
    expect(updateSandboxMock.mock.invocationCallOrder[0]).toBeLessThan(
      rebuildSandboxMock.mock.invocationCallOrder[0],
    );
  });

  it("channels start defers policy application when a non-interactive rebuild is queued", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    arrangeRegistry({ current: makeTeamsEntry("alpha", { disabled: true }) });
    getDisabledChannelsMock.mockReturnValue(["teams"]);

    await startSandboxChannel("alpha", { channel: "teams" });

    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(rebuildSandboxMock).not.toHaveBeenCalled();
    expect(loggedText()).toContain("Change queued");
  });

  it("channels start discloses before dry-run return and before persisted-plan mutation (#7179)", async () => {
    const current = makeTeamsEntry("alpha", { disabled: true });
    arrangeRegistry({ current });
    getDisabledChannelsMock.mockReturnValue(["teams"]);

    await startSandboxChannel("alpha", { channel: "teams", dryRun: true });

    expect(scopeDisclosureMock).toHaveBeenCalledOnce();
    expect(updateSandboxMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();

    scopeDisclosureMock.mockClear();
    await startSandboxChannel("alpha", { channel: "teams" });

    expect(scopeDisclosureMock).toHaveBeenCalledOnce();
    expect(scopeDisclosureMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateSandboxMock.mock.invocationCallOrder[0],
    );
    expect(applyPresetMock).not.toHaveBeenCalled();
  });
});

function mockBridgeHealthExec(options: { config: unknown; log: string }): void {
  vi.mocked(processRecovery.executeSandboxExecCommand).mockImplementation(
    (_sandboxName: string, command: string) => {
      if (command.includes("cat") && command.includes("openclaw.json")) {
        return { status: 0, stdout: JSON.stringify(options.config), stderr: "" };
      }
      if (command.includes("tail -n 400") && command.includes("gateway.log")) {
        return { status: 0, stdout: options.log, stderr: "" };
      }
      return null;
    },
  );
}
