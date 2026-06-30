// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxMessagingPlan } from "../../../src/lib/messaging/manifest";
import { hashCredential } from "../../../src/lib/security/credential-hash";
import { testTimeoutOptions } from "../../helpers/timeouts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.resolve(
  process.env.NEMOCLAW_CLI_BIN ?? path.join(REPO_ROOT, "bin", "nemoclaw.js"),
);
const CONFLICT_TIMEOUT_MS = 30_000;
const TELEGRAM_TOKEN = "123456:openclaw-channels-conflict-guard-fake-token";
const TELEGRAM_HASH =
  hashCredential(TELEGRAM_TOKEN) ??
  (() => {
    throw new Error("test fixture credential must hash");
  })();

const runLiveTest = shouldRunLiveE2E() ? test : test.skip;

function telegramChannelPlan(active = true): SandboxMessagingPlan["channels"][number] {
  return {
    channelId: "telegram",
    displayName: "Telegram",
    authMode: "token-paste",
    active,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks: [],
  };
}

function telegramBinding(
  sandboxName: string,
  credentialHash: string,
): SandboxMessagingPlan["credentialBindings"][number] {
  return {
    channelId: "telegram",
    credentialId: "telegramBotToken",
    sourceInput: "botToken",
    providerName: `${sandboxName}-telegram-bridge`,
    providerEnvKey: "TELEGRAM_BOT_TOKEN",
    placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    credentialAvailable: true,
    credentialHash,
  };
}

function telegramPlan(sandboxName: string, credentialHash: string): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [telegramChannelPlan()],
    disabledChannels: [],
    credentialBindings: [telegramBinding(sandboxName, credentialHash)],
    networkPolicy: {
      presets: ["telegram"],
      entries: [
        {
          channelId: "telegram",
          presetName: "telegram",
          policyKeys: ["telegram_bot"],
          source: "manifest",
        },
      ],
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function writeConflictRegistry(homeDir: string): string {
  const registryDir = path.join(homeDir, ".nemoclaw");
  const registryFile = path.join(registryDir, "sandboxes.json");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify(
      {
        defaultSandbox: "alpha",
        sandboxes: {
          alpha: {
            name: "alpha",
            createdAt: "2026-01-01T00:00:00.000Z",
            gpuEnabled: false,
            policies: [],
            agent: "openclaw",
            gatewayName: "nemoclaw",
          },
          bob: {
            name: "bob",
            createdAt: "2026-01-01T00:00:01.000Z",
            gpuEnabled: false,
            policies: ["telegram"],
            agent: "openclaw",
            gatewayName: "nemoclaw",
            messaging: {
              schemaVersion: 1,
              plan: telegramPlan("bob", TELEGRAM_HASH),
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return registryFile;
}

function commandEnv(homeDir: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    ["PATH", "Path", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "SystemRoot"].flatMap((key) => {
      const value = process.env[key];
      return typeof value === "string" ? [[key, value]] : [];
    }),
  );
  return {
    ...inherited,
    HOME: homeDir,
    NO_COLOR: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
    OPENSHELL_GATEWAY: "nemoclaw",
    TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
  };
}

runLiveTest(
  "openclaw channels conflict guard aborts duplicate Telegram credentials without leaking secrets",
  testTimeoutOptions(CONFLICT_TIMEOUT_MS),
  async ({ artifacts, host }) => {
    artifacts.addRedactionValues([TELEGRAM_TOKEN, TELEGRAM_HASH]);
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      `NemoClaw CLI entrypoint missing: ${CLI_ENTRYPOINT}`,
    ).toBe(true);

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-conflict-guard-"));
    try {
      const registryFile = writeConflictRegistry(homeDir);
      const before = fs.readFileSync(registryFile, "utf8");
      await artifacts.writeJson("openclaw-channels-conflict-guard-seed.json", {
        registryFile,
        currentSandbox: "alpha",
        conflictingSandbox: "bob",
        channel: "telegram",
        credentialHashChars: TELEGRAM_HASH.length,
      });

      const add = await host.command(
        process.execPath,
        [CLI_ENTRYPOINT, "alpha", "channels", "add", "telegram"],
        {
          artifactName: "channels-add-telegram-conflict-guard",
          cwd: REPO_ROOT,
          env: commandEnv(homeDir),
          redactionValues: [TELEGRAM_TOKEN, TELEGRAM_HASH],
          timeoutMs: CONFLICT_TIMEOUT_MS,
        },
      );
      const output = resultText(add);

      expect(add.timedOut).toBe(false);
      expect(add.signal).toBeNull();
      expect(add.exitCode).toBe(1);
      expect(output).toContain("Sandbox 'bob' uses the same telegram credential");
      expect(output).toContain("Aborting");
      expect(output).toContain("--force");
      expect(output).toContain("channels remove telegram");
      expect(output).not.toContain(TELEGRAM_TOKEN);
      expect(output).not.toContain(TELEGRAM_HASH);
      expect(output).not.toContain("[REDACTED]");

      const after = fs.readFileSync(registryFile, "utf8");
      expect(after).toBe(before);
      const parsed = JSON.parse(after) as {
        sandboxes?: {
          alpha?: { messaging?: unknown };
          bob?: { messaging?: unknown };
        };
      };
      expect(parsed.sandboxes?.alpha?.messaging).toBeUndefined();
      expect(parsed.sandboxes?.bob?.messaging).toBeDefined();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  },
);
