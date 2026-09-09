// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Credential env cleanup in the in-sandbox applier: a credential line an older
// install left in ~/.hermes/.env shadows the value OpenShell injects, because
// Hermes loads that file with override=True.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMessagingAgentRenderToLocalFiles,
  type MessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { withLegacyMessagingPlanEnvDirect } from "../../messaging-plan-test-helper";

const TEST_PATH = process.env.PATH || "/usr/bin:/bin";
const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "../../..",
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);

function channelsB64(channels: string[]): string {
  return Buffer.from(JSON.stringify(channels)).toString("base64");
}

function planB64(plan: unknown): string {
  return Buffer.from(JSON.stringify(plan)).toString("base64");
}

function runApplierProcess(
  env: Record<string, string>,
  agent: "hermes" | "openclaw",
  phase: MessagingBuildPhase,
) {
  return spawnSync(
    "node",
    ["--experimental-strip-types", SCRIPT_PATH, "--agent", agent, "--phase", phase],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env, timeout: 10_000 },
  );
}

describe("messaging-build-applier.mts: credential env cleanup", () => {
  it("removes a stale Hermes credential line left by an older install", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-stale-env-"));
    try {
      const hermesDir = path.join(tmp, ".hermes");
      fs.mkdirSync(hermesDir, { recursive: true });
      fs.writeFileSync(
        path.join(hermesDir, "config.yaml"),
        ["_config_version: 12", "platforms:", "  api_server:", "    enabled: true", ""].join("\n"),
      );
      // What a pre-0.0.106 install left behind, in both dotenv forms.
      fs.writeFileSync(
        path.join(hermesDir, ".env"),
        [
          "API_SERVER_PORT=18642",
          "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          "export DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN",
          "OPERATOR_OWNED=keep-me",
          "",
        ].join("\n"),
      );
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: TEST_PATH,
          HOME: tmp,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram", "discord"]),
        },
        "hermes",
      );
      const postInstallResult = runApplierProcess(env, "hermes", "post-agent-install");
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);
      const envFile = fs.readFileSync(path.join(hermesDir, ".env"), "utf-8");
      expect(envFile).not.toContain("TELEGRAM_BOT_TOKEN=");
      expect(envFile).not.toContain("DISCORD_BOT_TOKEN=");
      expect(envFile).toContain("API_SERVER_PORT=18642");
      expect(envFile).toContain("OPERATOR_OWNED=keep-me");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prunes a credential line a plan encoded before the policy binding still renders", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-legacy-render-"));
    // A plan persisted before the credential moved to a policy binding. Rebuild
    // carries agentRender forward untouched, so the token render outlives the
    // manifest that produced it.
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "hermes",
      channels: [{ channelId: "telegram", active: true }],
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "telegramBotToken",
          sourceInput: "botToken",
          providerName: "test-sandbox-telegram-bridge",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialAvailable: true,
        },
      ],
      agentRender: [
        {
          channelId: "telegram",
          agent: "hermes",
          target: "~/.hermes/.env",
          kind: "env-lines",
          renderId: "telegram-hermes-env",
          lines: ["TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN"],
        },
      ],
      buildSteps: [],
    };

    try {
      fs.mkdirSync(path.join(tmp, ".hermes"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".hermes", ".env"),
        [
          "API_SERVER_PORT=18642",
          "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          "",
        ].join("\n"),
      );
      const serializedPlan = readMessagingBuildPlanFromEnv(
        { NEMOCLAW_MESSAGING_PLAN_B64: planB64(plan) },
        "hermes",
      );

      applyMessagingAgentRenderToLocalFiles(serializedPlan, { homeDir: tmp });

      const envFile = fs.readFileSync(path.join(tmp, ".hermes", ".env"), "utf-8");
      expect(envFile).not.toContain("TELEGRAM_BOT_TOKEN=");
      expect(envFile).toContain("API_SERVER_PORT=18642");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps a credential line the current manifests still render", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-assigned-render-"));
    // wechat renders its credential under a different key than the provider env
    // key, so pruning must read the manifest assignment, not the provider key.
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "hermes",
      channels: [{ channelId: "wechat", active: true }],
      credentialBindings: [
        {
          channelId: "wechat",
          credentialId: "wechatBotToken",
          sourceInput: "botToken",
          providerName: "test-sandbox-wechat-bridge",
          providerEnvKey: "WECHAT_BOT_TOKEN",
          placeholder: "openshell:resolve:env:WECHAT_BOT_TOKEN",
          credentialAvailable: true,
        },
      ],
      agentRender: [
        {
          channelId: "wechat",
          agent: "hermes",
          target: "~/.hermes/.env",
          kind: "env-lines",
          renderId: "wechat-hermes-env",
          lines: ["WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN"],
        },
      ],
      buildSteps: [],
    };

    try {
      const serializedPlan = readMessagingBuildPlanFromEnv(
        { NEMOCLAW_MESSAGING_PLAN_B64: planB64(plan) },
        "hermes",
      );

      applyMessagingAgentRenderToLocalFiles(serializedPlan, { homeDir: tmp });

      const envFile = fs.readFileSync(path.join(tmp, ".hermes", ".env"), "utf-8");
      expect(envFile).toContain("WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
