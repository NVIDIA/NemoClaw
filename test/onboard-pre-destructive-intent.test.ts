// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";
import { onboardScriptMocksPath } from "./helpers/onboard-split-context";

describe("onboard sandbox create intent boundary", () => {
  it("rejects stale credential capabilities before real create mutations (#6226)", {
    timeout: 60_000,
  }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-intent-boundary-"));
    try {
      const scriptPath = path.join(tmpDir, "stale-binding.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const registryPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "state", "registry.ts"),
      );

      const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const childProcess = require("node:child_process");
const mutations = [];

const runStub = (command) => {
  mutations.push(Array.isArray(command) ? command.join(" ") : String(command));
  return { status: 0 };
};
runner.run = runStub;
runner.runCapture = () => "";
const removeSandboxStub = (name) => { mutations.push("registry remove " + name); };
const updateSandboxStub = (name) => { mutations.push("registry update " + name); };
const registerSandboxStub = (entry) => { mutations.push("registry register " + entry.name); };
registry.removeSandbox = removeSandboxStub;
registry.updateSandbox = updateSandboxStub;
registry.registerSandbox = registerSandboxStub;
childProcess.spawn = () => { throw new Error("unexpected sandbox create"); };
if (runner.run !== runStub || registry.removeSandbox !== removeSandboxStub || registry.updateSandbox !== updateSandboxStub || registry.registerSandbox !== registerSandboxStub) {
  throw new Error("onboard mutation stubs were not installed");
}

const { createSandbox } = require(${onboardPath});
const resolved = {
  sandboxName: "my-assistant",
  activeMessagingChannels: [],
  messagingProviderRequests: [{
    name: "my-assistant-extra-telegram-bot-token-agent-a",
    envKey: "TELEGRAM_BOT_TOKEN_AGENT_A",
    providerType: "generic",
    credentialConfigured: true,
    channel: null,
  }],
  reusableMessagingProviders: [],
  extraProviders: [],
  staleExtraProviders: [],
  hermesToolGateways: [],
  policy: {
    basePolicyPath: "/unused/policy.yaml",
    activeMessagingChannels: [],
    options: { directGpu: false, additionalPresets: [], policyTier: null },
  },
  gpuCreateArgs: [],
  resourceCreateArgs: [],
  gpuRoutePlan: "none",
  sandboxGpuLogMessage: null,
  disabledChannelNames: [],
  extraPlaceholderKeys: ["TELEGRAM_BOT_TOKEN_AGENT_A"],
};

(async () => {
  try {
    await createSandbox(
      null,
      "gpt-5.4",
      "nvidia-prod",
      null,
      "my-assistant",
      null,
      [],
      null,
      null,
      null,
      null,
      null,
      [],
      null,
      {
        resolved,
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        extraProviders: [],
      },
    );
    throw new Error("create unexpectedly succeeded");
  } catch (error) {
    console.log(JSON.stringify({ error: String(error.message || error), mutations }));
  }
})();
`;
      fs.writeFileSync(scriptPath, script);

      const childEnv = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^(?:DISCORD|TELEGRAM)_/.test(name)),
      );
      const result = spawnSync(
        process.execPath,
        ["--require", JSON.parse(onboardScriptMocksPath), scriptPath],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 55_000,
          env: {
            ...childEnv,
            HOME: tmpDir,
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_RECREATE_SANDBOX: "1",
            NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);
      assert.match(payload.error, /missing credential binding|credential binding set changed/);
      assert.deepEqual(payload.mutations, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
