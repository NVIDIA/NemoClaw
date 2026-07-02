// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const D = (p: string) => requireSource(`../../${p}`);

const registry = D("state/registry.js");
const defs = D("agent/defs.js");
const policy = D("policy/index.js");
const store = D("credentials/store.js");
const onboardSession = D("state/onboard-session.js");
const contextRefresh = D("actions/sandbox/policy-context-refresh.js");

const { addSandboxPolicy } = D("actions/sandbox/policy-channel.js") as {
  addSandboxPolicy: (
    name: string,
    options?: {
      preset?: string;
      dryRun?: boolean;
      yes?: boolean;
      force?: boolean;
      fromFile?: string;
      fromDir?: string;
    },
  ) => Promise<void>;
};

const MESSAGING_POLICY_KEYS = [
  ["telegram_bot", "api.telegram.org"],
  ["discord", "discord.com"],
  ["slack", "api.slack.com"],
  ["wechat_bridge", "api.weixin.qq.com"],
  ["whatsapp", "graph.facebook.com"],
  ["teams", "graph.microsoft.com"],
] as const;

const MESSAGING_CHANNELS = ["telegram", "discord", "slack", "wechat", "whatsapp"] as const;

const PRESETS = [
  { name: "pypi", description: "Python Package Index access" },
  { name: "telegram", description: "Telegram API access" },
  { name: "discord", description: "Discord API access" },
  { name: "slack", description: "Slack API access" },
  { name: "wechat", description: "WeChat API access" },
  { name: "whatsapp", description: "WhatsApp API access" },
];

let errSpy: MockInstance;
let logSpy: MockInstance;
let applyPresetMock: MockInstance;
let selectFromListMock: MockInstance;
let promptMock: MockInstance;

function exitCodeFromError(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/^process\.exit\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}

function errorText(): string {
  return (errSpy.mock.calls as unknown[][]).map((call) => call.map(String).join(" ")).join("\n");
}

function logText(): string {
  return (logSpy.mock.calls as unknown[][]).map((call) => call.map(String).join(" ")).join("\n");
}

async function captureExit(action: () => Promise<void>): Promise<number | null> {
  try {
    await action();
  } catch (err) {
    return exitCodeFromError(err);
  }
  return null;
}

beforeEach(() => {
  delete process.env.NEMOCLAW_NON_INTERACTIVE;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "da-test",
    agent: "langchain-deepagents-code",
    policies: [],
  });
  vi.spyOn(policy, "listPresets").mockReturnValue(PRESETS);
  vi.spyOn(policy, "listCustomPresets").mockReturnValue([]);
  vi.spyOn(policy, "getAppliedPresets").mockReturnValue([]);
  vi.spyOn(policy, "loadPreset").mockImplementation((name: unknown) => {
    const presetName = String(name);
    return `network_policies:\n  ${presetName}:\n    host: ${presetName}.example.com\n`;
  });
  applyPresetMock = vi.spyOn(policy, "applyPreset").mockReturnValue(true);
  selectFromListMock = vi.spyOn(policy, "selectFromList").mockResolvedValue("pypi");
  promptMock = vi.spyOn(store, "prompt").mockResolvedValue("y");

  vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
  vi.spyOn(onboardSession, "updateSession").mockImplementation(() => undefined);
  vi.spyOn(contextRefresh, "refreshSandboxPolicyContextFile").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addSandboxPolicy channel-agent gate", () => {
  it.each(
    MESSAGING_CHANNELS,
  )("refuses the '%s' channel preset on a terminal-runtime agent before any disclosure, prompt, or apply", async (channel) => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "langchain-deepagents-code" });

    const code = await captureExit(() =>
      addSandboxPolicy("da-test", { preset: channel, yes: true }),
    );

    expect(code).toBe(1);
    expect(errorText()).toMatch(
      new RegExp(`Channel '${channel}' does not support agent 'langchain-deepagents-code'`),
    );
    expect(errorText()).toMatch(/Channel-supported agents: openclaw, hermes/);
    expect(errorText()).toMatch(
      /Channels supported by agent 'langchain-deepagents-code': \(none\)/,
    );
    expect(logText()).not.toContain("Endpoints that would be opened");
    expect(promptMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
  });

  it("still applies a non-messaging preset on a terminal-runtime agent", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "langchain-deepagents-code" });

    await addSandboxPolicy("da-test", { preset: "pypi", yes: true });

    expect(errorText()).not.toMatch(/does not support agent/);
    expect(applyPresetMock).toHaveBeenCalledWith("da-test", "pypi");
  });

  it("does not gate a messaging-capable agent (openclaw applies a channel preset)", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "oc-test",
      agent: "openclaw",
      policies: [],
    });
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "openclaw" });

    await addSandboxPolicy("oc-test", { preset: "telegram", yes: true });

    expect(errorText()).not.toMatch(/does not support agent/);
    expect(applyPresetMock).toHaveBeenCalledWith("oc-test", "telegram");
  });

  it("omits unsupported channel presets from the interactive picker for a terminal-runtime agent", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "langchain-deepagents-code" });

    await addSandboxPolicy("da-test");

    expect(selectFromListMock).toHaveBeenCalledTimes(1);
    const offered = (selectFromListMock.mock.calls[0][0] as Array<{ name: string }>).map(
      (preset) => preset.name,
    );
    expect(offered).toContain("pypi");
    for (const channel of MESSAGING_CHANNELS) {
      expect(offered).not.toContain(channel);
    }
  });
});

describe("addSandboxPolicy custom preset (--from-file) agent gate", () => {
  it.each(
    MESSAGING_POLICY_KEYS,
  )("rejects a custom preset with a '%s' policy key on a terminal-runtime agent before any disclosure, prompt, or apply", async (policyKey, host) => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "langchain-deepagents-code" });
    vi.spyOn(policy, "loadPresetFromFile").mockReturnValue({
      presetName: "my-custom",
      content: `preset:\n  name: my-custom\nnetwork_policies:\n  ${policyKey}:\n    host: ${host}\n`,
    });
    const applyPresetContentMock = vi.spyOn(policy, "applyPresetContent");

    const code = await captureExit(() =>
      addSandboxPolicy("da-test", { fromFile: "/tmp/my-custom.yaml", yes: true }),
    );

    expect(code).toBe(1);
    expect(errorText()).toMatch(/does not support agent 'langchain-deepagents-code'/);
    expect(logText()).not.toContain("Endpoints that would be opened");
    expect(promptMock).not.toHaveBeenCalled();
    expect(applyPresetContentMock).not.toHaveBeenCalled();
  });

  it("still applies a non-messaging custom preset on a terminal-runtime agent", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "langchain-deepagents-code" });
    vi.spyOn(policy, "loadPresetFromFile").mockReturnValue({
      presetName: "my-pypi-mirror",
      content:
        "preset:\n  name: my-pypi-mirror\nnetwork_policies:\n  pypi_mirror:\n    host: pypi.example.com\n",
    });
    const applyPresetContentMock = vi.spyOn(policy, "applyPresetContent").mockReturnValue(true);

    await addSandboxPolicy("da-test", { fromFile: "/tmp/my-pypi-mirror.yaml", yes: true });

    expect(errorText()).not.toMatch(/does not support agent/);
    expect(applyPresetContentMock).toHaveBeenCalledWith(
      "da-test",
      "my-pypi-mirror",
      expect.stringContaining("pypi_mirror"),
      { custom: { sourcePath: expect.stringContaining("my-pypi-mirror.yaml") } },
    );
  });
});
