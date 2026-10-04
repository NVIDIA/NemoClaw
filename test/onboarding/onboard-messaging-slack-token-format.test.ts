// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

async function loadSlackChannel() {
  const onboardPath = path.join(repoRoot, "src", "lib", "onboard.ts");
  const onboardUrl = `${pathToFileURL(onboardPath).href}?update=${Date.now()}`;
  const { MESSAGING_CHANNELS } = await import(onboardUrl);
  const slack = MESSAGING_CHANNELS.find((channel: { name: string }) => channel.name === "slack");
  assert.ok(slack, "slack messaging channel definition present");
  return slack;
}

describe("onboard Slack token formats", () => {
  it("defines Slack bot and app token format guidance (#1912)", async () => {
    const slack = await loadSlackChannel();

    assert.ok(slack.tokenFormat instanceof RegExp, "slack.tokenFormat is a regex");
    assert.ok(
      typeof slack.tokenFormatHint === "string" && slack.tokenFormatHint.length > 0,
      "slack.tokenFormatHint set",
    );
    assert.ok(slack.appTokenFormat instanceof RegExp, "slack.appTokenFormat is a regex");
    assert.ok(
      typeof slack.appTokenFormatHint === "string" && slack.appTokenFormatHint.length > 0,
      "slack.appTokenFormatHint set",
    );
  });

  it.each([
    "abcd",
    "",
    "xoxb",
    "xoxb-",
    "xoxp-" + "test-user-token", // gitleaks:allow
    "xapp-" + "test-app-token", // gitleaks:allow
    "Bearer xoxb-fake",
    "xoxb-fake with space",
  ])("rejects Slack bot token vector %# (#1912)", async (token) => {
    const slack = await loadSlackChannel();
    assert.ok(
      !slack.tokenFormat.test(token),
      `expected ${JSON.stringify(token)} to be rejected as Slack bot token`,
    );
  });

  it.each([
    "xoxb-test-slack-token-value",
    "xoxb-fake-bot-token",
    "xoxb-A",
    "xoxb-test_with_underscores",
    "xoxb-mix_of-hyphens_and_underscores",
  ])("accepts Slack bot token vector %# (#1912)", async (token) => {
    const slack = await loadSlackChannel();
    assert.ok(
      slack.tokenFormat.test(token),
      `expected ${JSON.stringify(token)} to be accepted as Slack bot token`,
    );
  });

  it.each([
    "abcd",
    "",
    "xapp",
    "xapp-",
    "xoxb-" + "test-bot-token", // gitleaks:allow
    "Bearer xapp-fake",
    "xapp-fake with space",
  ])("rejects Slack app token vector %# (#1912)", async (token) => {
    const slack = await loadSlackChannel();
    assert.ok(
      !slack.appTokenFormat.test(token),
      `expected ${JSON.stringify(token)} to be rejected as Slack app token`,
    );
  });

  it.each([
    "xapp-" + "1-A0000-12345-abcdef",
    "xapp-" + "test-app-token-value",
    "xapp-" + "A",
    "xapp-" + "with_underscores_and-hyphens",
  ])("accepts Slack app token vector %# (#1912)", async (token) => {
    const slack = await loadSlackChannel();
    assert.ok(
      slack.appTokenFormat.test(token),
      `expected ${JSON.stringify(token)} to be accepted as Slack app token`,
    );
  });
});
