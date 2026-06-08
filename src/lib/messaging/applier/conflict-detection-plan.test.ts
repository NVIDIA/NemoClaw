// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  makePlan,
  slackBindings,
  slackChannel,
  tgBinding,
  tgChannel,
  whatsappChannel,
} from "../../../../test/helpers/messaging-conflict-fixtures";
import {
  getActiveChannelIdsFromPlan,
  getCredentialHashesFromPlan,
  planToConflictChannelRequests,
} from "./conflict-detection";

describe("getActiveChannelIdsFromPlan", () => {
  it("returns active channel ids", () => {
    const plan = makePlan("sb", { channels: [tgChannel(true, false)] });
    expect(getActiveChannelIdsFromPlan(plan)).toEqual(["telegram"]);
  });

  it("excludes disabled and inactive channels", () => {
    expect(
      getActiveChannelIdsFromPlan(
        makePlan("sb", { disabledChannels: ["telegram"], channels: [tgChannel(true, false)] }),
      ),
    ).toEqual([]);
    expect(getActiveChannelIdsFromPlan(makePlan("sb", { channels: [tgChannel(true, true)] }))).toEqual([]);
    expect(getActiveChannelIdsFromPlan(makePlan("sb", { channels: [tgChannel(false, false)] }))).toEqual([]);
  });
});

describe("getCredentialHashesFromPlan", () => {
  it("returns hashes keyed by providerEnvKey", () => {
    const plan = makePlan("sb", { credentialBindings: [tgBinding("hash-x")] });
    expect(getCredentialHashesFromPlan(plan)).toEqual({ TELEGRAM_BOT_TOKEN: "hash-x" });
  });

  it("scopes to a single channel when channelId is provided", () => {
    const plan = makePlan("sb", {
      credentialBindings: [tgBinding("hash-tg"), ...slackBindings("hash-bot", "hash-app")],
    });
    expect(getCredentialHashesFromPlan(plan, "telegram")).toEqual({
      TELEGRAM_BOT_TOKEN: "hash-tg",
    });
    expect(getCredentialHashesFromPlan(plan, "slack")).toEqual({
      SLACK_BOT_TOKEN: "hash-bot",
      SLACK_APP_TOKEN: "hash-app",
    });
  });

  it("omits bindings without a credentialHash", () => {
    const plan = makePlan("sb", { credentialBindings: [tgBinding()] });
    expect(getCredentialHashesFromPlan(plan)).toEqual({});
  });
});

describe("planToConflictChannelRequests", () => {
  it("returns one request per active channel that has a credential available", () => {
    const plan = makePlan("sb", {
      channels: [tgChannel()],
      credentialBindings: [tgBinding("hash-tg")],
    });
    expect(planToConflictChannelRequests(plan)).toEqual([
      { channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg" } },
    ]);
  });

  it("includes available credentials without a hash for unknown-token fallback", () => {
    const requests = planToConflictChannelRequests(
      makePlan("sb", { channels: [tgChannel()], credentialBindings: [tgBinding()] }),
    );
    expect(requests).toEqual([{ channel: "telegram", credentialHashes: {} }]);
  });

  it("groups multiple bindings for the same channel", () => {
    const plan = makePlan("sb", {
      channels: [slackChannel()],
      credentialBindings: slackBindings("hash-bot", "hash-app"),
    });
    expect(planToConflictChannelRequests(plan)).toEqual([
      {
        channel: "slack",
        credentialHashes: { SLACK_BOT_TOKEN: "hash-bot", SLACK_APP_TOKEN: "hash-app" },
      },
    ]);
  });

  it("skips inactive, disabled, unavailable, and absent channel bindings", () => {
    expect(
      planToConflictChannelRequests(
        makePlan("sb", {
          channels: [tgChannel()],
          credentialBindings: [{ ...tgBinding("hash-tg"), credentialAvailable: false }],
        }),
      ),
    ).toEqual([]);
    expect(
      planToConflictChannelRequests(
        makePlan("sb", {
          disabledChannels: ["telegram"],
          channels: [tgChannel(true, true)],
          credentialBindings: [tgBinding("hash-tg")],
        }),
      ),
    ).toEqual([]);
    expect(planToConflictChannelRequests(makePlan("sb", { credentialBindings: [tgBinding("hash-tg")] }))).toEqual([]);
    expect(
      planToConflictChannelRequests(
        makePlan("sb", {
          channels: [tgChannel(false, false)],
          credentialBindings: [tgBinding("hash-tg")],
        }),
      ),
    ).toEqual([]);
  });

  it("WhatsApp no-op: empty credentials produce no conflict requests", () => {
    const plan = makePlan("sb", { channels: [whatsappChannel()], credentialBindings: [] });
    expect(planToConflictChannelRequests(plan)).toEqual([]);
  });
});
