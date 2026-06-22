// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-channels-stop-start.sh. */

import { expect } from "../fixtures/e2e-test.ts";
import {
  type AgentKind,
  arrayRecords,
  cleanupSandbox,
  dockerInfo,
  expectExitZero,
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  messagingPlan,
  phase6Env,
  phase6Tokens,
  rebuildSandbox,
  redactionValues,
  resultText,
  sandboxSh,
  stringArray,
} from "./phase6-messaging-helpers.ts";

const AGENT = (process.env.NEMOCLAW_CHANNELS_STOP_START_AGENT ??
  process.env.NEMOCLAW_AGENT ??
  "openclaw") as AgentKind;
if (AGENT !== "openclaw" && AGENT !== "hermes") {
  throw new Error(`NEMOCLAW_CHANNELS_STOP_START_AGENT must be openclaw or hermes, got ${AGENT}`);
}
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-channels-stop-start-${AGENT}`;
const CHANNELS = ["telegram", "discord", "wechat", "slack", "whatsapp"] as const;
const PROVIDERS: Record<string, (sandbox: string) => string[]> = {
  telegram: (sandbox) => [`${sandbox}-telegram-bridge`],
  discord: (sandbox) => [`${sandbox}-discord-bridge`],
  wechat: (sandbox) => [`${sandbox}-wechat-bridge`],
  slack: (sandbox) => [`${sandbox}-slack-bridge`, `${sandbox}-slack-app`],
  whatsapp: () => [],
};
export const LIVE_TIMEOUT_MS = 80 * 60_000;

type ChannelState = "active" | "disabled";

function planChannel(channelId: string) {
  return arrayRecords(messagingPlan(SANDBOX_NAME).channels).find(
    (channel) => channel.channelId === channelId,
  );
}

function expectPlanChannelState(channelId: string, expected: ChannelState): void {
  const plan = messagingPlan(SANDBOX_NAME);
  const channels = arrayRecords(plan.channels);
  const channel = channels.find((entry) => entry.channelId === channelId);
  expect(channel, `${channelId} missing from messaging.plan.channels`).toBeTruthy();
  expect(channel?.configured, `${channelId} configured`).toBe(true);
  expect(plan.sandboxName, "messaging.plan.sandboxName").toBe(SANDBOX_NAME);
  expect(plan.agent, "messaging.plan.agent").toBe(AGENT);

  const disabledChannels = stringArray(plan.disabledChannels);
  if (expected === "active") {
    expect(channel?.active, `${channelId} active`).toBe(true);
    expect(channel?.disabled, `${channelId} disabled unexpectedly`).not.toBe(true);
    expect(disabledChannels, `${channelId} unexpectedly disabled`).not.toContain(channelId);
  } else {
    expect(channel?.disabled, `${channelId} disabled`).toBe(true);
    expect(channel?.active, `${channelId} active unexpectedly`).not.toBe(true);
    expect(disabledChannels, `${channelId} missing from disabledChannels`).toContain(channelId);
  }

  const networkPolicy =
    plan.networkPolicy && typeof plan.networkPolicy === "object"
      ? (plan.networkPolicy as Record<string, unknown>)
      : {};
  expect(stringArray(networkPolicy.presets), `${channelId} policy preset`).toContain(channelId);
  expect(
    arrayRecords(networkPolicy.entries).some((entry) => entry.channelId === channelId),
    `${channelId} policy entry`,
  ).toBe(true);
  const credentialBindings = arrayRecords(plan.credentialBindings);
  if (channelId !== "whatsapp") {
    expect(
      credentialBindings.some((entry) => entry.channelId === channelId),
      `${channelId} credential binding`,
    ).toBe(true);
  }
  expect(Object.hasOwn(plan, "agentRender"), "messaging.plan.agentRender should not persist").toBe(
    false,
  );
  expect(
    channels.some((entry) => Object.hasOwn(entry, "hooks")),
    "messaging.plan.channels hooks should not persist",
  ).toBe(false);
}

function expectChannelInputs(): void {
  const expected: Record<string, Record<string, string>> = {
    telegram: {
      allowedIds: process.env.TELEGRAM_ALLOWED_IDS ?? "123456789,987654321",
      requireMention: process.env.TELEGRAM_REQUIRE_MENTION ?? "0",
    },
    discord: {
      serverId: process.env.DISCORD_SERVER_ID ?? "1491590992753590594",
      userId: process.env.DISCORD_USER_ID ?? "1005536447329222676",
      requireMention: process.env.DISCORD_REQUIRE_MENTION ?? "0",
    },
    slack: { allowedUsers: process.env.SLACK_ALLOWED_USERS ?? "U0123456789,U09ABCDEFGH" },
    wechat: {
      allowedIds:
        process.env.WECHAT_ALLOWED_IDS ?? process.env.WECHAT_USER_ID ?? "wxid_e2e_operator",
    },
  };
  for (const [channelId, inputs] of Object.entries(expected)) {
    const channel = planChannel(channelId);
    const planInputs = arrayRecords(channel?.inputs);
    for (const [inputId, value] of Object.entries(inputs)) {
      expect(
        planInputs.find((input) => input.inputId === inputId)?.value,
        `${channelId}.${inputId}`,
      ).toBe(value);
    }
  }
}

function openClawChannelKey(channel: string): string {
  return channel === "wechat" ? "openclaw-weixin" : channel;
}

async function agentConfigContains(
  sandbox: import("../fixtures/clients/sandbox.ts").SandboxClient,
  channel: string,
  redactions: string[],
): Promise<boolean> {
  if (AGENT === "openclaw") {
    const result = await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      `python3 - <<'PY'\nimport json\nchannel=${JSON.stringify(openClawChannelKey(channel))}\ncfg=json.load(open('/sandbox/.openclaw/openclaw.json'))\nprint('yes' if channel in cfg.get('channels', {}) else 'no')\nPY`,
      { artifactName: `config-channel-${AGENT}-${channel}`, redactionValues: redactions },
    );
    expectExitZero(result, `read OpenClaw channel ${channel}`);
    return result.stdout.trim() === "yes";
  }

  const probes: Record<string, string> = {
    telegram:
      'grep -Eq "^TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN$" /sandbox/.hermes/.env',
    discord:
      'grep -Eq "^DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN$" /sandbox/.hermes/.env',
    wechat:
      'grep -Eq "^WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN$" /sandbox/.hermes/.env',
    slack:
      'grep -Eq "^SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN$" /sandbox/.hermes/.env && grep -Eq "^SLACK_APP_TOKEN=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN$" /sandbox/.hermes/.env',
    whatsapp:
      'grep -Eq "^WHATSAPP_ENABLED=true$" /sandbox/.hermes/.env && grep -Eq "^WHATSAPP_MODE=bot$" /sandbox/.hermes/.env',
  };
  const result = await sandboxSh(
    sandbox,
    SANDBOX_NAME,
    `if [ -r /sandbox/.hermes/.env ] && ${probes[channel]}; then echo yes; else echo no; fi`,
    { artifactName: `config-channel-${AGENT}-${channel}`, redactionValues: redactions },
  );
  expectExitZero(result, `read Hermes channel ${channel}`);
  return result.stdout.trim() === "yes";
}

async function expectAgentConfig(
  sandbox: import("../fixtures/clients/sandbox.ts").SandboxClient,
  expected: "present" | "absent",
  redactions: string[],
): Promise<void> {
  for (const channel of CHANNELS) {
    const present = await agentConfigContains(sandbox, channel, redactions);
    expect(present, `${AGENT}/${channel} config ${expected}`).toBe(expected === "present");
  }
}

async function expectProvidersExist(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  context: string,
): Promise<void> {
  for (const channel of CHANNELS) {
    for (const provider of PROVIDERS[channel](SANDBOX_NAME)) {
      const result = await host.command("openshell", ["provider", "get", provider], {
        artifactName: `provider-${provider}-${context}`,
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      });
      expectExitZero(result, `${provider} exists ${context}`);
    }
  }
}

async function precleanProviders(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  context: string,
): Promise<void> {
  for (const channel of CHANNELS) {
    for (const provider of PROVIDERS[channel](SANDBOX_NAME)) {
      await host.command("openshell", ["provider", "delete", provider], {
        artifactName: `provider-delete-${provider}-${context}`,
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      });
      const result = await host.command("openshell", ["provider", "get", provider], {
        artifactName: `provider-absent-${provider}-${context}`,
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      });
      expect(
        result.exitCode,
        `${provider} absent after provider pre-clean\n${resultText(result)}`,
      ).not.toBe(0);
    }
  }
}

async function policyPresetActive(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  channel: string,
): Promise<boolean> {
  const result = await host.command(
    "node",
    [process.env.NEMOCLAW_CLI_BIN ?? "bin/nemoclaw.js", SANDBOX_NAME, "policy-list"],
    {
      artifactName: `policy-list-${channel}-${AGENT}`,
      env,
      redactionValues: redactions,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, `policy-list ${channel}`);
  return resultText(result).includes(`● ${channel}`);
}

async function runChannelCommand(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  action: "add" | "stop" | "start",
  channel: string,
): Promise<void> {
  const result = await host.command(
    "node",
    [process.env.NEMOCLAW_CLI_BIN ?? "bin/nemoclaw.js", SANDBOX_NAME, "channels", action, channel],
    {
      artifactName: `channels-${action}-${channel}-${AGENT}`,
      env,
      redactionValues: redactions,
      timeoutMs: 10 * 60_000,
    },
  );
  expectExitZero(result, `channels ${action} ${channel}`);
  const expectedText =
    action === "add"
      ? `Enabled ${channel} channel`
      : `Marked ${channel} ${action === "stop" ? "disabled" : "enabled"}`;
  expect(resultText(result)).toContain(expectedText);
}

export const CHANNELS_STOP_START_TEST_NAME = `${AGENT} channels stop/start preserves credentials and toggles runtime config`;

export async function runChannelsStopStartScenario({
  artifacts,
  cleanup,
  host,
  sandbox,
  secrets,
  skip,
}: import("../fixtures/e2e-test.ts").E2EScenarioFixtures & {
  skip: (note?: string) => never;
}): Promise<void> {
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const tokens = phase6Tokens(AGENT);
  const env = phase6Env({ sandboxName: SANDBOX_NAME, agent: AGENT, apiKey, tokens });
  const redactions = redactionValues(apiKey, tokens);

  await artifacts.writeJson("scenario.json", {
    id: "channels-stop-start",
    legacySource: "test/e2e/test-channels-stop-start.sh",
    boundary:
      "install.sh messaging onboard + channels stop/start CLI + rebuild + sandbox config probes",
    agent: AGENT,
    sandboxName: SANDBOX_NAME,
    channels: CHANNELS,
  });

  cleanup.add(`destroy channels stop/start sandbox ${SANDBOX_NAME}`, () =>
    cleanupSandbox(host, SANDBOX_NAME, env, redactions, `cleanup-channels-stop-start-${AGENT}`),
  );
  await cleanupSandbox(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `preclean-channels-stop-start-${AGENT}`,
  );
  await precleanProviders(host, env, redactions, `preclean-channels-stop-start-${AGENT}`);

  const docker = await dockerInfo(host, env);
  expect(docker.exitCode, resultText(docker)).toBe(0);
  const install = await installSandboxOrSkipOnRateLimit(
    host,
    env,
    redactions,
    `install-channels-stop-start-${AGENT}`,
    skip,
    "NVIDIA endpoint validation was rate-limited before channel lifecycle assertions ran",
  );
  expectExitZero(install, `${AGENT} install.sh`);
  await expectSandboxReady(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `sandbox-list-channels-stop-start-${AGENT}`,
  );

  if (!planChannel("whatsapp")) {
    await runChannelCommand(host, env, redactions, "add", "whatsapp");
    const rebuild = await rebuildSandbox(
      host,
      SANDBOX_NAME,
      env,
      redactions,
      `rebuild-add-whatsapp-${AGENT}`,
    );
    expectExitZero(rebuild, "rebuild after adding WhatsApp");
  }

  expectChannelInputs();
  for (const channel of CHANNELS) expectPlanChannelState(channel, "active");
  await expectAgentConfig(sandbox, "present", redactions);
  await expectProvidersExist(host, env, redactions, "baseline");
  for (const channel of CHANNELS) {
    expect(
      await policyPresetActive(host, env, redactions, channel),
      `${channel} policy active`,
    ).toBe(true);
  }

  for (const channel of CHANNELS) await runChannelCommand(host, env, redactions, "stop", channel);
  expectChannelInputs();
  for (const channel of CHANNELS) expectPlanChannelState(channel, "disabled");
  const stopRebuild = await rebuildSandbox(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `rebuild-stop-all-${AGENT}`,
  );
  expectExitZero(stopRebuild, "rebuild after stopping all channels");
  await expectAgentConfig(sandbox, "absent", redactions);
  await expectProvidersExist(host, env, redactions, "after-stop");
  for (const channel of CHANNELS) expectPlanChannelState(channel, "disabled");

  for (const channel of CHANNELS) await runChannelCommand(host, env, redactions, "start", channel);
  expectChannelInputs();
  for (const channel of CHANNELS) expectPlanChannelState(channel, "active");
  const startRebuild = await rebuildSandbox(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `rebuild-start-all-${AGENT}`,
  );
  expectExitZero(startRebuild, "rebuild after starting all channels");
  await expectAgentConfig(sandbox, "present", redactions);
  await expectProvidersExist(host, env, redactions, "after-start");
  for (const channel of CHANNELS) expectPlanChannelState(channel, "active");
}
