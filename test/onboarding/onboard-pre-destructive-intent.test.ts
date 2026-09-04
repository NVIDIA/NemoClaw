// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describe, it } from "vitest";
import {
  createOnboardProcessWorkspace,
  minimalSpawnEnv,
  runOnboardProcess,
  testRepoRoot,
  trailingJsonPayload,
} from "../helpers/onboard-child-process-harness";
import { onboardScriptMocksPath } from "../helpers/onboard-split-context";

const onboardPath = JSON.stringify(path.join(testRepoRoot, "src", "lib", "onboard.ts"));
const runnerPath = JSON.stringify(path.join(testRepoRoot, "src", "lib", "runner.ts"));
const registryPath = JSON.stringify(path.join(testRepoRoot, "src", "lib", "state", "registry.ts"));
const defsPath = JSON.stringify(path.join(testRepoRoot, "src", "lib", "agent", "defs.ts"));
const bridgeProviderPath = JSON.stringify(
  path.join(testRepoRoot, "src", "lib", "onboard", "messaging-bridge-provider.ts"),
);

describe("onboard sandbox create intent boundary", () => {
  it(
    "rejects stale credential capabilities before real create mutations (#6226)",
    {
      timeout: 60_000,
    },
    () => {
      const workspace = createOnboardProcessWorkspace("nemoclaw-intent-boundary-");
      try {
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
        const scriptPath = workspace.path("stale-binding.js");
        fs.writeFileSync(scriptPath, script);

        const result = runOnboardProcess(
          ["--require", JSON.parse(onboardScriptMocksPath), scriptPath],
          {
            env: minimalSpawnEnv(workspace.homeDir, {
              NEMOCLAW_NON_INTERACTIVE: "1",
              NEMOCLAW_RECREATE_SANDBOX: "1",
              NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
            }),
            timeoutMs: 55_000,
          },
        );

        assert.equal(result.status, 0, result.stderr);
        const payload = trailingJsonPayload(result.stdout) as {
          error: string;
          mutations: string[];
        };
        assert.match(payload.error, /missing credential binding|credential binding set changed/);
        assert.deepEqual(payload.mutations, []);
      } finally {
        workspace.remove();
      }
    },
  );

  it(
    "refuses a selected bridge channel with no usable provider before deleting the sandbox",
    {
      timeout: 60_000,
    },
    () => {
      // Onboard offers to delete and recreate a sandbox name under another agent.
      // The bridge provider name carries no agent, so the gateway still holds the
      // OpenClaw binding; without the source secret there is nothing to mint from
      // and nothing safe to reuse. That has to stop the run before the delete.
      const workspace = createOnboardProcessWorkspace("nemoclaw-bridge-boundary-");
      try {
        const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const defs = require(${defsPath});
const bridgeProvider = require(${bridgeProviderPath});
const childProcess = require("node:child_process");
const record = (text) => { console.log("CMD " + text); return text; };

// The gateway still holds the OpenClaw bridge binding for this sandbox name.
const staleBinding = [
  "Name: my-assistant-googlechat-bridge",
  "Type: google-chat-bridge",
  "Credential keys: GOOGLE_CHAT_ACCESS_TOKEN",
  "Config keys: <none>",
  "",
].join(String.fromCharCode(10));

runner.run = (command) => {
  const text = record(Array.isArray(command) ? command.join(" ") : String(command));
  if (text.includes("provider get") && text.includes("googlechat-bridge")) {
    return { status: 0, stdout: staleBinding };
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  const text = record(Array.isArray(command) ? command.join(" ") : String(command));
  return text.includes("provider get") && text.includes("googlechat-bridge") ? staleBinding : "";
};
// Profile-boundary matching is covered at its owning unit boundary. This test
// isolates the later provider-binding mismatch that must precede deletion.
bridgeProvider.matchesRegisteredMessagingBridgeProfile = () => true;
registry.getSandbox = (name) => ({ name, agent: "openclaw" });
registry.removeSandbox = (name) => { record("registry remove " + name); };
registry.updateSandbox = (name) => { record("registry update " + name); };
registry.registerSandbox = (entry) => { record("registry register " + entry.name); };
childProcess.spawn = () => { throw new Error("unexpected sandbox create"); };

const { createSandbox } = require(${onboardPath});

(async () => {
  try {
    await createSandbox(
      null,
      "gpt-5.4",
      "nvidia-prod",
      null,
      "my-assistant",
      null,
      ["googlechat"],
      null,
      defs.loadAgent("hermes"),
      null,
      null,
      null,
      [],
      null,
      { recreate: true, toolDisclosure: "progressive", observabilityEnabled: false, extraProviders: [] },
    );
    console.log("CREATE-RETURNED");
  } catch (error) {
    console.log("CREATE-THREW " + String(error.message || error));
  }
})();
`;
        const scriptPath = workspace.path("stale-bridge.js");
        fs.writeFileSync(scriptPath, script);
        // The run reaches the gateway before it reaches the failure under test, and
        // the binary resolver exits the process when OpenShell is absent.
        const openshellStub = workspace.writeExecutable("openshell", "#!/bin/sh\nexit 0\n");

        const result = runOnboardProcess(
          ["--require", JSON.parse(onboardScriptMocksPath), scriptPath],
          {
            env: minimalSpawnEnv(workspace.homeDir, {
              NEMOCLAW_NON_INTERACTIVE: "1",
              NEMOCLAW_RECREATE_SANDBOX: "1",
              NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
              NEMOCLAW_OPENSHELL_BIN: openshellStub,
            }),
            timeoutMs: 55_000,
          },
        );

        const output = result.output;
        assert.equal(result.error, undefined, output);
        assert.equal(result.signal, null, output);
        // The guard exits the process, so neither marker can be reached and the
        // status is the guard's own. A hang or an unrelated throw fails here.
        assert.equal(result.status, 1, output);
        assert.doesNotMatch(output, /CREATE-RETURNED|CREATE-THREW/, output);
        assert.match(output, /GOOGLECHAT_SERVICE_ACCOUNT/, output);

        // Commands are read from the log the child emits as each one is issued,
        // since a payload printed at the end would never arrive. The binding read
        // has to have happened, and nothing may mutate before the refusal.
        const issued = output
          .split(String.fromCharCode(10))
          .filter((line) => line.startsWith("CMD "));
        assert.equal(
          issued.filter((line) => /provider get .*my-assistant-googlechat-bridge/.test(line))
            .length,
          1,
          output,
        );
        const mutating = issued.filter((line) =>
          /sandbox delete|sandbox provider (?:attach|detach)|provider (?:create|update|delete)|registry (?:remove|update|register)/.test(
            line,
          ),
        );
        assert.deepEqual(mutating, [], output);
      } finally {
        workspace.remove();
      }
    },
  );
});
