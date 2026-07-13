// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../channels";
import { MessagingWorkflowPlanner } from "../compiler";
import { createBuiltInMessagingHookRegistry, runMessagingHook } from "../hooks";
import type {
  ChannelHookSpec,
  MessagingAgentId,
  MessagingSerializableObject,
  SandboxMessagingPlan,
} from "../manifest";
import { MessagingSetupApplier } from "./setup-applier";
import {
  MESSAGING_SETUP_APPLIER_ENV_KEY,
  type MessagingOpenShellRunner,
  type MessagingPolicyApplyContext,
} from "./types";

const TEST_CREDENTIALS: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN: "123456:test-telegram-token",
  DISCORD_BOT_TOKEN: "test-discord-token",
  WECHAT_BOT_TOKEN: "test-wechat-token",
  SLACK_BOT_TOKEN: "xoxb-test-slack-token",
  SLACK_APP_TOKEN: "xapp-test-slack-token",
  MSTEAMS_APP_PASSWORD: "test-teams-client-secret",
};

const ALL_CHANNEL_ENV = {
  TELEGRAM_BOT_TOKEN: "123456:telegram-token",
  TELEGRAM_ALLOWED_IDS: "1001,1002",
  DISCORD_BOT_TOKEN: "discord-token",
  DISCORD_SERVER_ID: "guild-1",
  DISCORD_USER_ID: "discord-user-1",
  WECHAT_BOT_TOKEN: "wechat-token",
  WECHAT_ACCOUNT_ID: "wechat-account",
  WECHAT_BASE_URL: "https://ilinkai.wechat.com",
  WECHAT_ALLOWED_IDS: "wechat-user-1,wechat-user-2",
  SLACK_BOT_TOKEN: "xoxb-slack-token",
  SLACK_APP_TOKEN: "xapp-slack-token",
  SLACK_ALLOWED_USERS: "U100,U200",
  SLACK_ALLOWED_CHANNELS: "C100,C200",
  WHATSAPP_ALLOWED_IDS: "+15550000001,+15550000002",
  MSTEAMS_APP_PASSWORD: "teams-secret",
  MSTEAMS_APP_ID: "teams-app-id",
  MSTEAMS_TENANT_ID: "teams-tenant-id",
  TEAMS_ALLOWED_USERS: "00000000-0000-0000-0000-000000000001",
  MSTEAMS_PORT: "3978",
} as const;

const ALL_CHANNELS = createBuiltInChannelManifestRegistry()
  .listAvailable({ agent: "hermes" })
  .map((manifest) => manifest.id);

async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const scopedValues = {
    NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
    ...values,
  };
  const previous = Object.fromEntries(
    Object.keys(scopedValues).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(scopedValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function planner(): MessagingWorkflowPlanner {
  return new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        getCredential: (key) => TEST_CREDENTIALS[key] ?? null,
        saveCredential: () => {},
        prompt: async () => "unused",
        log: () => {},
      },
      slack: {
        validateCredentials: {
          log: () => {},
          validateCredentials: () => ({ ok: true }),
        },
      },
      telegram: {
        fetch: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { ok: true };
          },
          async text() {
            return "";
          },
        }),
      },
      wechat: {
        ilinkLogin: {
          saveCredential: () => {},
          log: () => {},
          runLogin: async () => ({
            kind: "timeout",
          }),
        },
        seedOpenClawAccount: {
          now: () => "2026-01-01T00:00:00.000Z",
        },
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
}

async function buildOnboardPlan(
  env: Readonly<Record<string, string | undefined>>,
  configuredChannels: readonly string[],
  agent: MessagingAgentId = "openclaw",
): Promise<SandboxMessagingPlan> {
  return withEnv(env, () =>
    planner().buildPlan({
      sandboxName: "demo",
      agent,
      workflow: "onboard",
      isInteractive: false,
      configuredChannels,
    }),
  );
}

describe("MessagingSetupApplier", () => {
  it("stores a serializable SandboxMessagingPlan in env without rejecting repeated aliases", async () => {
    const plan = await buildOnboardPlan({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
      "telegram",
    ]);
    const repeated = { value: "same" };
    const planWithAlias = {
      ...plan,
      agentRender: [
        {
          channelId: "telegram",
          kind: "json-fragment",
          agent: "openclaw",
          target: "openclaw.json",
          path: "x",
          value: [repeated, repeated],
          templateRefs: [],
        },
      ],
    } satisfies SandboxMessagingPlan;
    const env: NodeJS.ProcessEnv = {};

    MessagingSetupApplier.writePlanToEnv(planWithAlias, { env });

    const decoded = MessagingSetupApplier.readPlanFromEnv({ env });
    expect(env[MESSAGING_SETUP_APPLIER_ENV_KEY]).toBeTruthy();
    expect(decoded?.sandboxName).toBe("demo");
    expect(decoded?.agentRender[0]).toMatchObject({
      channelId: "telegram",
      kind: "json-fragment",
    });

    const cyclic = { ...plan } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => MessagingSetupApplier.encodePlan(cyclic as never)).toThrow(/circular/i);
  });

  it("lists hook requests by phase without executing hook implementations", async () => {
    const plan = await buildOnboardPlan(
      {
        WECHAT_BOT_TOKEN: "wechat-token",
        WECHAT_ACCOUNT_ID: "wechat-account",
      },
      ["wechat"],
    );

    expect(MessagingSetupApplier.listHookRequests(plan, "enroll")).toEqual([
      expect.objectContaining({
        sandboxName: "demo",
        channelId: "wechat",
        hookId: "wechat-host-qr",
        phase: "enroll",
        handler: "wechat.ilinkLogin",
      }),
      expect.objectContaining({
        sandboxName: "demo",
        channelId: "wechat",
        hookId: "wechat-config-prompt",
        phase: "enroll",
        handler: "common.configPrompt",
      }),
    ]);
    expect(MessagingSetupApplier.listHookRequests(plan, "post-agent-install")).toEqual([
      expect.objectContaining({
        sandboxName: "demo",
        channelId: "wechat",
        hookId: "wechat-seed-openclaw-account",
        phase: "post-agent-install",
        handler: "wechat.seedOpenClawAccount",
      }),
    ]);

    const slackPlan = await buildOnboardPlan(
      {
        SLACK_BOT_TOKEN: "xoxb-slack-token",
        SLACK_APP_TOKEN: "xapp-slack-token",
      },
      ["slack"],
    );
    expect(MessagingSetupApplier.listPreEnableChecks(slackPlan)).toEqual([
      expect.objectContaining({
        channelId: "slack",
        hookId: "slack-socket-mode-gateway-conflict",
        phase: "pre-enable",
      }),
    ]);
    expect(slackPlan.runtimeSetup?.nodePreloads).toEqual([
      expect.objectContaining({
        channelId: "slack",
        module: "slack-channel-guard",
        source: "/usr/local/lib/nemoclaw/preloads/slack-channel-guard.js",
      }),
    ]);
    expect(MessagingSetupApplier.listHealthChecks(slackPlan)).toEqual([
      expect.objectContaining({
        channelId: "slack",
        hookId: "slack-openclaw-bridge-health",
        phase: "health-check",
        handler: "slack.openclawBridgeHealth",
      }),
    ]);
  });

  it("keeps shipping gateway conflicts aborting before channel enablement", async () => {
    const plans = [
      await buildOnboardPlan(
        {
          SLACK_BOT_TOKEN: "xoxb-slack-token",
          SLACK_APP_TOKEN: "xapp-slack-token",
        },
        ["slack"],
      ),
      await buildOnboardPlan(
        {
          MSTEAMS_APP_PASSWORD: "teams-secret",
          MSTEAMS_APP_ID: "teams-app-id",
          MSTEAMS_TENANT_ID: "teams-tenant-id",
        },
        ["teams"],
      ),
    ];

    for (const plan of plans) {
      const request = MessagingSetupApplier.listPreEnableChecks(plan)[0];
      expect(request?.onFailure).toBe("abort");
      await expect(
        MessagingSetupApplier.applyPreEnableChecks(plan, {
          runHook: () => {
            throw new Error(`blocked ${request?.channelId ?? "channel"}`);
          },
        }),
      ).rejects.toThrow(`blocked ${request?.channelId ?? "channel"}`);
    }
  });

  it("upserts OpenShell generic providers from plan credential bindings", async () => {
    const plan = await buildOnboardPlan(
      {
        TELEGRAM_BOT_TOKEN: "123456:telegram-token",
        SLACK_BOT_TOKEN: "xoxb-slack-token",
        SLACK_APP_TOKEN: "xapp-slack-token",
      },
      ["telegram", "slack"],
    );
    const calls: Array<{
      args: readonly string[];
      env?: Readonly<Record<string, string>>;
    }> = [];
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      calls.push({ args, env: options?.env });
      if (args[0] === "provider" && args[1] === "get") {
        return { status: args[2] === "demo-slack-bridge" ? 0 : 1 };
      }
      return { status: 0 };
    };

    const result = MessagingSetupApplier.applyCredentialsAtOpenShell(plan, {
      env: {
        TELEGRAM_BOT_TOKEN: "123456:telegram-token",
        SLACK_BOT_TOKEN: "xoxb-slack-token",
        SLACK_APP_TOKEN: "xapp-slack-token",
      },
      runOpenshell,
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["provider", "get", "demo-telegram-bridge"],
      [
        "provider",
        "create",
        "--name",
        "demo-telegram-bridge",
        "--type",
        "generic",
        "--credential",
        "TELEGRAM_BOT_TOKEN",
      ],
      ["provider", "get", "demo-slack-bridge"],
      ["provider", "update", "demo-slack-bridge", "--credential", "SLACK_BOT_TOKEN"],
      ["provider", "get", "demo-slack-app"],
      [
        "provider",
        "create",
        "--name",
        "demo-slack-app",
        "--type",
        "generic",
        "--credential",
        "SLACK_APP_TOKEN",
      ],
    ]);
    expect(calls[1]?.env).toEqual({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" });
    expect(result.upserted.map((entry) => `${entry.action}:${entry.providerName}`)).toEqual([
      "create:demo-telegram-bridge",
      "update:demo-slack-bridge",
      "create:demo-slack-app",
    ]);
    expect(result.sandboxCreateProviderArgs).toEqual([
      "--provider",
      "demo-telegram-bridge",
      "--provider",
      "demo-slack-bridge",
      "--provider",
      "demo-slack-app",
    ]);
    expect(JSON.stringify(result)).not.toContain("telegram-token");
    expect(JSON.stringify(result)).not.toContain("slack-token");
  });

  it("redacts OpenShell provider failure output", async () => {
    const plan = await buildOnboardPlan({ TELEGRAM_BOT_TOKEN: "tokensecretvalue" }, ["telegram"]);
    const runOpenshell: MessagingOpenShellRunner = (args) => {
      if (args[0] === "provider" && args[1] === "get") {
        return { status: 1 };
      }
      return {
        status: 1,
        stderr: "provider rejected TELEGRAM_BOT_TOKEN=tokensecretvalue",
      };
    };

    let message = "";
    try {
      MessagingSetupApplier.applyCredentialsAtOpenShell(plan, {
        env: { TELEGRAM_BOT_TOKEN: "tokensecretvalue" },
        runOpenshell,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("TELEGRAM_BOT_TOKEN=toke");
    expect(message).not.toContain("tokensecretvalue");
  });

  it("applies agent config render plans into sandbox files through OpenShell", async () => {
    const plan = await buildOnboardPlan({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
      "telegram",
    ]);
    const files: Record<string, string> = {
      "/sandbox/.openclaw/openclaw.json": JSON.stringify({
        agents: {
          list: ["default"],
        },
      }),
    };
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      calls.push({ args, input: options?.input });
      const target = String(args.at(-1));
      if (args.includes("cat") && !options?.input) {
        return { status: files[target] === undefined ? 1 : 0, stdout: files[target] ?? "" };
      }
      if (options?.input !== undefined) {
        files[target] = options.input;
        return { status: 0 };
      }
      return { status: 1 };
    };

    const result = await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell,
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["sandbox", "exec", "--name", "demo", "--", "cat", "/sandbox/.openclaw/openclaw.json"],
      [
        "sandbox",
        "exec",
        "--name",
        "demo",
        "--",
        "sh",
        "-c",
        'mkdir -p "$(dirname "$1")" && cat > "$1"',
        "sh",
        "/sandbox/.openclaw/openclaw.json",
      ],
    ]);
    expect(calls[1]?.input).toBeTruthy();
    const openclawConfig = JSON.parse(files["/sandbox/.openclaw/openclaw.json"] ?? "{}");
    expect(openclawConfig.agents.list).toEqual(["default"]);
    expect(openclawConfig.channels.telegram.accounts.default).toMatchObject({
      botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      enabled: true,
      groupPolicy: "open",
    });
    expect(openclawConfig.channels.telegram.groups).toEqual({ "*": { requireMention: true } });
    expect(result.appliedTargets).toEqual(["/sandbox/.openclaw/openclaw.json"]);
    expect(result.appliedHooks).toEqual([]);
    expect(result.unresolvedTemplateRefs).toEqual([]);
  });

  it("preserves runtime-scoped credential placeholders when reapplying render plans", async () => {
    const plan = await buildOnboardPlan({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
      "telegram",
    ]);
    const scoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN";
    const files: Record<string, string> = {
      "/sandbox/.openclaw/openclaw.json": JSON.stringify({
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: scoped,
              },
            },
          },
        },
      }),
    };
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      const target = String(args.at(-1));
      if (args.includes("cat") && !options?.input) {
        return { status: files[target] === undefined ? 1 : 0, stdout: files[target] ?? "" };
      }
      if (options?.input !== undefined) {
        files[target] = options.input;
        return { status: 0 };
      }
      return { status: 1 };
    };

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, { runOpenshell });

    const openclawConfig = JSON.parse(files["/sandbox/.openclaw/openclaw.json"] ?? "{}");
    expect(openclawConfig.channels.telegram.accounts.default).toMatchObject({
      botToken: scoped,
      enabled: true,
      groupPolicy: "open",
    });
  });

  it("renders every built-in Hermes credential and allowlist through the sandbox applier", async () => {
    const plan = await buildOnboardPlan(ALL_CHANNEL_ENV, ALL_CHANNELS, "hermes");
    const files: Record<string, string> = {};
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      const target = String(args.at(-1));
      const reading = args.includes("cat") && options?.input === undefined;
      const written = options?.input;
      Object.assign(files, written === undefined ? {} : { [target]: written });
      return reading
        ? { status: files[target] === undefined ? 1 : 0, stdout: files[target] ?? "" }
        : { status: written === undefined ? 1 : 0 };
    };

    const credentialResult = MessagingSetupApplier.applyCredentialsAtOpenShell(plan, {
      env: ALL_CHANNEL_ENV,
      runOpenshell: (args) =>
        args[0] === "provider" && args[1] === "get" ? { status: 1 } : { status: 0 },
    });
    const policyResult = MessagingSetupApplier.applyPolicyAtOpenShell(plan, {
      applyPresets: (_sandboxName, presetNames, context) => {
        expect(presetNames).toEqual(ALL_CHANNELS);
        expect(context.entries.map((entry) => entry.channelId)).toEqual(ALL_CHANNELS);
        return true;
      },
    });
    const renderResult = await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell,
    });

    expect(credentialResult.providerNames).toEqual([
      "demo-telegram-bridge",
      "demo-discord-bridge",
      "demo-wechat-bridge",
      "demo-slack-bridge",
      "demo-slack-app",
      "demo-teams-bridge",
    ]);
    expect(policyResult.appliedPresets).toEqual(ALL_CHANNELS);
    expect(policyResult.appliedPolicyKeys).toEqual([
      "telegram",
      "discord",
      "wechat_bridge",
      "slack",
      "whatsapp",
      "teams",
    ]);
    expect(renderResult.appliedTargets).toEqual([
      "/sandbox/.hermes/.env",
      "/sandbox/.hermes/config.yaml",
    ]);

    const renderedEnv = files["/sandbox/.hermes/.env"] ?? "";
    expect(renderedEnv.split("\n")).toEqual(
      expect.arrayContaining([
        "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        "TELEGRAM_ALLOWED_USERS=1001,1002",
        "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN",
        "NEMOCLAW_DISCORD_GUILD_IDS=guild-1",
        "DISCORD_ALLOWED_USERS=discord-user-1",
        "WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN",
        "WEIXIN_ALLOWED_USERS=wechat-user-1,wechat-user-2",
        "SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        "SLACK_APP_TOKEN=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
        "SLACK_ALLOWED_USERS=U100,U200",
        "SLACK_ALLOWED_CHANNELS=C100,C200",
        "WHATSAPP_ALLOWED_USERS=+15550000001,+15550000002",
        "TEAMS_CLIENT_SECRET=openshell:resolve:env:MSTEAMS_APP_PASSWORD",
        "TEAMS_ALLOWED_USERS=00000000-0000-0000-0000-000000000001",
      ]),
    );
    expect(renderedEnv).not.toContain("telegram-token");
    expect(renderedEnv).not.toContain("discord-token");
    expect(renderedEnv).not.toContain("wechat-token");
    expect(renderedEnv).not.toContain("teams-secret");

    const renderedConfig = YAML.parse(files["/sandbox/.hermes/config.yaml"] ?? "{}") as {
      platforms?: Record<string, { enabled?: boolean }>;
    };
    expect(renderedConfig.platforms).toMatchObject({
      telegram: { enabled: true },
      discord: { enabled: true },
      weixin: { enabled: true },
      slack: { enabled: true },
      whatsapp: { enabled: true },
      teams: { enabled: true },
    });
  });

  it("excludes disabled channels at the applier boundary", async () => {
    const plan = await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "123456:telegram-token",
        SLACK_BOT_TOKEN: "xoxb-slack-token",
        SLACK_APP_TOKEN: "xapp-slack-token",
      },
      () =>
        planner().buildPlan({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "rebuild",
          isInteractive: false,
          configuredChannels: ["telegram", "slack"],
          disabledChannels: ["telegram"],
        }),
    );
    expect(plan.disabledChannels).toEqual(["telegram"]);
    expect(plan.credentialBindings.map((binding) => binding.channelId)).toEqual([
      "telegram",
      "slack",
      "slack",
    ]);
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "slack",
    ]);
    expect(
      MessagingSetupApplier.listHookRequests(plan).map(
        (request) => `${request.channelId}:${request.hookId}`,
      ),
    ).toEqual([
      "slack:slack-socket-mode-gateway-conflict",
      "slack:slack-openclaw-bridge-health",
      "slack:slack-socket-mode-gateway-status",
      "slack:slack-token-paste",
      "slack:slack-config-prompt",
      "slack:slack-credential-validation",
    ]);

    const providerCalls: string[][] = [];
    const credentialResult = MessagingSetupApplier.applyCredentialsAtOpenShell(plan, {
      env: {
        TELEGRAM_BOT_TOKEN: "123456:telegram-token",
        SLACK_BOT_TOKEN: "xoxb-slack-token",
        SLACK_APP_TOKEN: "xapp-slack-token",
      },
      runOpenshell: (args) => {
        providerCalls.push([...args]);
        if (args[0] === "provider" && args[1] === "get") return { status: 1 };
        return { status: 0 };
      },
    });
    expect(providerCalls.some((args) => args.includes("demo-telegram-bridge"))).toBe(false);
    expect(credentialResult.providerNames).toEqual(["demo-slack-bridge", "demo-slack-app"]);

    const policyCalls: string[][] = [];
    const policyResult = MessagingSetupApplier.applyPolicyAtOpenShell(plan, {
      applyPresets: (sandboxName, presetNames, context) => {
        policyCalls.push([sandboxName, ...presetNames]);
        expect(context.entries.map((entry) => entry.channelId)).toEqual(["slack"]);
        return true;
      },
    });
    expect(policyCalls).toEqual([["demo", "slack"]]);
    expect(policyResult.appliedPolicyKeys).toEqual(["slack"]);

    const files: Record<string, string> = {
      "/sandbox/.openclaw/openclaw.json": "{}",
    };
    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell: (args, options) => {
        const target = String(args.at(-1));
        if (args.includes("cat") && options?.input === undefined) {
          return { status: files[target] === undefined ? 1 : 0, stdout: files[target] ?? "" };
        }
        if (options?.input !== undefined) {
          files[target] = options.input;
          return { status: 0 };
        }
        return { status: 1 };
      },
    });
    const openclawConfig = JSON.parse(files["/sandbox/.openclaw/openclaw.json"] ?? "{}");
    expect(openclawConfig.channels.telegram).toBeUndefined();
    expect(openclawConfig.channels.slack.accounts.default).toMatchObject({
      botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      appToken: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      enabled: true,
    });
  });

  it("runs post-install hook implementations and writes their build-file outputs", async () => {
    const plan = await buildOnboardPlan(
      {
        WECHAT_BOT_TOKEN: "wechat-token",
        WECHAT_ACCOUNT_ID: "wechat-account",
        WECHAT_BASE_URL: "https://ilinkai.wechat.com",
        WECHAT_USER_ID: "wechat-user",
      },
      ["wechat"],
    );
    const registry = createBuiltInMessagingHookRegistry({
      wechat: {
        seedOpenClawAccount: {
          now: () => "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const files: Record<string, string> = {
      "/sandbox/.openclaw/openclaw.json": JSON.stringify({
        plugins: {
          entries: {
            acpx: {
              enabled: false,
            },
          },
        },
      }),
    };

    const result = await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell: (args, options) => {
        const command = String(args[7] ?? "");
        const target =
          options?.input !== undefined && command.includes("chmod")
            ? String(args.at(-2))
            : String(args.at(-1));
        if (args.includes("cat") && options?.input === undefined) {
          return { status: files[target] === undefined ? 1 : 0, stdout: files[target] ?? "" };
        }
        if (options?.input !== undefined) {
          files[target] = options.input;
          return { status: 0 };
        }
        return { status: 1 };
      },
      runHook: (request) => {
        const hook = {
          id: request.hookId,
          phase: request.phase,
          handler: request.handler,
          inputs: request.inputKeys,
          outputs: request.outputs,
          onFailure: request.onFailure,
        } satisfies ChannelHookSpec;
        return runMessagingHook(hook, registry, {
          channelId: request.channelId,
          inputs: request.inputs,
        });
      },
    });

    expect(JSON.parse(files["/sandbox/.openclaw/openclaw-weixin/accounts.json"] ?? "[]")).toEqual([
      "wechat-account",
    ]);
    expect(
      JSON.parse(files["/sandbox/.openclaw/openclaw-weixin/accounts/wechat-account.json"] ?? "{}"),
    ).toMatchObject({
      token: "openshell:resolve:env:WECHAT_BOT_TOKEN",
      baseUrl: "https://ilinkai.wechat.com",
      userId: "wechat-user",
    });
    const openclawConfig = JSON.parse(files["/sandbox/.openclaw/openclaw.json"] ?? "{}");
    expect(openclawConfig.plugins.entries.acpx.enabled).toBe(false);
    expect(openclawConfig.plugins.entries["openclaw-weixin"].enabled).toBe(true);
    expect(openclawConfig.plugins.installs["openclaw-weixin"].spec).toBe(
      "@tencent-weixin/openclaw-weixin@2.4.3",
    );
    expect(openclawConfig.plugins.load?.paths ?? []).not.toContain(
      "/sandbox/.openclaw/extensions/openclaw-weixin",
    );
    expect(openclawConfig.channels["openclaw-weixin"].accounts["wechat-account"]).toEqual({
      enabled: true,
    });
    expect(result.appliedTargets).toEqual([
      "/sandbox/.openclaw/openclaw.json",
      "/sandbox/.openclaw/openclaw-weixin/accounts.json",
      "/sandbox/.openclaw/openclaw-weixin/accounts/wechat-account.json",
    ]);
    expect(result.appliedHooks).toEqual(["wechat:wechat-seed-openclaw-account"]);
  });

  it("rejects prototype-polluting build-file merge keys", async () => {
    const plan = await buildOnboardPlan(
      {
        WECHAT_BOT_TOKEN: "wechat-token",
        WECHAT_ACCOUNT_ID: "wechat-account",
      },
      ["wechat"],
    );
    const files: Record<string, string> = {
      "/sandbox/.openclaw/openclaw.json": "{}",
    };
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      const target = String(args.at(-1));
      if (args.includes("cat") && options?.input === undefined) {
        return { status: files[target] === undefined ? 1 : 0, stdout: files[target] ?? "" };
      }
      if (options?.input !== undefined) {
        files[target] = options.input;
        return { status: 0 };
      }
      return { status: 1 };
    };
    const unsafeMerges = [
      JSON.parse('{"__proto__":{"polluted":true}}'),
      JSON.parse('{"safe":{"__proto__":{"polluted":true}}}'),
    ];

    for (const unsafeMerge of unsafeMerges) {
      await expect(
        MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
          runOpenshell,
          runHook: () => ({
            outputs: {
              openclawConfigPatch: {
                kind: "build-file",
                value: {
                  path: "openclaw.json",
                  merge: unsafeMerge,
                },
              },
            },
          }),
        }),
      ).rejects.toThrow("unsafe object key '__proto__'");
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects prototype-polluting JSON render paths", async () => {
    const plan = await buildOnboardPlan({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
      "telegram",
    ]);
    const unsafePlan = {
      ...plan,
      agentRender: [
        {
          channelId: "telegram",
          kind: "json-fragment",
          agent: "openclaw",
          target: "openclaw.json",
          path: "__proto__.polluted",
          value: true,
          templateRefs: [],
        },
      ],
    } satisfies SandboxMessagingPlan;
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      if (args.includes("cat") && options?.input === undefined) {
        return { status: 0, stdout: "{}" };
      }
      return { status: 0 };
    };

    await expect(
      MessagingSetupApplier.applyAgentConfigAtOpenShell(unsafePlan, { runOpenshell }),
    ).rejects.toThrow("Messaging render path rejected unsafe object key '__proto__'");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects render targets outside the selected agent config root", async () => {
    const plan = await buildOnboardPlan({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
      "telegram",
    ]);
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      if (args.includes("cat") && options?.input === undefined) {
        return { status: 0, stdout: "{}" };
      }
      return { status: 0 };
    };
    const unsafeTargets = [
      { target: "/tmp/openclaw.json", error: "must stay inside /sandbox/.openclaw" },
      { target: "~/.openclaw/../openclaw.json", error: "must not traverse directories" },
      { target: "~/.hermes/config.yaml", error: "Cannot apply Hermes messaging target" },
    ];

    for (const { target, error } of unsafeTargets) {
      const unsafePlan = {
        ...plan,
        agentRender: [
          {
            channelId: "telegram",
            kind: "json-fragment",
            agent: "openclaw",
            target,
            path: "channels.telegram.enabled",
            value: true,
            templateRefs: [],
          },
        ],
      } satisfies SandboxMessagingPlan;

      await expect(
        MessagingSetupApplier.applyAgentConfigAtOpenShell(unsafePlan, { runOpenshell }),
      ).rejects.toThrow(error);
    }
  });

  it("rejects unsafe build-file hook output paths and modes", async () => {
    const plan = await buildOnboardPlan(
      {
        WECHAT_BOT_TOKEN: "wechat-token",
        WECHAT_ACCOUNT_ID: "wechat-account",
      },
      ["wechat"],
    );
    const runOpenshell: MessagingOpenShellRunner = (args, options) => {
      if (args.includes("cat") && options?.input === undefined) {
        return { status: 0, stdout: "{}" };
      }
      return { status: 0 };
    };
    const unsafeFiles: Array<{
      readonly value: MessagingSerializableObject;
      readonly error: string;
    }> = [
      {
        value: { path: "openclaw-weixin/accounts/../../openclaw.json", content: {} },
        error: "must not traverse directories",
      },
      {
        value: { path: "/tmp/openclaw.json", content: {} },
        error: "must be a safe relative path",
      },
      {
        value: { path: "openclaw-weixin//accounts.json", content: {} },
        error: "must not contain empty segments",
      },
      {
        value: { path: "openclaw-weixin/\u0001accounts.json", content: {} },
        error: "must be a safe relative path",
      },
      {
        value: { path: "openclaw-weixin/accounts.json", mode: "0777", content: {} },
        error: "must not be group/world writable",
      },
      {
        value: { path: "openclaw-weixin/accounts.json", mode: "u+s", content: {} },
        error: "mode must be an octal file mode",
      },
    ];

    for (const { value, error } of unsafeFiles) {
      await expect(
        MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
          runOpenshell,
          runHook: () => ({
            outputs: {
              openclawWeixinAccountFile: {
                kind: "build-file",
                value,
              },
            },
          }),
        }),
      ).rejects.toThrow(error);
    }
  });

  it("applies policy presets directly from the serializable plan", async () => {
    const plan = await buildOnboardPlan({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
      "telegram",
    ]);
    const policyCalls: string[][] = [];

    const result = MessagingSetupApplier.applyPolicyAtOpenShell(plan, {
      applyPresets: (sandboxName, presetNames) => {
        policyCalls.push([sandboxName, ...presetNames]);
        return true;
      },
    });

    expect(policyCalls).toEqual([["demo", "telegram"]]);
    expect(result).toEqual({
      appliedPresets: ["telegram"],
      appliedPolicyKeys: ["telegram_bot"],
    });
  });

  it("passes concrete policy keys for agent-aware preset application", async () => {
    const plan = await buildOnboardPlan(
      {
        TELEGRAM_BOT_TOKEN: "123456:telegram-token",
        DISCORD_BOT_TOKEN: "test-discord-token",
        WECHAT_BOT_TOKEN: "test-wechat-token",
        WECHAT_ACCOUNT_ID: "wechat-account",
        SLACK_BOT_TOKEN: "xoxb-slack-token",
        SLACK_APP_TOKEN: "xapp-slack-token",
      },
      ["telegram", "discord", "wechat", "slack"],
      "hermes",
    );
    const policyCalls: string[][] = [];
    let applyContext: MessagingPolicyApplyContext | null = null;

    const result = MessagingSetupApplier.applyPolicyAtOpenShell(plan, {
      applyPresets: (sandboxName, presetNames, context) => {
        policyCalls.push([sandboxName, ...presetNames]);
        applyContext = context;
        return true;
      },
    });

    expect(policyCalls).toEqual([["demo", "telegram", "discord", "wechat", "slack"]]);
    expect(applyContext).toEqual({
      agent: "hermes",
      entries: plan.networkPolicy.entries,
      policyKeys: ["telegram", "discord", "wechat_bridge", "slack"],
    });
    expect(result).toEqual({
      appliedPresets: ["telegram", "discord", "wechat", "slack"],
      appliedPolicyKeys: ["telegram", "discord", "wechat_bridge", "slack"],
    });
  });
});
