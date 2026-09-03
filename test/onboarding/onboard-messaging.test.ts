// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, it, vi } from "vitest";
import YAML from "yaml";

import {
  activeChannelsFromDockerfile,
  encodeMessagingPlanForChannels,
  messagingPlanLiteral,
  parseMessagingFixturePayload,
  writeCustomMessagingDockerfile,
} from "../helpers/messaging-plan-fixtures";
import { runBoundedOnboardScript } from "../helpers/onboard-child-process-harness";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  policyContent?: string;
  policyReadError?: string;
  dockerfileContent?: string;
  dockerfileReadError?: string;
  providerRevisions?: Record<string, number | undefined> | null;
  rawCredentialInEnv?: boolean;
};
const parseStdoutJson = parseMessagingFixturePayload;
const repoRoot = path.join(import.meta.dirname, "../..");
const requireForTest = createRequire(import.meta.url);
const yamlModulePath = requireForTest.resolve("yaml");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);
beforeEach(() => {
  vi.stubEnv("NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG", "1");
  vi.stubEnv("NEMOCLAW_TEST_FORWARD_SERVICE_FIXTURE", "1");
  vi.stubEnv("NEMOCLAW_SANDBOX_PREBUILD", "1");
});
describe("onboard messaging", () => {
  it(
    "creates providers for messaging tokens and attaches them to the sandbox",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-providers-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-provider-check.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const preflightPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const commands = [];
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({ sandboxName: "my-assistant" }); createdSandbox.installRuntimeObservation();
runner.run = fixtureMocks.createStatefulMessagingProviderRunner({ commands, createdSandbox });
runner.runCapture = (command) => {
  const sandboxCapture = createdSandbox.capture(command);
  if (sandboxCapture !== null) return sandboxCapture;
  if (_n(command).includes("provider get")) return "Provider: discord-bridge";
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";
childProcess.spawn = (...args) => {
  createdSandbox.create(args.flat());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  const command = _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]);
  const entry = { command, env: args[2]?.env || null };
  const policyMatch = command.match(/--policy ([^ ]+)/);
  if (policyMatch) {
    try {
      entry.policyContent = fs.readFileSync(policyMatch[1], "utf-8");
    } catch (error) {
      entry.policyReadError = String(error);
    }
  }
  commands.push(entry);
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};
const { createSandbox, setupMessagingChannels } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
  process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token-value";
  process.env.SLACK_APP_TOKEN = "xapp-test-slack-app-token-value";
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  process.env.KUBECONFIG = "/tmp/host-kubeconfig";
  process.env.SSH_AUTH_SOCK = "/tmp/host-ssh-agent.sock";
  await setupMessagingChannels(null, null, "my-assistant");
  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation([null, "gpt-5.4", "nvidia-prod", null, null, null, null, null, null, null, null, null, []], createFixture));
  console.log(JSON.stringify({
    sandboxName,
    commands,
    messagingPlanEnv: process.env.NEMOCLAW_MESSAGING_PLAN_B64,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);
      const result = runBoundedOnboardScript(scriptPath, {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = parseStdoutJson(result.stdout);

      const providerCommands = payload.commands.filter((e: CommandEntry) =>
        e.command.includes("provider create"),
      );
      const discordProvider = providerCommands.find((e: CommandEntry) =>
        e.command.includes("my-assistant-discord-bridge"),
      );
      assert.ok(discordProvider, "expected my-assistant-discord-bridge provider create command");
      assert.match(discordProvider.command, /--credential DISCORD_BOT_TOKEN/);

      const slackProvider = providerCommands.find((e: CommandEntry) =>
        e.command.includes("my-assistant-slack-bridge"),
      );
      assert.ok(slackProvider, "expected my-assistant-slack-bridge provider create command");
      assert.match(slackProvider.command, /--credential SLACK_BOT_TOKEN/);

      const telegramProvider = providerCommands.find((e: CommandEntry) =>
        e.command.includes("my-assistant-telegram-bridge"),
      );
      assert.ok(telegramProvider, "expected my-assistant-telegram-bridge provider create command");
      assert.match(telegramProvider.command, /--credential TELEGRAM_BOT_TOKEN/);

      const createCommand = payload.commands.find((e: CommandEntry) =>
        e.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.match(createCommand.command, /--provider my-assistant-discord-bridge/);
      assert.match(createCommand.command, /--provider my-assistant-slack-bridge/);
      assert.match(createCommand.command, /--provider my-assistant-telegram-bridge/);
      assert.match(createCommand.command, /--policy [^ ]*nemoclaw-initial-policy[^ ]*\.yaml/);
      assert.equal(createCommand.policyReadError, undefined);
      const policyDoc = YAML.parse(createCommand.policyContent || "") || {};
      const slackEndpointHosts = (policyDoc.network_policies?.slack?.endpoints || []).map(
        (entry: { host?: string }) => entry.host,
      );
      const slackWebsocketHosts = slackEndpointHosts
        .filter(
          (host: string | undefined) =>
            host === "wss-primary.slack.com" || host === "wss-backup.slack.com",
        )
        .sort();
      assert.deepEqual(
        slackWebsocketHosts,
        ["wss-backup.slack.com", "wss-primary.slack.com"].sort(),
      );

      assert.doesNotMatch(createCommand.command, /test-discord-token-value/);
      assert.doesNotMatch(createCommand.command, /123456:ABC-test-telegram-token/);
      assert.doesNotMatch(createCommand.command, /DISCORD_BOT_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /TELEGRAM_BOT_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /xoxb-test-slack-token-value/);
      assert.doesNotMatch(createCommand.command, /xapp-test-slack-app-token-value/);
      assert.doesNotMatch(createCommand.command, /SLACK_BOT_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /SLACK_APP_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /NEMOCLAW_MESSAGING_PLAN_B64=/);

      assert.ok(payload.messagingPlanEnv, "expected serialized messaging plan in host process env");
      const messagingPlan = JSON.parse(
        Buffer.from(payload.messagingPlanEnv, "base64").toString("utf8"),
      );
      assert.equal(messagingPlan.sandboxName, "my-assistant");
      assert.deepEqual(
        messagingPlan.channels.map((channel: { channelId: string }) => channel.channelId).sort(),
        ["discord", "slack", "telegram"].sort(),
      );
      assert.doesNotMatch(JSON.stringify(messagingPlan), /test-discord-token-value/);
      assert.doesNotMatch(JSON.stringify(messagingPlan), /123456:ABC-test-telegram-token/);

      assert.ok(createCommand.env, "expected env to be captured from spawn call");
      assert.equal(
        createCommand.env.DISCORD_BOT_TOKEN,
        undefined,
        "DISCORD_BOT_TOKEN must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.SLACK_BOT_TOKEN,
        undefined,
        "SLACK_BOT_TOKEN must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.SLACK_APP_TOKEN,
        undefined,
        "SLACK_APP_TOKEN must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.TELEGRAM_BOT_TOKEN,
        undefined,
        "TELEGRAM_BOT_TOKEN must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.NVIDIA_INFERENCE_API_KEY,
        undefined,
        "NVIDIA_INFERENCE_API_KEY must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.KUBECONFIG,
        undefined,
        "KUBECONFIG must not be in sandbox env",
      );
      assert.equal(
        createCommand.env.SSH_AUTH_SOCK,
        undefined,
        "SSH_AUTH_SOCK must not be in sandbox env",
      );

      const envString = JSON.stringify(createCommand.env);
      assert.ok(
        !envString.includes("test-discord-token-value"),
        "Discord token value must not leak into sandbox env",
      );
      assert.ok(
        !envString.includes("xoxb-test-slack-token-value"),
        "Slack bot token value must not leak into sandbox spawn env",
      );
      assert.ok(
        !envString.includes("xapp-test-slack-app-token-value"),
        "Slack app token value must not leak into sandbox spawn env",
      );
      assert.ok(
        !envString.includes("123456:ABC-test-telegram-token"),
        "Telegram token value must not leak into sandbox env",
      );
    },
  );

  it(
    "preserves Hermes Slack policy when Slack is active at sandbox create time",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-hermes-slack-"));
      try {
        const fakeBin = path.join(tmpDir, "bin");
        const customBuildDir = path.join(tmpDir, "custom-build");
        const customDockerfilePath = path.join(customBuildDir, "Dockerfile");
        const scriptPath = path.join(tmpDir, "hermes-slack-policy.js");
        const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
        const agentDefsPath = JSON.stringify(path.join(repoRoot, "src", "lib", "agent", "defs.ts"));
        const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
        const registryPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "state", "registry.ts"),
        );
        const preflightPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
        );
        const credentialsPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
        );
        const yamlPath = JSON.stringify(yamlModulePath);
        const customDockerfileArg = JSON.stringify(customDockerfilePath);

        fs.mkdirSync(fakeBin, { recursive: true });
        fs.mkdirSync(customBuildDir, { recursive: true });
        fs.writeFileSync(
          customDockerfilePath,
          "FROM scratch\nARG NEMOCLAW_MESSAGING_PLAN_B64=\nARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}\n",
        );
        writeOkOpenshell(fakeBin);

        const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const YAML = require(${yamlPath});
const { loadAgent } = require(${agentDefsPath});
require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "docker-driver-platform.ts"))}).isLinuxDockerDriverGatewayEnabled = () => false;
const nonSlackMessagingEnvKeys = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_SERVER_ID",
  "DISCORD_SERVER_IDS",
  "DISCORD_ALLOWED_IDS",
  "DISCORD_USER_ID",
  "DISCORD_REQUIRE_MENTION",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_IDS",
  "TELEGRAM_REQUIRE_MENTION",
];

const commands = [];
let registeredSandbox = null;
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({ sandboxName: "my-assistant" }); createdSandbox.installRuntimeObservation();
runner.run = fixtureMocks.createStatefulMessagingProviderRunner({ commands, createdSandbox });
runner.runCapture = (command) => {
  const sandboxCapture = createdSandbox.capture(command);
  if (sandboxCapture !== null) return sandboxCapture;
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command, {
      defaultCurlOutput: "ok",
    });
    if (mockedCapture !== null) return mockedCapture;
  }
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = (entry) => {
  registeredSandbox = entry;
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
  registerSandbox: registry.registerSandbox,
});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  createdSandbox.create(args.flat());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  const command = _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]);
  const entry = { command, env: args[2]?.env || null };
  const policyMatch = command.match(/--policy ([^ ]+)/);
  if (policyMatch) {
    entry.policyPath = policyMatch[1];
    try {
      entry.policyContent = fs.readFileSync(policyMatch[1], "utf-8");
    } catch (error) {
      entry.policyReadError = String(error);
    }
  }
  commands.push(entry);
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  for (const key of nonSlackMessagingEnvKeys) delete process.env[key];
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_AGENT = "hermes";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token-value";
  process.env.SLACK_APP_TOKEN = "xapp-test-slack-app-token-value";
  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation([null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, null, ${customDockerfileArg}, loadAgent("hermes"), null, null, null, []], createFixture));
  const createCommand = commands.find((entry) => entry.command.includes("sandbox create"));
  const parsed = YAML.parse(createCommand?.policyContent || "") || {};
  const slack = parsed.network_policies?.slack || {};
  console.log(JSON.stringify({
    sandboxName,
    createCommand: {
      command: createCommand?.command || "",
      policyPath: createCommand?.policyPath || "",
      policyReadError: createCommand?.policyReadError || null,
    },
    registeredPolicyStatePresent: "policies" in (registeredSandbox || {}),
    slackBinaryPaths: (slack.binaries || []).map((entry) => entry.path),
    slackEndpointHosts: (slack.endpoints || []).map((entry) => entry.host),
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
        fs.writeFileSync(scriptPath, script);

        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: repoRoot,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            NEMOCLAW_NON_INTERACTIVE: "1",
          },
        });
        assert.equal(result.status, 0, result.stderr);
        const payload = parseStdoutJson(result.stdout);
        assert.ok(payload.createCommand.command.includes("sandbox create"));
        assert.match(payload.createCommand.command, /--provider my-assistant-slack-bridge/);
        assert.match(payload.createCommand.command, /--provider my-assistant-slack-app/);
        assert.match(payload.createCommand.policyPath, /nemoclaw-initial-policy/);
        assert.equal(payload.createCommand.policyReadError, null);
        assert.equal(payload.registeredPolicyStatePresent, false);
        assert.deepEqual(payload.slackBinaryPaths, [
          "/usr/local/bin/hermes",
          "/usr/bin/python3*",
          "/usr/bin/python3.13",
          "/opt/hermes/.venv/bin/python3",
          "/opt/hermes/.venv/bin/python",
        ]);
        assert.ok(
          !payload.slackBinaryPaths.includes("/usr/local/bin/node"),
          "Hermes Slack policy must not be replaced by the generic Node Slack preset",
        );
        const slackWebsocketHosts = payload.slackEndpointHosts
          .filter(
            (host: string) => host === "wss-primary.slack.com" || host === "wss-backup.slack.com",
          )
          .sort();
        assert.deepEqual(
          slackWebsocketHosts,
          ["wss-backup.slack.com", "wss-primary.slack.com"].sort(),
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "publishes attached OpenShell provider state before a messaging recreate starts (#9770)",
    { timeout: 60_000 },
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-recreate-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-reuse-provider.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(path.join(repoRoot, "src/lib/state/registry.ts"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "src/lib/onboard/preflight.ts"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "src/lib/credentials/store.ts"));
      const telegramCredentialKeys = [
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_BOT_TOKEN_AGENT_A",
        "TELEGRAM_BOT_TOKEN_AGENT_B",
      ];
      const providerCredentialKeys = {
        "compatible-endpoint": ["COMPATIBLE_API_KEY"],
        "my-assistant-slack-app": ["SLACK_APP_TOKEN"],
        "my-assistant-slack-bridge": ["SLACK_BOT_TOKEN"],
        "my-assistant-telegram-bridge": telegramCredentialKeys,
      };
      const expectedProviders = Object.keys(providerCredentialKeys).sort();
      const rawGatewayCredential = "gateway-only-provider-secret";
      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);
      const script = String.raw`
const runner = require(${runnerPath}), registry = require(${registryPath}), preflight = require(${preflightPath}), credentials = require(${credentialsPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const childProcess = require("node:child_process"), { EventEmitter } = require("node:events");
const commands = [], credentialKeys = ${JSON.stringify(providerCredentialKeys)}; let registered = null;
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({ sandboxName: "my-assistant" }); createdSandbox.installRuntimeObservation();
const providers = Object.keys(credentialKeys), revisions = new Map(providers.map((name) => [name, 1])), providerGetCounts = new Map();
const rawGatewayCredential = ${JSON.stringify(rawGatewayCredential)}, gatewaySecrets = new Map(providers.map((name) => [name, rawGatewayCredential]));
registry.registerSandbox({ name: "my-assistant", messaging: { schemaVersion: 1, plan: ${messagingPlanLiteral(["slack", "telegram", "whatsapp"])} } });
runner.run = (command, opts = {}) => {
  const normalized = _n(command); commands.push({ command: normalized, env: opts.env || null });
  const profileResult = require(${onboardScriptMocksPath}).mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false); if (profileResult !== null) return profileResult;
  const providerGet = normalized.match(/provider get -g nemoclaw ([^ ]+)$/)?.[1]; if (providerGet) providerGetCounts.set(providerGet, (providerGetCounts.get(providerGet) || 0) + 1); if (providerGet === process.env.NEMOCLAW_TEST_FAIL_PROVIDER && providerGetCounts.get(providerGet) >= 4) return { status: 2, stderr: "transport unavailable" };
  if (providerGet && revisions.has(providerGet)) return { status: 0, stdout: "Name: " + providerGet + "\nType: " + (providerGet === "compatible-endpoint" ? "openai" : "nemoclaw-mcp-v1") + "\nCredential keys: " + credentialKeys[providerGet] + "\nConfig keys: " + (providerGet === "compatible-endpoint" ? "OPENAI_BASE_URL" : "<none>") + "\n" };
  const refresh = normalized.match(/provider update -g nemoclaw ([^ ]+)$/)?.[1];
  if (refresh && gatewaySecrets.has(refresh)) { if (refresh === process.env.NEMOCLAW_TEST_FAIL_PROVIDER) return { status: 1 }; revisions.set(refresh, revisions.get(refresh) + 1); return { status: 0 }; }
  if (normalized.includes("provider get")) return { status: 1 };
  return createdSandbox.run(command) ?? { status: 0 };
};
runner.runCapture = (command) => {
  const sandboxCapture = createdSandbox.capture(command);
  if (sandboxCapture !== null) return sandboxCapture;
  const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
  if (mockedCapture !== null) return mockedCapture;
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = (entry) => { registered = entry; return true; }; registry.updateSandbox = () => true; registry.setDefault = () => true; registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "compatible-endpoint",
  model: "custom/model",
  getSandbox: registry.getSandbox,
  registerSandbox: registry.registerSandbox,
});
preflight.checkPortAvailable = async () => ({ ok: true }); credentials.prompt = async () => "";
childProcess.spawn = (...args) => {
  createdSandbox.create(args.flat());
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {}; child.pid = 4242;
  const command = _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]); const attachedProviders = [...command.matchAll(/--provider ([^ ]+)/g)].map((match) => match[1]);
  commands.push({ command, providerRevisions: command.includes("sandbox create") ? Object.fromEntries(attachedProviders.map((name) => [name, revisions.get(name)])) : null, rawCredentialInEnv: Object.values(args[2]?.env || {}).includes(rawGatewayCredential) });
  process.nextTick(() => { child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n")); child.emit("close", 0); });
  return child;
};
const { createSandbox } = require(${onboardPath});
(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw"; process.env.NEMOCLAW_EXTRA_PLACEHOLDER_KEYS = "TELEGRAM_BOT_TOKEN_AGENT_A,TELEGRAM_BOT_TOKEN_AGENT_B,GITHUB_TOKEN";
  process.env.NEMOCLAW_MESSAGING_PLAN_B64 = Buffer.from(JSON.stringify(${messagingPlanLiteral(["slack", "telegram", "whatsapp"])})).toString("base64");
  Object.values(credentialKeys).forEach((key) => delete process.env[key]); delete process.env.GITHUB_TOKEN;
  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation([null, "custom/model", "compatible-endpoint", null, "my-assistant", null, ["slack", "telegram", "whatsapp"], null, null, null, null, null, []], createFixture));
  console.log(JSON.stringify({ sandboxName, commands, registered }));
})().catch((error) => { const temporaryCreateSources = require("node:fs").readdirSync(process.env.TMPDIR).filter((entry) => entry.startsWith("nemoclaw-initial-policy-") || entry.startsWith("nemoclaw-build-")); console.log(JSON.stringify({ commands, registered, error: String(error), providerRevisions: Object.fromEntries(revisions), temporaryCreateSources })); console.error(error); process.exit(1); });
`;
      fs.writeFileSync(scriptPath, script);
      const runScenario = (failedProvider?: string) =>
        spawnSync(process.execPath, [scriptPath], {
          cwd: repoRoot,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            TMPDIR: tmpDir,
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_TEST_FAIL_PROVIDER: failedProvider || "",
            ...Object.fromEntries(
              [...Object.values(providerCredentialKeys).flat(), "GITHUB_TOKEN"].map((key) => [
                key,
                "",
              ]),
            ),
          },
        });
      const result = runScenario();
      assert.equal(result.status, 0, result.stderr);
      const payload = parseStdoutJson(result.stdout);
      const commands = payload.commands as CommandEntry[];
      const createIndex = commands.findIndex(({ command }) => command.includes("sandbox create"));
      assert.notEqual(createIndex, -1, "expected sandbox create command");
      const createCommand = commands[createIndex];
      const providerRefreshes = commands
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => /\bprovider update -g nemoclaw ([^ ]+)$/.test(entry.command));
      const providerName = (command: string) =>
        command.match(/\bprovider update -g nemoclaw ([^ ]+)$/)?.[1];
      const refreshedProviders = providerRefreshes
        .map(({ entry }: { entry: CommandEntry }) => providerName(entry.command))
        .sort();
      const denied = runScenario("my-assistant-telegram-bridge");
      assert.equal(denied.status, 1);
      const deniedPayload = parseStdoutJson(denied.stdout);
      const deniedCommands = (deniedPayload.commands as CommandEntry[]).map(
        ({ command }) => command,
      );
      const deniedRefreshes = deniedCommands.map(providerName).filter(Boolean);
      const publishedBeforeCreate = providerRefreshes.every(
        ({ entry, index }) => index < createIndex && !entry.command.includes("--credential"),
      );
      const extraPlaceholderKeys = createCommand.command
        .match(/NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=([^ ]+)/)?.[1]
        ?.split(",")
        .sort();
      const registeredChannels = payload.registered?.messaging?.plan?.channels.map(
        (channel: { channelId: string }) => channel.channelId,
      );
      assert.deepEqual(refreshedProviders, expectedProviders);
      assert.equal(
        commands.some(({ command }) => command.includes("provider create")),
        false,
      );
      assert.equal(publishedBeforeCreate, true);
      assert.deepEqual(
        [...createCommand.command.matchAll(/--provider ([^ ]+)/g)].map((match) => match[1]).sort(),
        expectedProviders,
      );
      assert.deepEqual(
        createCommand.providerRevisions,
        Object.fromEntries(expectedProviders.map((provider) => [provider, 2])),
      );
      assert.deepEqual(extraPlaceholderKeys, [
        "TELEGRAM_BOT_TOKEN_AGENT_A",
        "TELEGRAM_BOT_TOKEN_AGENT_B",
      ]);
      assert.equal(createCommand.command.includes("GITHUB_TOKEN"), false);
      assert.equal(createCommand.rawCredentialInEnv, false);
      assert.deepEqual(registeredChannels, ["slack", "telegram", "whatsapp"]);
      assert.deepEqual(deniedRefreshes, []);
      assert.equal(
        Object.values(deniedPayload.providerRevisions).filter((revision) => revision === 2).length,
        0,
      );
      assert.ok(deniedCommands.every((command) => !command.includes("sandbox create")));
      assert.equal(deniedPayload.registered, null);
      assert.deepEqual(deniedPayload.temporaryCreateSources, []);
      assert.match(
        deniedPayload.error,
        /did not confirm messaging provider 'my-assistant-telegram-bridge' before sandbox creation/,
      );
      const combinedOutput = result.stdout + result.stderr + denied.stdout + denied.stderr;
      assert.equal(
        (JSON.stringify([payload, deniedPayload]) + combinedOutput).includes(rawGatewayCredential),
        false,
      );
    },
  );

  it(
    "preserves disabled channels in a custom image after a recreate so `channels start` can re-enable them (#3381)",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-disabled-channels-preserve-"),
      );
      const customDockerfileArg = JSON.stringify(writeCustomMessagingDockerfile(tmpDir));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "disabled-channels-preserve.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const preflightPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );
      const messagingPlanB64 = encodeMessagingPlanForChannels(["telegram"], ["telegram"]);

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const commands = []; let dockerfileContent;
const registerCalls = [];
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({
  sandboxName: "my-assistant",
}); createdSandbox.installRuntimeObservation();
registry.registerSandbox({
  name: "my-assistant",
  messaging: { schemaVersion: 1, plan: ${messagingPlanLiteral(["telegram"], ["telegram"])} },
});
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get -g nemoclaw my-assistant-telegram-bridge")) return { status: 0, stdout: "Name: my-assistant-telegram-bridge\nType: nemoclaw-mcp-v1\nCredential keys: TELEGRAM_BOT_TOKEN\nConfig keys: <none>\n" };
  if (normalized.includes("provider get")) return { status: 1 };
  return createdSandbox.run(command) ?? { status: 0 };
};
runner.runCapture = (command) => {
  const sandboxCapture = createdSandbox.capture(command);
  if (sandboxCapture !== null) return sandboxCapture;
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
  getSandbox: registry.getSandbox,
  registerSandbox: registry.registerSandbox,
});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  createdSandbox.create(args.flat());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  const command = _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]);
  const entry = { command, env: args[2]?.env || null };
  const dockerfileMatch = command.match(/(?:--from|-f) ([^ ]+Dockerfile)/);
  if (dockerfileMatch) {
    try {
      entry.dockerfileContent = dockerfileContent = fs.readFileSync(dockerfileMatch[1], "utf-8");
    } catch (error) {
      entry.dockerfileReadError = String(error);
    }
  }
  commands.push({ ...entry, dockerfileContent: entry.dockerfileContent ?? dockerfileContent });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

require(${onboardScriptMocksPath}).mockFreshOpenClawPluginDiscovery();
const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  delete process.env.TELEGRAM_BOT_TOKEN;
  process.env.NEMOCLAW_MESSAGING_PLAN_B64 = Buffer.from(JSON.stringify(${messagingPlanLiteral(["telegram"], ["telegram"])})).toString("base64");
  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation([null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, ["telegram"], ${customDockerfileArg}, null, null, null, null, []], createFixture));
  console.log(JSON.stringify({ sandboxName, commands, registerCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);
      const result = runBoundedOnboardScript(scriptPath, {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_SANDBOX_GPU: "0",
          NEMOCLAW_MESSAGING_PLAN_B64: messagingPlanB64,
          TELEGRAM_BOT_TOKEN: "",
        },
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const payload = parseStdoutJson(result.stdout);

      const createCommand = payload.commands.find((entry: CommandEntry) =>
        entry.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.equal(createCommand.dockerfileReadError, undefined);

      assert.deepEqual(
        activeChannelsFromDockerfile(createCommand.dockerfileContent),
        [],
        "disabled channel must not be active in the image plan",
      );
      assert.doesNotMatch(
        createCommand.command,
        /--provider my-assistant-telegram-bridge/,
        "disabled channel's bridge must not be attached to the new sandbox",
      );

      const registeredPlan = payload.registerCalls[0]?.messaging?.plan;
      assert.deepEqual(
        registeredPlan?.channels.map((channel: { channelId: string }) => channel.channelId),
        ["telegram"],
        "registry.messaging.plan must keep the disabled-but-configured channel so `channels start` can recover it",
      );
      assert.deepEqual(
        registeredPlan?.disabledChannels,
        ["telegram"],
        "registry.messaging.plan.disabledChannels must round-trip through the rebuild",
      );
    },
  );

  it(
    "bakes WhatsApp into a custom sandbox image without bridge providers when no messaging tokens are set",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-tokenless-whatsapp-"));
      try {
        const customDockerfileArg = JSON.stringify(writeCustomMessagingDockerfile(tmpDir));
        const fakeBin = path.join(tmpDir, "bin");
        const scriptPath = path.join(tmpDir, "tokenless-whatsapp.js");
        const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
        const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
        const registryPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "state", "registry.ts"),
        );
        const preflightPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
        );
        const credentialsPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
        );
        const messagingPlanB64 = encodeMessagingPlanForChannels(["whatsapp"]);

        fs.mkdirSync(fakeBin, { recursive: true });
        writeOkOpenshell(fakeBin);

        const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const commands = []; let dockerfileContent;
const registerCalls = [];
const createdSandbox = fixtureMocks.createCreatedSandboxFixture(); createdSandbox.installRuntimeObservation();
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get")) return { status: 1 };
  return createdSandbox.run(command) ?? { status: 0 };
};
runner.runCapture = (command) => {
  const createdIdentity = createdSandbox.capture(command);
  if (createdIdentity !== null) return createdIdentity;
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
  registerSandbox: registry.registerSandbox,
});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  createdSandbox.create(args.flat());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  const command = _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]);
  const entry = { command, env: args[2]?.env || null };
  const dockerfileMatch = command.match(/(?:--from|-f) ([^ ]+Dockerfile)/);
  if (dockerfileMatch) {
    try {
      entry.dockerfileContent = dockerfileContent = fs.readFileSync(dockerfileMatch[1], "utf-8");
    } catch (error) {
      entry.dockerfileReadError = String(error);
    }
  }
  commands.push({ ...entry, dockerfileContent: entry.dockerfileContent ?? dockerfileContent });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

require(${onboardScriptMocksPath}).mockFreshOpenClawPluginDiscovery();
const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("DISCORD_") || key.startsWith("SLACK_") || key.startsWith("TELEGRAM_")) {
      delete process.env[key];
    }
  }
  process.env.NEMOCLAW_MESSAGING_PLAN_B64 = Buffer.from(JSON.stringify(${messagingPlanLiteral(["whatsapp"])})).toString("base64");
  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation([null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, ["whatsapp"], ${customDockerfileArg}, null, null, null, null, []], createFixture));
  console.log(JSON.stringify({ sandboxName, commands, registerCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
        fs.writeFileSync(scriptPath, script);

        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: repoRoot,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_MESSAGING_PLAN_B64: messagingPlanB64,
          },
        });

        assert.equal(result.status, 0, result.stderr);
        const payload = parseStdoutJson(result.stdout);

        const providerMutationCommands = payload.commands.filter((entry: CommandEntry) =>
          /\bprovider (create|update)\b/.test(entry.command),
        );
        assert.equal(
          providerMutationCommands.length,
          0,
          "QR-only channel selection must not create bridge providers",
        );

        const createCommand = payload.commands.find((entry: CommandEntry) =>
          entry.command.includes("sandbox create"),
        );
        assert.ok(createCommand, "expected sandbox create command");
        assert.equal(createCommand.dockerfileReadError, undefined);
        assert.doesNotMatch(createCommand.command, /--provider \S+-bridge\b/);

        assert.deepEqual(activeChannelsFromDockerfile(createCommand.dockerfileContent), [
          "whatsapp",
        ]);
        assert.deepEqual(
          payload.registerCalls[0]?.messaging?.plan?.channels.map(
            (channel: { channelId: string }) => channel.channelId,
          ),
          ["whatsapp"],
        );
        assert.equal(payload.registerCalls[0]?.messagingChannels, undefined);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "drops WhatsApp from a rebuilt custom image when the registry marks it disabled",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-disabled-whatsapp-"));
      try {
        const customDockerfileArg = JSON.stringify(writeCustomMessagingDockerfile(tmpDir));
        const fakeBin = path.join(tmpDir, "bin");
        const scriptPath = path.join(tmpDir, "disabled-whatsapp.js");
        const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
        const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
        const registryPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "state", "registry.ts"),
        );
        const preflightPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
        );
        const credentialsPath = JSON.stringify(
          path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
        );
        const messagingPlanB64 = encodeMessagingPlanForChannels(["whatsapp"], ["whatsapp"]);

        fs.mkdirSync(fakeBin, { recursive: true });
        writeOkOpenshell(fakeBin);

        const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

registry.registerSandbox({
  name: "my-assistant",
  messaging: { schemaVersion: 1, plan: ${messagingPlanLiteral(["whatsapp"], ["whatsapp"])} },
});

const commands = []; let dockerfileContent;
const registerCalls = [];
const createdSandbox = fixtureMocks.createCreatedSandboxFixture(); createdSandbox.installRuntimeObservation();
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get")) return { status: 1 };
  return createdSandbox.run(command) ?? { status: 0 };
};
runner.runCapture = (command) => {
  const createdIdentity = createdSandbox.capture(command);
  if (createdIdentity !== null) return createdIdentity;
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
  getSandbox: registry.getSandbox,
  registerSandbox: registry.registerSandbox,
});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  createdSandbox.create(args.flat());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  const command = _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]);
  const entry = { command, env: args[2]?.env || null };
  const dockerfileMatch = command.match(/(?:--from|-f) ([^ ]+Dockerfile)/);
  if (dockerfileMatch) {
    try {
      entry.dockerfileContent = dockerfileContent = fs.readFileSync(dockerfileMatch[1], "utf-8");
    } catch (error) {
      entry.dockerfileReadError = String(error);
    }
  }
  commands.push({ ...entry, dockerfileContent: entry.dockerfileContent ?? dockerfileContent });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

require(${onboardScriptMocksPath}).mockFreshOpenClawPluginDiscovery();
const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("DISCORD_") || key.startsWith("SLACK_") || key.startsWith("TELEGRAM_")) {
      delete process.env[key];
    }
  }
  process.env.NEMOCLAW_MESSAGING_PLAN_B64 = Buffer.from(JSON.stringify(${messagingPlanLiteral(["whatsapp"], ["whatsapp"])})).toString("base64");
  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation([null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, ["whatsapp"], ${customDockerfileArg}, null, null, null, null, []], createFixture));
  console.log(JSON.stringify({ sandboxName, commands, registerCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
        fs.writeFileSync(scriptPath, script);

        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: repoRoot,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_MESSAGING_PLAN_B64: messagingPlanB64,
          },
        });

        assert.equal(result.status, 0, result.stderr);
        const payload = parseStdoutJson(result.stdout);

        const createCommand = payload.commands.find((entry: CommandEntry) =>
          entry.command.includes("sandbox create"),
        );
        assert.ok(createCommand, "expected sandbox create command");
        assert.equal(createCommand.dockerfileReadError, undefined);

        assert.deepEqual(
          activeChannelsFromDockerfile(createCommand.dockerfileContent),
          [],
          "disabled QR channel must not be active in the image plan",
        );
        const registeredPlan = payload.registerCalls[0]?.messaging?.plan;
        assert.deepEqual(
          registeredPlan?.channels.map((channel: { channelId: string }) => channel.channelId),
          ["whatsapp"],
          "registry.messaging.plan must keep the disabled QR channel so `channels start` can recover it (mirrors #3381)",
        );
        assert.deepEqual(
          registeredPlan?.disabledChannels,
          ["whatsapp"],
          "registry.messaging.plan.disabledChannels must round-trip through the rebuild",
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("aborts onboard when a messaging provider upsert fails", { timeout: 60_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-provider-fail-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "provider-upsert-fail.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const preflightPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
    );
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

runner.run = (command, opts = {}) => {
  // Fail all provider create and update calls
  if (_n(command).includes("provider")) {
    return { status: 1, stdout: "", stderr: "gateway unreachable" };
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get")) return "";
  if (_n(command).includes("sandbox list")) return "";
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  await createSandbox(null, "gpt-5.4", "nvidia-prod");
  console.log("ERROR_DID_NOT_EXIT");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.notEqual(result.status, 0, "expected non-zero exit when provider upsert fails");
    assert.ok(
      !result.stdout.includes("ERROR_DID_NOT_EXIT"),
      "onboard should have aborted before reaching sandbox create",
    );
  });

  it(
    "reuses sandbox without refreshing unselected ambient messaging providers (#10277)",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-providers-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "reuse-with-providers.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});

const commands = [];
const existingSandbox = fixtureMocks.createCreatedSandboxFixture({ lifecycleState: "created" }); existingSandbox.installRuntimeObservation();
const messagingProviderRunner = require(${onboardScriptMocksPath}).createStatefulMessagingProviderRunner({
  commands,
  createdSandbox: existingSandbox,
  initialProviders: [
    ["my-assistant-discord-bridge", "nemoclaw-mcp-v1", "DISCORD_BOT_TOKEN"],
    ["my-assistant-slack-bridge", "nemoclaw-mcp-v1", "SLACK_BOT_TOKEN"],
    ["my-assistant-slack-app", "nemoclaw-mcp-v1", "SLACK_APP_TOKEN"],
  ],
});
runner.run = messagingProviderRunner;
runner.runCapture = (command) => {
  const sandboxCapture = existingSandbox.capture(command);
  if (sandboxCapture !== null) return sandboxCapture;
  // All messaging providers already exist in gateway
  if (_n(command).includes("provider get")) return "Provider: exists";
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
};
registry.getSandbox = () => fixtureMocks.sandboxLifecycleFixture(
  { name: "my-assistant", toolDisclosure: "progressive" },
  { sandboxId: existingSandbox.state.sandboxId },
);
const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
  process.env.SLACK_APP_TOKEN = "xapp-test-slack-token";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = parseStdoutJson(result.stdout);

      assert.equal(payload.sandboxName, "my-assistant", "should reuse existing sandbox");
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox create")),
        "should NOT recreate sandbox when providers already exist in gateway",
      );
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox delete")),
        "should NOT delete sandbox when providers already exist in gateway",
      );

      // Existing gateway providers do not select messaging for this onboarding request.
      const providerUpserts = payload.commands.filter((entry: CommandEntry) =>
        entry.command.includes("provider update"),
      );
      assert.equal(
        providerUpserts.length,
        0,
        "should not refresh ambient messaging providers without a selected channel plan",
      );
    },
  );

  it(
    "filters messaging providers to only enabledChannels when provided",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-enabled-channels-filter-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "enabled-channels-filter.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const preflightPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
const createdSandbox = fixtureMocks.createCreatedSandboxFixture(); createdSandbox.installRuntimeObservation();
runner.run = require(${onboardScriptMocksPath}).createStatefulMessagingProviderRunner({
  commands,
  createdSandbox,
});
runner.runCapture = (command) => {
  const createdIdentity = createdSandbox.capture(command);
  if (createdIdentity !== null) return createdIdentity;
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  createdSandbox.create(args.flat());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token-value";
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  // Only enable telegram — discord and slack should be filtered out
  const sandboxName = await createSandbox(...fixtureMocks.sandboxCreateArgsWithVerifiedReservation([null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, ["telegram"], null, null, null, null, null, []], createFixture));
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = parseStdoutJson(result.stdout);

      // Only telegram provider should be created
      const providerCommands = payload.commands.filter((e: CommandEntry) =>
        e.command.includes("provider create"),
      );
      const telegramProvider = providerCommands.find((e: CommandEntry) =>
        e.command.includes("my-assistant-telegram-bridge"),
      );
      assert.ok(telegramProvider, "expected telegram provider to be created");

      // Discord and slack providers should NOT be created
      const discordProvider = providerCommands.find((e: CommandEntry) =>
        e.command.includes("my-assistant-discord-bridge"),
      );
      assert.ok(!discordProvider, "discord provider should be filtered out");

      const slackProvider = providerCommands.find((e: CommandEntry) =>
        e.command.includes("my-assistant-slack-bridge"),
      );
      assert.ok(!slackProvider, "slack provider should be filtered out");

      // Sandbox create should only have the telegram --provider flag
      const createCommand = payload.commands.find((e: CommandEntry) =>
        e.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.match(createCommand.command, /--provider my-assistant-telegram-bridge/);
      assert.doesNotMatch(createCommand.command, /my-assistant-discord-bridge/);
      assert.doesNotMatch(createCommand.command, /my-assistant-slack-bridge/);
    },
  );

  it(
    "does not create messaging providers from ambient credentials without a selected plan (#10277)",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-enabled-channels-empty-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "enabled-channels-empty.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );
      const preflightPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
      );
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      writeOkOpenshell(fakeBin);

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
const createdSandbox = fixtureMocks.createCreatedSandboxFixture(); createdSandbox.installRuntimeObservation();
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return createdSandbox.run(command) ?? { status: 0 };
};
runner.runCapture = (command) => {
  const createdIdentity = createdSandbox.capture(command);
  if (createdIdentity !== null) return createdIdentity;
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
}; require(${onboardScriptMocksPath}).mockDockerSandboxLifecycleReleaseFromRunner();
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture = fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
  sandboxName: "my-assistant",
  provider: "nvidia-prod",
  model: "gpt-5.4",
});
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  createdSandbox.create(args.flat());
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token-value";
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  // No selected messaging plan — ambient repository credentials are unrelated to this request.
  const sandboxName = await createSandbox(
    ...fixtureMocks.sandboxCreateArgsWithVerifiedReservation(
      [
        null,
        "gpt-5.4",
        "nvidia-prod",
        null,
        "my-assistant",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [],
      ],
      createFixture,
    ),
  );
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = parseStdoutJson(result.stdout);

      // No messaging providers should be created at all
      const providerCommands = payload.commands.filter((e: CommandEntry) =>
        e.command.includes("provider create"),
      );
      assert.equal(
        providerCommands.length,
        0,
        "no providers should be created without a selected messaging plan",
      );

      // Sandbox create should have no --provider flags for messaging bridges
      const createCommand = payload.commands.find((e: CommandEntry) =>
        e.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.doesNotMatch(createCommand.command, /discord-bridge/);
      assert.doesNotMatch(createCommand.command, /slack-bridge/);
      assert.doesNotMatch(createCommand.command, /telegram-bridge/);
    },
  );

  it(
    "non-interactive setupMessagingChannels returns channels with tokens",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-noninteractive-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-noninteractive.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
runner.run = () => ({ status: 0 });
runner.runCapture = () => "";

// Stub the manifest-driven Telegram reachability hook so this test does not
// make a real network call.
global.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, result: { id: 1, is_bot: true } }),
  text: async () => "",
});

const { setupMessagingChannels } = require(${onboardPath});

(async () => {
  // Only set telegram and slack tokens — discord should be absent
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
  process.env.SLACK_APP_TOKEN = "xapp-test-slack-app-token";
  process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";
  const result = await setupMessagingChannels();
  console.log(JSON.stringify(result));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const channels = parseStdoutJson<string[]>(result.stdout);

      // Should return only the channels that have tokens set
      assert.ok(Array.isArray(channels), "expected an array return value");
      assert.ok(channels.includes("telegram"), "expected telegram in returned channels");
      assert.ok(channels.includes("slack"), "expected slack in returned channels");
      assert.ok(!channels.includes("discord"), "discord should not be in returned channels");
    },
  );

  it(
    "non-interactive setupMessagingChannels drops Slack when live Slack API validation rejects the token",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-slack-live-reject-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-slack-live-reject.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const httpProbePath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "adapters", "http", "probe.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
runner.run = () => ({ status: 0 });
runner.runCapture = () => "";

const httpProbe = require(${httpProbePath});
httpProbe.runCurlProbe = (argv) => {
  const url = argv[argv.length - 1] || "";
  if (String(url).includes("auth.test")) {
    return {
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: '{"ok":false,"error":"invalid_auth"}',
      stderr: "",
      message: "",
    };
  }
  return {
    ok: true,
    httpStatus: 200,
    curlStatus: 0,
    body: '{"ok":true}',
    stderr: "",
    message: "",
  };
};

const { setupMessagingChannels } = require(${onboardPath});

(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = "xoxb-fake-bot-token";
  process.env.SLACK_APP_TOKEN = "xapp-fake-app-token";
  const result = await setupMessagingChannels();
  console.log(JSON.stringify(result));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const channels = parseStdoutJson<string[]>(result.stdout);

      assert.ok(Array.isArray(channels), "expected an array return value");
      assert.ok(!channels.includes("slack"), "Slack should be dropped after API rejection");
      assert.doesNotMatch(result.stdout, /xoxb-fake-bot-token/);
      assert.doesNotMatch(result.stderr, /xoxb-fake-bot-token/);
    },
  );

  it(
    "non-interactive setupMessagingChannels returns empty array when no tokens set",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-no-tokens-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-no-tokens.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
runner.run = () => ({ status: 0 });
runner.runCapture = () => "";

const { setupMessagingChannels } = require(${onboardPath});

(async () => {
  // No messaging tokens set
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  const result = await setupMessagingChannels();
  console.log(JSON.stringify(result));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
          TELEGRAM_BOT_TOKEN: "",
          DISCORD_BOT_TOKEN: "",
          SLACK_BOT_TOKEN: "",
          SLACK_APP_TOKEN: "",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const channels = parseStdoutJson<string[]>(result.stdout);

      assert.ok(Array.isArray(channels), "expected an array return value");
      assert.equal(channels.length, 0, "expected empty array when no tokens are set");
    },
  );

  it(
    "interactive setupMessagingChannels drops slack when prompted token fails tokenFormat check (#1912)",
    {
      timeout: 60_000,
    },
    async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-slack-format-reject-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "slack-format-reject.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      // Subscript: mocks credentials.prompt to return a bogus Slack token,
      // exposes MESSAGING_CHANNELS so the parent can look up the Slack toggle
      // digit, and asserts that setupMessagingChannels rejects the invalid
      // token without persisting it. Slack is the 3rd channel in insertion
      // order today (telegram, discord, slack) but we compute the index
      // dynamically to avoid a brittle coupling to that ordering.
      const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const saveCalls = [];
credentials.saveCredential = (key, value) => { saveCalls.push({ key, value }); };
credentials.getCredential = () => null;
credentials.prompt = async (message) => {
  if (message.includes("Slack Bot Token")) return "abcd";
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

      // Dry run with just Enter — no toggles, empty result — used to read back
      // Slack's 1-based index from the same subscript so the real run can
      // press the right digit.
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
      const introspectOut = JSON.parse(introspect.stdout.trim().split("\n").pop()!);
      const slackIdx = introspectOut.slackIndex1Based;
      assert.ok(slackIdx >= 1, `unexpected slack index: ${slackIdx}`);

      // Real run: press Slack's digit, Enter. Slack gets toggled on, prompt
      // fires, mocked prompt returns "abcd", tokenFormat regex rejects it,
      // channel is dropped, saveCredential never runs for SLACK_BOT_TOKEN.
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
        `slack should have been dropped after invalid token; got ${JSON.stringify(out.result)}`,
      );
      assert.ok(
        !out.saveCalls.some((c: { key: string }) => c.key === "SLACK_BOT_TOKEN"),
        `SLACK_BOT_TOKEN should NOT have been persisted; saveCalls=${JSON.stringify(out.saveCalls)}`,
      );
      assert.ok(
        result.stderr.includes("Invalid format") || result.stdout.includes("Invalid format"),
        `expected 'Invalid format' warning; stderr=${result.stderr} stdout=${result.stdout}`,
      );
    },
  );
});
