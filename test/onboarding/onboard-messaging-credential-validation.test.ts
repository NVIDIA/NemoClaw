// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, it, vi } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../..");

beforeEach(() => {
  vi.stubEnv("NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG", "1");
  vi.stubEnv("NEMOCLAW_SANDBOX_PREBUILD", "1");
});

describe("onboard messaging credential validation", () => {
  it(
    "interactive setupMessagingChannels drops slack when app token fails appTokenFormat check (#1912)",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-slack-app-format-reject-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "slack-app-format-reject.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      // Subscript: mocks prompt to return a VALID bot token but a bogus app
      // token. Expected behavior: bot token passes the regex and persists,
      // app token fails the regex, channel is dropped from the enabled set,
      // and SLACK_APP_TOKEN is never saved.
      const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const saveCalls = [];
credentials.saveCredential = (key, value) => { saveCalls.push({ key, value }); };
credentials.getCredential = () => null;
credentials.prompt = async (message) => {
  if (message.includes("Slack Bot Token")) return "xoxb-test-valid-bot-token";
  if (message.includes("Slack App Token")) return "abcd";
  return "";
};

runner.run = () => ({ status: 0 });
runner.runCapture = () => "";

const { setupMessagingChannels, MESSAGING_CHANNELS } = require(${onboardPath});

(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;

  const result = await setupMessagingChannels();
  console.log(JSON.stringify({
    result,
    saveCalls,
    slackIndex1Based: MESSAGING_CHANNELS.findIndex((c) => c.name === "slack") + 1,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Dry run with Enter only to introspect Slack's 1-based digit.
      const introspect = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
        input: "\n",
      });
      assert.equal(introspect.status, 0, introspect.stderr);
      const slackIdx = JSON.parse(introspect.stdout.trim().split("\n").pop()!).slackIndex1Based;
      assert.ok(slackIdx >= 1, `unexpected slack index: ${slackIdx}`);

      // Real run: toggle Slack on, exit UI, bot prompt returns valid, app
      // prompt returns "abcd", app-token check rejects, channel dropped.
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
        },
        input: `${slackIdx}\n`,
      });

      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout.trim().split("\n").pop()!);

      assert.ok(
        !out.result.includes("slack"),
        `slack should have been dropped after invalid app token; got ${JSON.stringify(out.result)}`,
      );
      assert.ok(
        !out.saveCalls.some((c: { key: string }) => c.key === "SLACK_BOT_TOKEN"),
        `SLACK_BOT_TOKEN should NOT be persisted until the app token also passes; saveCalls=${JSON.stringify(out.saveCalls)}`,
      );
      assert.ok(
        !out.saveCalls.some((c: { key: string }) => c.key === "SLACK_APP_TOKEN"),
        `SLACK_APP_TOKEN should NOT have been persisted (invalid format); saveCalls=${JSON.stringify(out.saveCalls)}`,
      );
      assert.ok(
        result.stderr.includes("Invalid format") || result.stdout.includes("Invalid format"),
        `expected 'Invalid format' warning; stderr=${result.stderr} stdout=${result.stdout}`,
      );
    },
  );
});
