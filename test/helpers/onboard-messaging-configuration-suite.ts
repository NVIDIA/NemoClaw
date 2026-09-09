// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, it, vi } from "vitest";

import {
  activeChannelsFromDockerfile,
  encodeMessagingPlanForChannels,
  messagingPlanLiteral,
  parseMessagingFixturePayload,
  writeCustomMessagingDockerfile,
} from "./messaging-plan-fixtures";
import { writeOkOpenshell } from "./onboard-openshell-fixture";

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
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);
beforeEach(() => {
  vi.stubEnv("NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG", "1");
  vi.stubEnv("NEMOCLAW_TEST_FORWARD_SERVICE_FIXTURE", "1");
  vi.stubEnv("NEMOCLAW_SANDBOX_PREBUILD", "1");
});

export function registerOnboardMessagingConfigurationTests(): void {
  describe("onboard messaging (configuration)", () => {
    it(
      "bakes WhatsApp into a custom sandbox image without bridge providers when no messaging tokens are set",
      {
        timeout: 60_000,
      },
      async () => {
        const tmpDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "nemoclaw-onboard-tokenless-whatsapp-"),
        );
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
const providerGetResult = fixtureMocks.mockNvidiaOrMissingProviderGetRun(command, "nemoclaw"); if (providerGetResult !== null) return providerGetResult;
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
}; require(${onboardScriptMocksPath}).mockIsolatedDockerSandboxLifecycleFromRunner();
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

          const providerMutationCommands = payload.commands.filter(
            (entry: CommandEntry) =>
              /\bprovider (create|update)\b/.test(entry.command) &&
              entry.command.includes("-bridge"),
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
        const tmpDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "nemoclaw-onboard-disabled-whatsapp-"),
        );
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
const providerGetResult = fixtureMocks.mockNvidiaOrMissingProviderGetRun(command, "nemoclaw"); if (providerGetResult !== null) return providerGetResult;
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
}; require(${onboardScriptMocksPath}).mockIsolatedDockerSandboxLifecycleFromRunner();
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
return fixtureMocks.mockNvidiaOrMissingProviderGetRun(command, "nemoclaw") ?? createdSandbox.run(command) ?? { status: 0 };
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
}; require(${onboardScriptMocksPath}).mockIsolatedDockerSandboxLifecycleFromRunner();
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
}
