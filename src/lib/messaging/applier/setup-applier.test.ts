// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createBuiltInChannelManifestRegistry } from "../channels";
import { FAKE_TELEGRAM_HOOK_REGISTRATIONS } from "../channels/telegram/hooks/fakes";
import { FAKE_WECHAT_HOOK_REGISTRATIONS } from "../channels/wechat/hooks/fakes";
import { MessagingWorkflowPlanner } from "../compiler";
import { MessagingHookRegistry, runMessagingHook } from "../hooks";
import { FAKE_COMMON_HOOK_REGISTRATIONS } from "../hooks/common";
import type { ChannelHookSpec } from "../manifest";
import type { SandboxMessagingPlan } from "../manifest";
import { MessagingSetupApplier } from "./setup-applier";
import { MESSAGING_SETUP_APPLIER_ENV_KEY, type MessagingOpenShellRunner } from "./types";

async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
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
    new MessagingHookRegistry([
      ...FAKE_COMMON_HOOK_REGISTRATIONS,
      ...FAKE_TELEGRAM_HOOK_REGISTRATIONS,
      ...FAKE_WECHAT_HOOK_REGISTRATIONS,
    ]),
  );
}

async function planOnboard(
  env: Readonly<Record<string, string | undefined>>,
  selectedChannels: readonly string[],
): Promise<SandboxMessagingPlan> {
  return withEnv(env, () =>
    planner().planOnboard({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: false,
      selectedChannels,
    }),
  );
}

describe("MessagingSetupApplier", () => {
  it("stores a serializable SandboxMessagingPlan in env without rejecting repeated aliases", async () => {
    const plan = await planOnboard({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
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
    expect(() => MessagingSetupApplier.encodePlan(cyclic as never)).toThrow(/cycle/);
  });

  it("lists hook requests by phase without executing hook implementations", async () => {
    const plan = await planOnboard({ WECHAT_ACCOUNT_ID: "wechat-account" }, ["wechat"]);

    expect(MessagingSetupApplier.listHookRequests(plan, "enroll")).toEqual([
      expect.objectContaining({
        sandboxName: "demo",
        channelId: "wechat",
        hookId: "wechat-host-qr",
        phase: "enroll",
        handler: "wechat.ilinkLogin",
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
  });

  it("upserts OpenShell generic providers from plan credential bindings", async () => {
    const plan = await planOnboard(
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

  it("applies agent config render plans into sandbox files through OpenShell", async () => {
    const plan = await planOnboard({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
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
      [
        "sandbox",
        "exec",
        "--name",
        "demo",
        "--",
        "cat",
        "/sandbox/.openclaw/openclaw.json",
      ],
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
    expect(openclawConfig.channels.telegram.groups["*"]).toEqual({
      requireMention: "{{telegramConfig.requireMention}}",
    });
    expect(result.appliedTargets).toEqual(["/sandbox/.openclaw/openclaw.json"]);
    expect(result.appliedHooks).toEqual([]);
    expect(result.unresolvedTemplateRefs).toEqual(
      expect.arrayContaining(["proxyUrl", "telegramConfig.requireMention"]),
    );
  });

  it("runs post-install hook implementations and writes their build-file outputs", async () => {
    const plan = await planOnboard(
      {
        WECHAT_ACCOUNT_ID: "wechat-account",
        WECHAT_BASE_URL: "https://ilinkai.wechat.example",
        WECHAT_USER_ID: "wechat-user",
      },
      ["wechat"],
    );
    const registry = new MessagingHookRegistry(FAKE_WECHAT_HOOK_REGISTRATIONS);
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

    expect(JSON.parse(files["/sandbox/.openclaw/openclaw-weixin/accounts.json"] ?? "[]")).toEqual(
      ["wechat-account"],
    );
    expect(
      JSON.parse(
        files["/sandbox/.openclaw/openclaw-weixin/accounts/wechat-account.json"] ?? "{}",
      ),
    ).toMatchObject({
      token: "openshell:resolve:env:WECHAT_BOT_TOKEN",
      baseUrl: "https://ilinkai.wechat.example",
      userId: "wechat-user",
    });
    const openclawConfig = JSON.parse(files["/sandbox/.openclaw/openclaw.json"] ?? "{}");
    expect(openclawConfig.plugins.entries.acpx.enabled).toBe(false);
    expect(openclawConfig.plugins.entries["openclaw-weixin"].enabled).toBe(true);
    expect(openclawConfig.plugins.installs["openclaw-weixin"].spec).toBe(
      "@tencent-weixin/openclaw-weixin@2.4.2",
    );
    expect(openclawConfig.plugins.load.paths).toEqual([
      "/sandbox/.openclaw/extensions/openclaw-weixin",
    ]);
    expect(openclawConfig.channels["openclaw-weixin"].accounts["wechat-account"]).toEqual({
      enabled: true,
    });
    expect(result.appliedTargets).toEqual([
      "/sandbox/.openclaw/openclaw-weixin/accounts.json",
      "/sandbox/.openclaw/openclaw-weixin/accounts/wechat-account.json",
      "/sandbox/.openclaw/openclaw.json",
    ]);
    expect(result.appliedHooks).toEqual(["wechat:wechat-seed-openclaw-account"]);
  });

  it("applies policy presets directly from the serializable plan", async () => {
    const plan = await planOnboard({ TELEGRAM_BOT_TOKEN: "123456:telegram-token" }, [
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
    });
  });
});
