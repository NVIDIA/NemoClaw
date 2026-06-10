// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createBuiltInChannelManifestRegistry } from "../channels";
import { MessagingWorkflowPlanner } from "../compiler";
import { createBuiltInMessagingHookRegistry } from "../hooks";
import type { SandboxMessagingPlan } from "../manifest";
import { assertValidSandboxMessagingPlan } from ".";

const registry = createBuiltInChannelManifestRegistry();
const TEST_WECHAT_LOGIN = {
  token: "test-wechat-token",
  accountId: "test-wechat-account",
  baseUrl: "https://ilinkai.wechat.example",
  userId: "test-wechat-user",
} as const;

type MutablePlan = SandboxMessagingPlan & {
  disabledChannels: string[];
  credentialBindings: Array<{ providerEnvKey: string }>;
  networkPolicy: { entries: Array<{ policyKeys: string[] }> };
  agentRender: Array<{ target: string }>;
  buildSteps: Array<{ handler: string }>;
  healthChecks: Array<{ hookIds: string[] }>;
};

function planner(): MessagingWorkflowPlanner {
  return new MessagingWorkflowPlanner(
    registry,
    createBuiltInMessagingHookRegistry({
      common: {
        env: {},
        getCredential: () => null,
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
          env: {},
          log: () => {},
          saveCredential: () => {},
          runLogin: async () => ({
            kind: "ok",
            credentials: TEST_WECHAT_LOGIN,
          }),
        },
        seedOpenClawAccount: {
          now: () => "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );
}

function cloneMutablePlan(plan: SandboxMessagingPlan): MutablePlan {
  return JSON.parse(JSON.stringify(plan)) as MutablePlan;
}

async function validPlan(): Promise<SandboxMessagingPlan> {
  return planner().buildPlan({
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "onboard",
    isInteractive: false,
    configuredChannels: ["telegram", "slack", "wechat"],
    credentialAvailability: {
      TELEGRAM_BOT_TOKEN: true,
      SLACK_BOT_TOKEN: true,
      SLACK_APP_TOKEN: true,
      WECHAT_BOT_TOKEN: true,
    },
  });
}

function expectInvalid(plan: MutablePlan, reason: string): void {
  expect(() =>
    assertValidSandboxMessagingPlan(plan, {
      registry,
      sandboxName: "demo",
      agent: "openclaw",
    }),
  ).toThrow(reason);
}

describe("SandboxMessagingPlan validation boundaries", () => {
  it("rejects disabled channels that are outside plan channels", async () => {
    const plan = cloneMutablePlan(await validPlan());
    plan.disabledChannels = ["discord"];

    expectInvalid(plan, "disabled channel is not in plan channels");
  });

  it("rejects credential bindings that no longer match the manifest", async () => {
    const plan = cloneMutablePlan(await validPlan());
    plan.credentialBindings[0].providerEnvKey = "OTHER_TOKEN";

    expectInvalid(plan, "credential binding is not declared by the channel manifest");
  });

  it("rejects policy entries that no longer match the manifest", async () => {
    const plan = cloneMutablePlan(await validPlan());
    plan.networkPolicy.entries[0].policyKeys = ["wildcard"];

    expectInvalid(plan, "policy entry is not declared by the channel manifest");
  });

  it("rejects render entries that no longer match the manifest", async () => {
    const plan = cloneMutablePlan(await validPlan());
    plan.agentRender[0].target = "other.json";

    expectInvalid(plan, "render entry is not declared by the channel manifest");
  });

  it("rejects build steps that no longer match a registered hook", async () => {
    const plan = cloneMutablePlan(await validPlan());
    plan.buildSteps[0].handler = "missing.handler";

    expectInvalid(plan, "build step is not declared by the channel manifest");
  });

  it("rejects health checks that no longer match the manifest", async () => {
    const plan = cloneMutablePlan(await validPlan());
    plan.healthChecks[0].hookIds = ["missing-health-hook"];

    expectInvalid(plan, "health check is not declared by the channel manifest");
  });
});
