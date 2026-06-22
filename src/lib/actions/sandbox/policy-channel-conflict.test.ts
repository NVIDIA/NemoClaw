// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Cross-sandbox messaging-credential conflict detection on `channels add`
// (issue #4305). These tests drive the public `addSandboxChannel` action and
// assert only on the mocked module boundaries — never on the private helper
// names — so they survive a refactor of the internal conflict-check plumbing.
//
// Why dist + vi.spyOn (the rebuild-shields-finally.test.ts pattern): the source
// policy-channel.ts loads several deps via runtime CommonJS `require()`
// (../../onboard, ../../onboard/providers, ./rebuild, ../../runner, ...). In
// this repo's vitest setup, `vi.mock` only intercepts ESM `import`, not plain
// `require()`, and those modules do extensionless sibling requires the TS
// transform cannot resolve. So we require the COMPILED module + its real
// compiled dependency modules from dist/ (one shared require cache) and
// `vi.spyOn` the dependency exports. Run `npm run build:cli` first.
//
// isNonInteractive is destructured at module load (`const { isNonInteractive }
// = require("../../onboard")`), so it cannot be spied after load; it reads
// process.env.NEMOCLAW_NON_INTERACTIVE === "1" at call time, which we drive
// directly. The real messaging/applier, sandbox/channels, and credential-hash
// modules run unmocked so the genuine hash + conflict logic is exercised.

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const D = (p: string) => requireDist(`../../../../dist/lib/${p}`);

type SandboxEntry = import("../../state/registry").SandboxEntry;

// Real compiled dependency modules (shared require cache with the SUT).
const store = D("credentials/store.js");
const registry = D("state/registry.js");
const providers = D("onboard/providers.js");
const runtime = D("adapters/openshell/runtime.js");
const gatewayRuntime = D("gateway-runtime-action.js");
const defs = D("agent/defs.js");
const rebuild = D("actions/sandbox/rebuild.js");
const processRecovery = D("actions/sandbox/process-recovery.js");
const onboardSession = D("state/onboard-session.js");
const policy = D("policy/index.js");
const { hashCredential } = D("security/credential-hash.js") as {
  hashCredential: (v: string) => string | null;
};
const { addSandboxChannel } = D("actions/sandbox/policy-channel.js") as {
  addSandboxChannel: (
    name: string,
    options?: { channel?: string; dryRun?: boolean; force?: boolean },
  ) => Promise<void>;
};

const TELEGRAM_TOKEN = "123456:AAH-secret-bot-token-value";
const TELEGRAM_HASH = hashCredential(TELEGRAM_TOKEN) as string;

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

let spies: MockInstance[];
let logSpy: MockInstance;
let errSpy: MockInstance;
let exitMock: MockInstance;
let promptMock: MockInstance;
let getCredentialMock: MockInstance;
let updateSandboxMock: MockInstance;
let upsertMock: MockInstance;
let runOpenshellMock: MockInstance;
let applyPresetMock: MockInstance;
let getSandboxMock: MockInstance;
let listSandboxesMock: MockInstance;

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

beforeEach(() => {
  spies = [];
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_IDS;
  delete process.env.TELEGRAM_REQUIRE_MENTION;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_ALLOWED_USERS;
  delete process.env.SLACK_ALLOWED_CHANNELS;
  delete process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY;
  delete process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION;
  delete process.env.WECHAT_BOT_TOKEN;
  delete process.env.WECHAT_ACCOUNT_ID;
  delete process.env.WECHAT_BASE_URL;
  delete process.env.WECHAT_USER_ID;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitMock = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  // Registry seam.
  getSandboxMock = vi.spyOn(registry, "getSandbox").mockReturnValue(null);
  listSandboxesMock = vi
    .spyOn(registry, "listSandboxes")
    .mockReturnValue({ sandboxes: [], defaultSandbox: null });
  updateSandboxMock = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

  // onboard/providers seam (gateway probe + register).
  vi.spyOn(providers, "providerExistsInGateway").mockReturnValue(false);
  upsertMock = vi.spyOn(providers, "upsertMessagingProviders").mockImplementation(() => undefined);

  // openshell runtime + gateway recovery.
  runOpenshellMock = vi
    .spyOn(runtime, "runOpenshell")
    .mockReturnValue({ status: 0, stdout: "", stderr: "" });
  vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({ recovered: true });

  // Credentials store: staged token (no real prompt) + controllable prompt.
  getCredentialMock = vi.spyOn(store, "getCredential").mockReturnValue(null);
  promptMock = vi.spyOn(store, "prompt").mockResolvedValue("");
  vi.spyOn(store, "saveCredential").mockImplementation(() => undefined);

  // Agent gate: support every channel.
  vi.spyOn(defs, "loadAgent").mockReturnValue({
    name: "openclaw",
    messagingPlatforms: ["telegram", "discord", "slack", "wechat", "whatsapp"],
  });

  // Policy seam. addSandboxChannel gates on loadPreset()/parsePresetPolicyKeys()
  // up front (the channel must ship a preset with network_policies); stub both
  // so the gate passes without reading preset YAML off disk. listPresets [] so
  // no preset is treated as "built-in" for any channel
  // (applyChannelPresetIfAvailable then short-circuits to success).
  vi.spyOn(policy, "loadPreset").mockReturnValue("network_policies:\n  stub: {}\n");
  vi.spyOn(policy, "parsePresetPolicyKeys").mockReturnValue(["stub"]);
  vi.spyOn(policy, "listPresets").mockReturnValue([]);
  applyPresetMock = vi.spyOn(policy, "applyPreset").mockReturnValue(true);
  vi.spyOn(policy, "getAppliedPresets").mockReturnValue([]);

  // Downstream rebuild is not under test.
  vi.spyOn(rebuild, "rebuildSandbox").mockResolvedValue(undefined);

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
  vi.spyOn(onboardSession, "updateSession").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const s of spies) s.mockRestore();
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
});

describe("addSandboxChannel cross-sandbox conflict check (#4305)", () => {
  // Scenario 1
  it("interactive matching-token conflict: warns, user continues, add proceeds", async () => {
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

    await addSandboxChannel("alpha", { channel: "telegram" });

    const text = loggedText();
    expect(text).toContain("bob");
    expect(text).toContain("same telegram credential");
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(updateSandboxMock).toHaveBeenCalledWith("alpha", expect.any(Object));
  });

  // Scenario 2
  it("interactive matching-token conflict: user aborts, nothing is mutated", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    promptMock.mockResolvedValue("n");

    await addSandboxChannel("alpha", { channel: "telegram" });

    expect(loggedText()).toContain("same telegram credential");
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("interactive matching-token conflict: empty answer (default N) aborts", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [
        makePlanEntry("bob", "telegram", [
          { providerEnvKey: "TELEGRAM_BOT_TOKEN", credentialHash: TELEGRAM_HASH },
        ]),
      ],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    promptMock.mockResolvedValue(""); // bare Enter -> default No

    await addSandboxChannel("alpha", { channel: "telegram" });

    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalledWith("alpha", expect.any(Object));
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
  it("--force bypasses the conflict even in non-interactive mode", async () => {
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
  it("unknown-token wording when the other sandbox has the channel but no hash", async () => {
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      others: [makePlanEntry("bob", "telegram", [{ providerEnvKey: "TELEGRAM_BOT_TOKEN" }])],
    });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    promptMock.mockResolvedValue("y");

    await addSandboxChannel("alpha", { channel: "telegram" });

    const text = loggedText();
    expect(text).toContain("credential hash is unavailable");
    expect(text).not.toContain("same telegram credential");
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
  it("--dry-run never runs the conflict check or touches credentials", async () => {
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
  it("entries without messaging plans are ignored while plan-backed conflicts still warn", async () => {
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

  it("non-interactive add aborts when the conflict check throws", async () => {
    arrangeRegistry({ current: makeEmptyEntry("alpha"), others: [] });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    listSandboxesMock.mockImplementation(() => {
      throw new Error("malformed messaging plan");
    });
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await expect(addSandboxChannel("alpha", { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    const text = loggedText();
    expect(text).toContain("Could not verify messaging channel conflicts");
    expect(text).toContain("rerun with --force");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("--force proceeds when the conflict check throws", async () => {
    arrangeRegistry({ current: makeEmptyEntry("alpha"), others: [] });
    getCredentialMock.mockReturnValue(TELEGRAM_TOKEN);
    listSandboxesMock.mockImplementation(() => {
      throw new Error("malformed messaging plan");
    });
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";

    await addSandboxChannel("alpha", { channel: "telegram", force: true });

    const text = loggedText();
    expect(text).toContain("proceeding without a completed messaging channel conflict check");
    expect(exitMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  // Scenario 10
  it("never prints the raw token value in any conflict output (proceed path)", async () => {
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

    await addSandboxChannel("alpha", { channel: "telegram" });

    const text = loggedText();
    expect(text).toContain("same telegram credential"); // sanity
    expect(text).not.toContain(TELEGRAM_TOKEN); // no raw secret
    expect(text).not.toContain(TELEGRAM_HASH); // hash not in conflict warning text
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
  it("slack two-token channel: matching SLACK_BOT_TOKEN hash is detected", async () => {
    const slackBot = "xoxb-test-slack-bot-token";
    const slackApp = "xapp-test-slack-app-token";
    const slackBotHash = hashCredential(slackBot) as string;
    arrangeRegistry({
      current: makeEmptyEntry("alpha"),
      // only bot token stored — app token unknown → conservative unknown-token OR
      // matching-token if bot token matches; test verifies the conflict is surfaced.
      others: [
        makePlanEntry("bob", "slack", [
          { providerEnvKey: "SLACK_BOT_TOKEN", credentialHash: slackBotHash },
        ]),
      ],
    });
    getCredentialMock.mockImplementation((key: string) => {
      if (key === "SLACK_BOT_TOKEN") return slackBot;
      if (key === "SLACK_APP_TOKEN") return slackApp;
      return null;
    });
    promptMock.mockResolvedValue("y");

    await addSandboxChannel("alpha", { channel: "slack" });

    const text = loggedText();
    expect(text).toContain("bob");
    expect(text).toContain("same slack credential"); // matching-token wording
    expect(text).not.toContain(slackBot);
    expect(text).not.toContain(slackApp);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("slack: a second sandbox on the SAME gateway is blocked even with a different token (#4953)", async () => {
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
    promptMock.mockResolvedValue("n"); // decline the conflict prompt

    await addSandboxChannel("alpha", { channel: "slack" });

    const text = loggedText();
    expect(text).toContain("Slack Socket Mode is already enabled for sandbox 'bob'");
    expect(text).not.toContain("same slack credential"); // gateway axis, not a token match
    expect(text).not.toContain(slackBot);
    expect(text).not.toContain(slackApp);
    expect(conflictPromptShown()).toBe(true);
    expect(upsertMock).not.toHaveBeenCalled(); // aborted before registering
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
    promptMock.mockResolvedValue("n");

    await addSandboxChannel("alpha", { channel: "slack" });

    const text = loggedText();
    expect(text).toContain("Slack Socket Mode is already enabled for sandbox 'bob'");
    expect(text).not.toContain(slackBot);
    expect(text).not.toContain(slackApp);
    expect(conflictPromptShown()).toBe(true);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("slack: shared token on the same gateway reports the credential conflict first (#4953)", async () => {
    // The credential axis runs before the gateway axis, so a shared Slack token
    // surfaces the gateway-independent "same slack credential" warning (more
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

  it("slack: a gateway conflict-detection failure is fail-soft, not a crash (#4953)", async () => {
    arrangeRegistry({ current: { name: "alpha" } as SandboxEntry });
    // Simulate a malformed registry read: listSandboxes throws. The Slack
    // gateway lookup must swallow it (best-effort warning) rather than crash
    // the add or bypass the downstream guarded credential check.
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
    promptMock.mockResolvedValue("y"); // proceed through any "could not verify" prompt

    await addSandboxChannel("alpha", { channel: "slack" });

    expect(loggedText()).toContain("Could not verify messaging pre-enable checks");
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
