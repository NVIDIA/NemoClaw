// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingPlan,
} from "../../../messaging/manifest";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../../messaging/provider-profile";
import { hashCredential } from "../../../security/credential-hash";
import { decisionSelected } from "../../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../../state/onboard-checkpoint-migrate";
import { createSession } from "../../../state/onboard-session";
import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import { reconcileSandboxMessaging } from "./sandbox-messaging";

function slackBinding(
  providerName: string,
  providerEnvKey: "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN",
  credentialHash: string,
): SandboxMessagingCredentialBindingPlan {
  const bot = providerEnvKey === "SLACK_BOT_TOKEN";
  return {
    channelId: "slack",
    credentialId: bot ? "slackBotToken" : "slackAppToken",
    sourceInput: bot ? "botToken" : "appToken",
    providerName,
    providerEnvKey,
    placeholder: `${bot ? "xoxb" : "xapp"}-OPENSHELL-RESOLVE-ENV-${providerEnvKey}`,
    credentialAvailable: true,
    credentialHash,
  };
}

function slackPlan(): SandboxMessagingPlan {
  return makeMessagingPlan({
    sandboxName: "alpha",
    agent: "openclaw",
    channels: ["slack"],
    credentialBindings: [
      slackBinding(
        "alpha-slack-bridge",
        "SLACK_BOT_TOKEN",
        hashCredential("xoxb-existing-slack-bot-token") ?? "",
      ),
      slackBinding(
        "alpha-slack-app",
        "SLACK_APP_TOKEN",
        hashCredential("xapp-existing-slack-app-token") ?? "",
      ),
    ],
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("completed messaging checkpoint provider migration", () => {
  it("normalizes legacy Slack bindings before gateway probes", async () => {
    const currentPlan = slackPlan();
    const legacyPlan = {
      ...currentPlan,
      credentialBindings: currentPlan.credentialBindings.map((binding) =>
        binding.providerEnvKey === "SLACK_APP_TOKEN"
          ? { ...binding, providerName: "alpha-slack-bridge" }
          : binding,
      ),
    };
    const session = createSession({ sandboxName: "alpha", messagingPlan: legacyPlan });
    session.stagedCredentialProviders = ["alpha-slack-bridge", "alpha-slack-app"];
    session.checkpoint = {
      ...deriveCheckpointFromSession(session),
      messaging: decisionSelected({ selectedChannels: ["slack"], disabledChannels: [] }),
    };
    const providerMatchesGatewayCredential = vi.fn(() => true);
    const setupMessagingChannels = vi.fn(async () => ["slack"]);
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps: {
        note: vi.fn(),
        showMessagingStage: vi.fn(),
        getRecordedMessagingChannelsForResume: vi.fn(() => null),
        setupMessagingChannels,
        readMessagingPlanFromEnv: vi.fn(() => null),
        writePlanToEnv: vi.fn(),
        clearPlanEnv: vi.fn(),
        getRegistrySandboxMessagingAuthority: vi.fn(() => ({
          authoritative: false,
          plan: null,
        })),
        inspectGatewayCredential: vi.fn(() => ({ kind: "missing" as const })),
        providerMatchesGatewayCredential,
      },
    });

    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "alpha-slack-bridge",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "SLACK_BOT_TOKEN",
    );
    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "alpha-slack-app",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "SLACK_APP_TOKEN",
    );
    expect(providerMatchesGatewayCredential).not.toHaveBeenCalledWith(
      "alpha-slack-bridge",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "SLACK_APP_TOKEN",
    );
    expect(setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({ plan: currentPlan, selectedChannels: ["slack"] });
  });
});
