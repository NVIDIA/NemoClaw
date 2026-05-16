// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, it } from "vitest";
import YAML from "yaml";

type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  policyContent?: string;
  policyReadError?: string;
};

function parseStdoutJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").pop();
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
}

const repoRoot = path.join(import.meta.dirname, "..");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);

describe("onboard messaging", () => {
  it(
    "creates providers for messaging tokens and attaches them to the sandbox",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-providers-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-provider-check.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

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
const fs = require("node:fs");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  // provider-get returns not-found so messaging providers are created fresh
  if (_n(command).includes("provider get")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("provider get")) return "Provider: discord-bridge";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const command = _n(args[1][1]);
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

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token-value";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token-value";
  process.env.SLACK_APP_TOKEN = "xapp-test-slack-app-token-value";
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  process.env.KUBECONFIG = "/tmp/host-kubeconfig";
  process.env.SSH_AUTH_SOCK = "/tmp/host-ssh-agent.sock";
  const sandboxName = await createSandbox(null, "gpt-5.4");
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
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      // Verify providers were created with the right credential keys
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

      // Verify sandbox create includes --provider flags for all three
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
        .filter((host: string | undefined) =>
          host === "wss-primary.slack.com" || host === "wss-backup.slack.com",
        )
        .sort();
      assert.deepEqual(slackWebsocketHosts, ["wss-backup.slack.com", "wss-primary.slack.com"].sort());

      // Messaging tokens must NOT appear in the sandbox create command
      // (they flow exclusively through the openshell provider credential system).
      assert.doesNotMatch(createCommand.command, /test-discord-token-value/);
      assert.doesNotMatch(createCommand.command, /123456:ABC-test-telegram-token/);
      assert.doesNotMatch(createCommand.command, /DISCORD_BOT_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /TELEGRAM_BOT_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /xoxb-test-slack-token-value/);
      assert.doesNotMatch(createCommand.command, /xapp-test-slack-app-token-value/);
      assert.doesNotMatch(createCommand.command, /SLACK_BOT_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /SLACK_APP_TOKEN=/);

      // Verify blocked credentials are NOT in the sandbox spawn environment
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
        createCommand.env.NVIDIA_API_KEY,
        undefined,
        "NVIDIA_API_KEY must not be in sandbox env",
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

      // Belt-and-suspenders: raw token values must not appear anywhere in env
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
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-hermes-slack-"));
      try {
      const fakeBin = path.join(tmpDir, "bin");
      const customBuildDir = path.join(tmpDir, "custom-build");
      const customDockerfilePath = path.join(customBuildDir, "Dockerfile");
      const scriptPath = path.join(tmpDir, "hermes-slack-policy.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const agentDefsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "agent", "defs.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
      );
      const yamlPath = JSON.stringify(path.join(repoRoot, "node_modules", "yaml"));
      const customDockerfileArg = JSON.stringify(customDockerfilePath);

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(customBuildDir, { recursive: true });
      fs.writeFileSync(customDockerfilePath, "FROM scratch\n");
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
const fs = require("node:fs");
const YAML = require(${yamlPath});
const { loadAgent } = require(${agentDefsPath});

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
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.registerSandbox = (entry) => {
  registeredSandbox = entry;
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const command = _n(args[1][1]);
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
  const sandboxName = await createSandbox(
    null,
    "gpt-5.4",
    "nvidia-prod",
    null,
    "my-assistant",
    null,
    null,
    ${customDockerfileArg},
    loadAgent("hermes"),
  );
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
    registeredPolicies: registeredSandbox?.policies || [],
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
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(payload.createCommand.command.includes("sandbox create"));
      assert.match(payload.createCommand.command, /--provider my-assistant-slack-bridge/);
      assert.match(payload.createCommand.command, /--provider my-assistant-slack-app/);
      assert.doesNotMatch(payload.createCommand.policyPath, /nemoclaw-initial-policy/);
      assert.equal(payload.createCommand.policyReadError, null);
      assert.deepEqual(payload.registeredPolicies, ["slack"]);
      assert.deepEqual(payload.slackBinaryPaths, [
        "/usr/local/bin/hermes",
        "/usr/bin/python3*",
        "/opt/hermes/.venv/bin/python",
      ]);
      assert.ok(
        !payload.slackBinaryPaths.includes("/usr/local/bin/node"),
        "Hermes Slack policy must not be replaced by the generic Node Slack preset",
      );
      const slackWebsocketHosts = payload.slackEndpointHosts
        .filter((host: string) =>
          host === "wss-primary.slack.com" || host === "wss-backup.slack.com",
        )
        .sort();
      assert.deepEqual(slackWebsocketHosts, ["wss-backup.slack.com", "wss-primary.slack.com"].sort());
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "reuses existing messaging providers during non-interactive recreate when tokens are not in the host env",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-reuse-provider-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-reuse-provider.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

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
const fs = require("node:fs");

const commands = [];
const registerCalls = [];
registry.registerSandbox({
  name: "my-assistant",
  messagingChannels: ["discord", "slack"],
  providerCredentialHashes: {
    DISCORD_BOT_TOKEN: "hash-discord",
    SLACK_BOT_TOKEN: "hash-slack-bot",
    SLACK_APP_TOKEN: "hash-slack-app",
    TELEGRAM_BOT_TOKEN: "hash-telegram",
  },
});
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get my-assistant-discord-bridge")) return { status: 0 };
  if (normalized.includes("provider get my-assistant-slack-bridge")) return { status: 0 };
  if (normalized.includes("provider get my-assistant-slack-app")) return { status: 0 };
  if (normalized.includes("provider get")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const command = _n(args[1][1]);
  const entry = { command, env: args[2]?.env || null };
  const dockerfileMatch = command.match(/--from ([^ ]+Dockerfile)/);
  if (dockerfileMatch) {
    try {
      entry.dockerfileContent = fs.readFileSync(dockerfileMatch[1], "utf-8");
    } catch (error) {
      entry.dockerfileReadError = String(error);
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
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const sandboxName = await createSandbox(
    null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, ["discord", "slack"],
  );
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
          DISCORD_BOT_TOKEN: "",
          SLACK_BOT_TOKEN: "",
          SLACK_APP_TOKEN: "",
          TELEGRAM_BOT_TOKEN: "",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      const providerMutationCommands = payload.commands.filter((entry: CommandEntry) =>
        /\bprovider (create|update)\b/.test(entry.command),
      );
      assert.equal(
        providerMutationCommands.length,
        0,
        "tokenless rebuild should not mutate providers",
      );

      const createCommand = payload.commands.find((entry: CommandEntry) =>
        entry.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.equal(createCommand.dockerfileReadError, undefined);
      assert.match(createCommand.command, /--provider my-assistant-discord-bridge/);
      assert.match(createCommand.command, /--provider my-assistant-slack-bridge/);
      assert.match(createCommand.command, /--provider my-assistant-slack-app/);

      const channelsLine = createCommand.dockerfileContent
        ?.split("\n")
        .find((line: string) => line.startsWith("ARG NEMOCLAW_MESSAGING_CHANNELS_B64="));
      assert.ok(channelsLine, "expected messaging build arg in Dockerfile");
      const channels = JSON.parse(Buffer.from(channelsLine.split("=")[1], "base64").toString());
      assert.deepEqual(channels, ["discord", "slack"]);
      assert.deepEqual(payload.registerCalls[0]?.messagingChannels, ["discord", "slack"]);
      assert.deepEqual(payload.registerCalls[0]?.providerCredentialHashes, {
        DISCORD_BOT_TOKEN: "hash-discord",
        SLACK_BOT_TOKEN: "hash-slack-bot",
        SLACK_APP_TOKEN: "hash-slack-app",
      });
    },
  );

  it(
    "preserves disabled channels in the registry after a recreate so `channels start` can re-enable them (#3381)",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-disabled-channels-preserve-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "disabled-channels-preserve.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

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
const fs = require("node:fs");

const commands = [];
const registerCalls = [];
registry.registerSandbox({
  name: "my-assistant",
  messagingChannels: ["telegram"],
  disabledChannels: ["telegram"],
  providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-telegram" },
});
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get my-assistant-telegram-bridge")) return { status: 0 };
  if (normalized.includes("provider get")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const command = _n(args[1][1]);
  const entry = { command, env: args[2]?.env || null };
  const dockerfileMatch = command.match(/--from ([^ ]+Dockerfile)/);
  if (dockerfileMatch) {
    try {
      entry.dockerfileContent = fs.readFileSync(dockerfileMatch[1], "utf-8");
    } catch (error) {
      entry.dockerfileReadError = String(error);
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
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  delete process.env.TELEGRAM_BOT_TOKEN;
  const sandboxName = await createSandbox(
    null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, ["telegram"],
  );
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
          TELEGRAM_BOT_TOKEN: "",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      const createCommand = payload.commands.find((entry: CommandEntry) =>
        entry.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.equal(createCommand.dockerfileReadError, undefined);

      const channelsLine = createCommand.dockerfileContent
        ?.split("\n")
        .find((line: string) => line.startsWith("ARG NEMOCLAW_MESSAGING_CHANNELS_B64="));
      assert.ok(channelsLine, "expected messaging build arg in Dockerfile");
      const bakedChannels = JSON.parse(
        Buffer.from(channelsLine.split("=")[1], "base64").toString(),
      );
      assert.deepEqual(bakedChannels, [], "disabled channel must not be baked into the image");
      assert.doesNotMatch(
        createCommand.command,
        /--provider my-assistant-telegram-bridge/,
        "disabled channel's bridge must not be attached to the new sandbox",
      );

      assert.deepEqual(
        payload.registerCalls[0]?.messagingChannels,
        ["telegram"],
        "registry.messagingChannels must keep the disabled-but-configured channel so `channels start` can recover it",
      );
      assert.deepEqual(
        payload.registerCalls[0]?.disabledChannels,
        ["telegram"],
        "registry.disabledChannels must round-trip through the rebuild",
      );
    },
  );

  it("aborts onboard when a messaging provider upsert fails", { timeout: 60_000 }, async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-provider-fail-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "provider-upsert-fail.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

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
};
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
  await createSandbox(null, "gpt-5.4");
  // Should not reach here
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
    "reuses sandbox when messaging providers already exist in gateway",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-providers-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "reuse-with-providers.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Existing sandbox that is ready
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  // All messaging providers already exist in gateway
  if (_n(command).includes("provider get")) return "Provider: exists";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.DISCORD_BOT_TOKEN = "test-discord-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
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
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.equal(payload.sandboxName, "my-assistant", "should reuse existing sandbox");
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox create")),
        "should NOT recreate sandbox when providers already exist in gateway",
      );
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox delete")),
        "should NOT delete sandbox when providers already exist in gateway",
      );

      // Providers should still be upserted on reuse (credential refresh).
      // Since the mock reports providers as existing (run returns status 0),
      // upsertProvider issues 'update' rather than 'create'.
      const providerUpserts = payload.commands.filter((entry: CommandEntry) =>
        entry.command.includes("provider update"),
      );
      assert.ok(
        providerUpserts.some((e: CommandEntry) =>
          e.command.includes("my-assistant-discord-bridge"),
        ),
        "should upsert discord provider on reuse to refresh credentials",
      );
      assert.ok(
        providerUpserts.some((e: CommandEntry) => e.command.includes("my-assistant-slack-bridge")),
        "should upsert slack provider on reuse to refresh credentials",
      );
    },
  );

  it(
    "filters messaging providers to only enabledChannels when provided",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-enabled-channels-filter-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "enabled-channels-filter.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

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

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  // provider-get returns not-found so messaging providers are created fresh
  if (_n(command).includes("provider get")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
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
  const sandboxName = await createSandbox(
    null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, ["telegram"],
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
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

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
    "creates no messaging providers when enabledChannels is empty",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-enabled-channels-empty-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "enabled-channels-empty.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

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

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: _n(args[1][1]), env: args[2]?.env || null });
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
  // Empty array — user deselected all channels
  const sandboxName = await createSandbox(
    null, "gpt-5.4", "nvidia-prod", null, "my-assistant", null, [],
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
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      // No messaging providers should be created at all
      const providerCommands = payload.commands.filter((e: CommandEntry) =>
        e.command.includes("provider create"),
      );
      assert.equal(
        providerCommands.length,
        0,
        "no providers should be created when enabledChannels is empty",
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
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-noninteractive-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-noninteractive.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const httpProbePath = JSON.stringify(path.join(repoRoot, "dist", "lib", "adapters", "http", "probe.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
runner.run = () => ({ status: 0 });
runner.runCapture = () => "";

// Stub the Telegram reachability probe so this test doesn't make a real network
// call — on networks where api.telegram.org is blocked, the non-interactive
// preflight would otherwise abort the test.
const httpProbe = require(${httpProbePath});
httpProbe.runCurlProbe = () => ({
  ok: true,
  httpStatus: 200,
  curlStatus: 0,
  body: '{"ok":true,"result":{"id":1,"is_bot":true}}',
  stderr: "",
  message: "",
});

const { setupMessagingChannels } = require(${onboardPath});

(async () => {
  // Only set telegram and slack tokens — discord should be absent
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-telegram-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
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
    "non-interactive setupMessagingChannels returns empty array when no tokens set",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-messaging-no-tokens-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "messaging-no-tokens.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-slack-format-reject-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "slack-format-reject.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

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

  it(
    "interactive setupMessagingChannels drops slack when app token fails appTokenFormat check (#1912)",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-slack-app-format-reject-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "slack-app-format-reject.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

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
      // Bot token is persisted before the app-token prompt — that's fine, the
      // user can retry later and the pre-saved bot token will light up as
      // "already configured" on the next onboard.
      assert.ok(
        out.saveCalls.some((c: { key: string }) => c.key === "SLACK_BOT_TOKEN"),
        `SLACK_BOT_TOKEN should have been persisted (valid format); saveCalls=${JSON.stringify(out.saveCalls)}`,
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

  it("Slack bot token format regex rejects obvious bogus tokens and accepts valid ones (#1912)", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const onboardPath = path.join(repoRoot, "dist", "lib", "onboard.js");
    // Cache-bust the dynamic import so repeated test runs pick up rebuilds.
    const onboardUrl = `${pathToFileURL(onboardPath).href}?update=${Date.now()}`;
    const { MESSAGING_CHANNELS } = await import(onboardUrl);
    const slack = MESSAGING_CHANNELS.find((c: { name: string }) => c.name === "slack");

    assert.ok(slack, "slack messaging channel definition present");
    assert.ok(slack.tokenFormat instanceof RegExp, "slack.tokenFormat is a regex");
    assert.ok(
      typeof slack.tokenFormatHint === "string" && slack.tokenFormatHint.length > 0,
      "slack.tokenFormatHint set",
    );

    // Bogus tokens from the bug report and other common misentries — must be rejected.
    // gitleaks-allow below: intentionally pasted fake prefixes to prove they don't match.
    const invalid = [
      "abcd",
      "",
      "xoxb",
      "xoxb-",
      "xoxp-" + "test-user-token", // gitleaks:allow
      "xapp-" + "test-app-token", // gitleaks:allow
      "Bearer xoxb-fake",
      "xoxb-fake with space",
    ];
    for (const token of invalid) {
      assert.ok(
        !slack.tokenFormat.test(token),
        `expected ${JSON.stringify(token)} to be rejected as Slack bot token`,
      );
    }

    // Syntactically valid bot tokens — must be accepted. Values are
    // intentionally obvious test strings to avoid tripping gitleaks.
    const valid = [
      "xoxb-test-slack-token-value",
      "xoxb-fake-bot-token",
      "xoxb-A",
      // Slack tokens can contain underscores — lock in the widened
      // character class per @jyaunches review on #2130.
      "xoxb-test_with_underscores",
      "xoxb-mix_of-hyphens_and_underscores",
    ];
    for (const token of valid) {
      assert.ok(
        slack.tokenFormat.test(token),
        `expected ${JSON.stringify(token)} to be accepted as Slack bot token`,
      );
    }

    // App token (xapp-) has its own format — same permissive character
    // class. Per @jyaunches suggestion #2 on #2130.
    assert.ok(slack.appTokenFormat instanceof RegExp, "slack.appTokenFormat is a regex");
    assert.ok(
      typeof slack.appTokenFormatHint === "string" && slack.appTokenFormatHint.length > 0,
      "slack.appTokenFormatHint set",
    );
    const invalidApp = [
      "abcd",
      "",
      "xapp",
      "xapp-",
      "xoxb-" + "test-bot-token", // gitleaks:allow
      "Bearer xapp-fake",
      "xapp-fake with space",
    ];
    for (const token of invalidApp) {
      assert.ok(
        !slack.appTokenFormat.test(token),
        `expected ${JSON.stringify(token)} to be rejected as Slack app token`,
      );
    }
    const validApp = [
      "xapp-" + "1-A0000-12345-abcdef",
      "xapp-" + "test-app-token-value",
      "xapp-" + "A",
      "xapp-" + "with_underscores_and-hyphens",
    ];
    for (const token of validApp) {
      assert.ok(
        slack.appTokenFormat.test(token),
        `expected ${JSON.stringify(token)} to be accepted as Slack app token`,
      );
    }
  });

});
