// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

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

/** An in-memory sandbox filesystem behind the `cat`/write calls the applier makes. */
function sandboxFiles(seed: Readonly<Record<string, string>>): {
  readonly files: Record<string, string>;
  readonly runOpenshell: MessagingOpenShellRunner;
} {
  const files: Record<string, string> = { ...seed };
  const runOpenshell: MessagingOpenShellRunner = (args, options) => {
    const target = String(args.at(-1));
    const reading = args.includes("cat") && options?.input === undefined;
    const written = options?.input;
    Object.assign(files, written === undefined ? {} : { [target]: written });
    return reading
      ? { status: files[target] === undefined ? 1 : 0, stdout: files[target] ?? "" }
      : { status: written === undefined ? 1 : 0 };
  };
  return { files, runOpenshell };
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

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, { runOpenshell });

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

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, { runOpenshell });

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

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, { runOpenshell });

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

    await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, { runOpenshell });

    expect(files[HERMES_ENV_PATH] ?? "").toContain("OPERATOR_OWNED=keep-me");
  });
});
