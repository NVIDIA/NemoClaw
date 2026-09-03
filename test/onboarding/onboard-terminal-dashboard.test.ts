// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined> | null;
};

function parseStdoutJson<T>(stdout: string): T {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
}

const repoRoot = path.join(import.meta.dirname, "../..");

function runTerminalDashboardScenario(scenario: "create" | "reuse") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-terminal-${scenario}-`));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, `${scenario}.js`);
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
  const agentDefsPath = JSON.stringify(path.join(repoRoot, "src", "lib", "agent", "defs.ts"));
  const agentOnboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "agent", "onboard.ts"));
  const dockerGpuSandboxCreatePath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "docker-gpu-sandbox-create.ts"),
  );
  const sandboxCreateStreamPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "sandbox", "create-stream.ts"),
  );
  const onboardScriptMocksPath = JSON.stringify(
    path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
  );

  fs.mkdirSync(fakeBin, { recursive: true });
  writeOkOpenshell(fakeBin);

  const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runner = require(${runnerPath});
const registry = require(${registryPath});
const fixtureMocks = require(${onboardScriptMocksPath});
const agentDefs = require(${agentDefsPath});
const agentOnboard = require(${agentOnboardPath});
const dockerGpuSandboxCreate = require(${dockerGpuSandboxCreatePath});
const sandboxCreateStream = require(${sandboxCreateStreamPath});
const scenario = ${JSON.stringify(scenario)};
const sandboxName = "deepagents-box";
const createdSandbox = fixtureMocks.createCreatedSandboxFixture({
  sandboxName,
  lifecycleState: scenario === "reuse" ? "created" : "absent",
});
createdSandbox.installRuntimeObservation();
const commands = [];
const registerCalls = [];
const updateCalls = [];
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const managedCredentialByProviderSuffix = new Map([
  ["-telegram-bridge", "TELEGRAM_BOT_TOKEN"],
  ["-discord-bridge", "DISCORD_BOT_TOKEN"],
  ["-wechat-bridge", "WECHAT_BOT_TOKEN"],
  ["-slack-bridge", "SLACK_BOT_TOKEN"],
  ["-slack-app", "SLACK_APP_TOKEN"],
  ["-teams-bridge", "MSTEAMS_APP_PASSWORD"],
]);
const managedProviderResult = (normalized) => {
  const providerName = normalized.split(/\s+/).at(-1);
  const credential = [...managedCredentialByProviderSuffix].find(([suffix]) =>
    providerName?.endsWith(suffix),
  )?.[1];
  return normalized.includes("provider get") && providerName && credential
    ? {
        status: 0,
        stdout: [
          "Name: " + providerName,
          "Type: nemoclaw-mcp-v1",
          "Credential keys: " + credential,
          "Config keys: <none>",
        ].join("\n"),
        stderr: "",
      }
    : null;
};

dockerGpuSandboxCreate.createDockerGpuSandboxCreatePatch = () => ({
  maybeApplyDuringCreate: () => {},
  createFailureMessage: () => null,
  exitOnPatchError: async () => {},
  attachManagedBootstrapCutover: () => {},
  rollbackManagedStartupAfterCreateFailure: async () => {},
  ensureApplied: async () => {},
  waitForSupervisorReconnectIfNeeded: () => {},
  commitAfterReady: async () => {},
  selectedMode: () => null,
  printReadinessFailureIfEnabled: () => {},
  verifyGpuOrExit: async (verify) => verify(sandboxName),
});

agentOnboard.createAgentSandbox = () => {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-terminal-agent-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(
    stagedDockerfile,
    "FROM scratch\nARG NEMOCLAW_DCODE_AUTO_APPROVAL=disabled\nCMD [\"/bin/sh\"]\n",
  );
  return { buildCtx, stagedDockerfile };
};

runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  const profileResult = fixtureMocks.mockManagedEndpointlessProviderProfileRun(command);
  if (profileResult !== null) return profileResult;
  const providerResult = managedProviderResult(normalized);
  if (providerResult !== null) return providerResult;
  const inferenceProviderResult = fixtureMocks.mockNvidiaProviderGetRun(command, "nemoclaw");
  if (inferenceProviderResult !== null) return inferenceProviderResult;
  const sandboxResult = createdSandbox.run(command);
  return sandboxResult ?? { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ command: _n([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  const normalized = _n(command);
  const sandboxCapture = createdSandbox.capture(command);
  if (sandboxCapture !== null) return sandboxCapture;
  commands.push({ command: normalized, env: null });
  if (
    normalized.includes(
      "sandbox exec --name " +
        sandboxName +
        " --gateway nemoclaw -- /usr/local/bin/dcode identity",
    )
  ) {
    return [
      "Route:    inference",
      "Provider: nvidia-prod",
      "Model:    openai:gpt-5.4",
      "Endpoint: https://inference.local/v1",
    ].join("\n");
  }
  if (normalized.includes("forward list")) return "SANDBOX BIND PORT PID STATUS";
  return "";
};

registry.getSandbox = () =>
  scenario === "reuse"
    ? fixtureMocks.sandboxLifecycleFixture({
        name: sandboxName,
        gpuEnabled: false,
        agent: "langchain-deepagents-code",
        dashboardPort: 18789,
        observabilityEnabled: false,
        toolDisclosure: "progressive",
      })
    : null;
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = (name, updates) => {
  updateCalls.push({ name, updates });
  return true;
};
registry.setDefault = () => true;
registry.removeSandbox = () => true;
const createFixture =
  scenario === "create"
    ? fixtureMocks.installVerifiedSandboxCreateFixture(registry, {
        sandboxName,
        provider: "nvidia-prod",
        model: "gpt-5.4",
        registerSandbox: (entry) => registerCalls.push(entry),
        updateSandbox: (name, updates) => updateCalls.push({ name, updates }),
      })
    : null;

sandboxCreateStream.streamSandboxCreate = async (command, args, env) => {
  if (scenario === "reuse") throw new Error("unexpected sandbox create");
  createdSandbox.create([command, ...args]);
  commands.push({ command: _n([command, ...args]), env });
  return { status: 0, output: "Created sandbox: " + sandboxName, sawProgress: true };
};

const { createSandbox } = require(${onboardPath});
const agent = agentDefs.loadAgent("langchain-deepagents-code");

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.test:19000";
  process.env.NEMOCLAW_DASHBOARD_PORT = "19000";
  const createArgs = [
    null,
    "gpt-5.4",
    "nvidia-prod",
    null,
    sandboxName,
    null,
    null,
    null,
    agent,
    null,
    null,
    null,
    [],
  ];
  const resultName = await createSandbox(
    ...(createFixture
      ? fixtureMocks.sandboxCreateArgsWithVerifiedReservation(createArgs, createFixture)
      : createArgs),
  );
  console.log(JSON.stringify({ resultName, commands, registerCalls, updateCalls }));
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
      NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG: "1",
      OPENSHELL_DRIVERS: scenario === "create" ? "vm" : "docker",
    },
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  assert.equal(result.status, 0, result.stderr);
  return parseStdoutJson<{
    resultName: string;
    commands: CommandEntry[];
    registerCalls: Array<{ dashboardPort?: number | null }>;
    updateCalls: Array<{ name: string; updates: { dashboardPort?: number | null } }>;
  }>(result.stdout);
}

describe("terminal-agent onboard dashboard handling", () => {
  it("does not inject dashboard env, probe, or forward during create", () => {
    const payload = runTerminalDashboardScenario("create");
    const createCommand = payload.commands.find((entry) =>
      entry.command.includes("sandbox create"),
    );

    assert.equal(payload.resultName, "deepagents-box");
    assert.ok(createCommand, "expected sandbox create command");
    assert.ok(!createCommand.command.includes("CHAT_UI_URL="), createCommand.command);
    assert.ok(!createCommand.command.includes("NEMOCLAW_DASHBOARD_PORT="), createCommand.command);
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("forward start")),
      "terminal agent without declared ports must not start dashboard forwards",
    );
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("/health")),
      "terminal agent without a dashboard must not run dashboard readiness probes",
    );
    assert.equal(payload.registerCalls[0]?.dashboardPort, 0);
  });

  it("does not restore dashboard forwarding while reusing a ready terminal sandbox", () => {
    const payload = runTerminalDashboardScenario("reuse");

    assert.equal(payload.resultName, "deepagents-box");
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("sandbox create")),
      "reuse should not create a new sandbox",
    );
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("forward start")),
      "terminal reuse must not restore dashboard forwarding",
    );
    assert.equal(
      payload.updateCalls.find((entry) => entry.name === "deepagents-box")?.updates.dashboardPort,
      0,
    );
  });
});
