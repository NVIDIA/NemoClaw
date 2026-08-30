// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { restoreEnvBulk } from "../../../../test/helpers/env-test-helpers";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../channels";
import { MessagingWorkflowPlanner } from "../compiler";
import { createBuiltInMessagingHookRegistry } from "../hooks";
import type { SandboxMessagingPlan } from "../manifest";
import { MessagingSetupApplier } from "./setup-applier";
import type { MessagingOpenShellRunner } from "./types";

const HERMES_ENV_PATH = "/sandbox/.hermes/.env";

function planner(): MessagingWorkflowPlanner {
  return new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        getCredential: () => "telegram-token",
        saveCredential: () => {},
        prompt: async () => "unused",
        log: () => {},
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
    }),
    createBuiltInRenderTemplateResolver(),
  );
}

function buildHermesTelegramPlan(
  disabledChannels: readonly string[] = [],
): Promise<SandboxMessagingPlan> {
  return planner().buildPlan({
    sandboxName: "demo",
    agent: "hermes",
    workflow: "rebuild",
    isInteractive: false,
    configuredChannels: ["telegram"],
    disabledChannels,
    credentialAvailability: { "telegram.telegramBotToken": true },
  });
}

async function buildHermesWechatPlan(): Promise<SandboxMessagingPlan> {
  const original = {
    WECHAT_ACCOUNT_ID: process.env.WECHAT_ACCOUNT_ID,
    WECHAT_ALLOWED_IDS: process.env.WECHAT_ALLOWED_IDS,
  };
  process.env.WECHAT_ACCOUNT_ID = "wechat-account";
  process.env.WECHAT_ALLOWED_IDS = "wechat-user";
  try {
    return await planner().buildPlan({
      sandboxName: "demo",
      agent: "hermes",
      workflow: "rebuild",
      isInteractive: false,
      configuredChannels: ["wechat"],
      credentialAvailability: { WECHAT_BOT_TOKEN: true },
    });
  } finally {
    restoreEnvBulk(original);
  }
}

/** An in-memory sandbox filesystem behind the `cat`/write calls the applier makes. */
function sandboxFiles(seed: Readonly<Record<string, string>>): {
  readonly files: Record<string, string>;
  readonly writes: string[];
  readonly runOpenshell: MessagingOpenShellRunner;
} {
  const files: Record<string, string> = { ...seed };
  const writes: string[] = [];
  const runOpenshell: MessagingOpenShellRunner = (args, options) => {
    const target = String(args.at(-1));
    const reading = args.includes("cat") && options?.input === undefined;
    const written = options?.input;
    const write = (content: string) => {
      files[target] = content;
      writes.push(target);
      return { status: 0 };
    };
    return written !== undefined
      ? write(written)
      : reading
        ? {
            status: files[target] === undefined ? 1 : 0,
            stdout: files[target] ?? "",
          }
        : { status: 1 };
  };
  return { files, writes, runOpenshell };
}

describe("MessagingSetupApplier credential env cleanup", () => {
  it("drops a stale credential env line written in the export form", async () => {
    const plan = await buildHermesTelegramPlan();
    const { files, runOpenshell } = sandboxFiles({
      [HERMES_ENV_PATH]: [
        "export TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        "export OPERATOR_OWNED=keep-me",
        "",
      ].join("\n"),
    });

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell,
    });

    expect(files[HERMES_ENV_PATH] ?? "").not.toContain("TELEGRAM_BOT_TOKEN=");
    expect(files[HERMES_ENV_PATH] ?? "").toContain("export OPERATOR_OWNED=keep-me");
  });

  it("accepts a tab after export in a stale credential line", async () => {
    const plan = await buildHermesTelegramPlan();
    const { files, runOpenshell } = sandboxFiles({
      [HERMES_ENV_PATH]: [
        "export\tTELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        "OPERATOR_OWNED=keep-me",
        "",
      ].join("\n"),
    });

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell,
    });

    expect(files[HERMES_ENV_PATH] ?? "").not.toContain("TELEGRAM_BOT_TOKEN=");
    expect(files[HERMES_ENV_PATH] ?? "").toContain("OPERATOR_OWNED=keep-me");
  });

  it("drops a stale credential env line for a channel the plan disables", async () => {
    // A disabled channel renders nothing, so only owned-binding cleanup
    // revisits the file.
    const plan = await buildHermesTelegramPlan(["telegram"]);
    const { files, runOpenshell } = sandboxFiles({
      [HERMES_ENV_PATH]: [
        "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        "OPERATOR_OWNED=keep-me",
        "",
      ].join("\n"),
    });

    expect(plan.disabledChannels).toEqual(["telegram"]);
    expect(plan.credentialBindings.map((binding) => binding.channelId)).toEqual(["telegram"]);

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell,
    });

    expect(files[HERMES_ENV_PATH] ?? "").not.toContain("TELEGRAM_BOT_TOKEN=");
    expect(files[HERMES_ENV_PATH] ?? "").toContain("OPERATOR_OWNED=keep-me");
  });

  it("never deletes a key the channel's manifest does not declare", async () => {
    // A persisted plan is state, not authority. Deletion keys come from the
    // manifest, so a binding naming an operator key cannot remove it.
    const built = await buildHermesTelegramPlan();
    const plan = {
      ...built,
      credentialBindings: built.credentialBindings.map((binding) => ({
        ...binding,
        providerEnvKey: "OPERATOR_OWNED",
      })),
    };
    const { files, runOpenshell } = sandboxFiles({
      [HERMES_ENV_PATH]: ["OPERATOR_OWNED=keep-me", ""].join("\n"),
    });

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
      runOpenshell,
    });

    expect(files[HERMES_ENV_PATH] ?? "").toContain("OPERATOR_OWNED=keep-me");
  });

  it("repairs a legacy managed-image env file and reports that a reload is needed", async () => {
    const plan = await buildHermesTelegramPlan();
    const { files, writes, runOpenshell } = sandboxFiles({
      [HERMES_ENV_PATH]: [
        "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        "OPERATOR_OWNED=keep-me",
        "",
      ].join("\n"),
    });

    const result = MessagingSetupApplier.reconcileCredentialEnvAtOpenShell(plan, {
      runOpenshell,
    });

    expect(result).toEqual({ changed: true, target: HERMES_ENV_PATH });
    expect(writes).toEqual([HERMES_ENV_PATH]);
    expect(files[HERMES_ENV_PATH] ?? "").not.toContain("TELEGRAM_BOT_TOKEN=");
    expect(files[HERMES_ENV_PATH] ?? "").toContain("OPERATOR_OWNED=keep-me");
  });

  it("does not rewrite an already reconciled managed-image env file", async () => {
    const plan = await buildHermesTelegramPlan();
    const { writes, runOpenshell } = sandboxFiles({
      [HERMES_ENV_PATH]: ["OPERATOR_OWNED=keep-me", ""].join("\n"),
    });

    const result = MessagingSetupApplier.reconcileCredentialEnvAtOpenShell(plan, {
      runOpenshell,
    });

    expect(result).toEqual({ changed: false });
    expect(writes).toEqual([]);
  });

  it("rematerializes a manifest cross-key alias from OpenShell's revision placeholder", async () => {
    const plan = await buildHermesWechatPlan();
    const {
      files,
      writes,
      runOpenshell: runFiles,
    } = sandboxFiles({
      [HERMES_ENV_PATH]: ["WEIXIN_ALLOWED_USERS=wechat-user", ""].join("\n"),
    });
    const runOpenshell: MessagingOpenShellRunner = (args, options) =>
      args.some((arg) => arg.includes("printenv"))
        ? { status: 0, stdout: "openshell:resolve:env:v7_WECHAT_BOT_TOKEN\n" }
        : runFiles(args, options);

    const result = MessagingSetupApplier.reconcileCredentialEnvAtOpenShell(plan, {
      runOpenshell,
    });

    expect(result).toEqual({ changed: true, target: HERMES_ENV_PATH });
    expect(writes).toEqual([HERMES_ENV_PATH]);
    expect(files[HERMES_ENV_PATH]).toContain(
      "WEIXIN_TOKEN=openshell:resolve:env:v7_WECHAT_BOT_TOKEN",
    );
  });

  it("never persists a raw value returned for a manifest cross-key alias", async () => {
    const plan = await buildHermesWechatPlan();
    const {
      files,
      writes,
      runOpenshell: runFiles,
    } = sandboxFiles({
      [HERMES_ENV_PATH]: [
        "WEIXIN_TOKEN=openshell:resolve:env:v6_WECHAT_BOT_TOKEN",
        "WEIXIN_ALLOWED_USERS=wechat-user",
        "",
      ].join("\n"),
    });
    const runOpenshell: MessagingOpenShellRunner = (args, options) =>
      args.some((arg) => arg.includes("printenv"))
        ? { status: 0, stdout: "raw-secret-value\n" }
        : runFiles(args, options);

    const result = MessagingSetupApplier.reconcileCredentialEnvAtOpenShell(plan, {
      runOpenshell,
    });

    expect(result).toEqual({ changed: true, target: HERMES_ENV_PATH });
    expect(writes).toEqual([HERMES_ENV_PATH]);
    expect(files[HERMES_ENV_PATH]).not.toContain("WEIXIN_TOKEN=");
    expect(files[HERMES_ENV_PATH]).not.toContain("raw-secret-value");
  });
});
