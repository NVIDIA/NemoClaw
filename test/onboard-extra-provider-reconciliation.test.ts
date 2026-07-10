// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { writeOkOpenshell } from "./helpers/onboard-openshell-fixture";

type CommandEntry = { command: string };

const repoRoot = path.join(import.meta.dirname, "..");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);

describe("onboard extra-provider reconciliation", () => {
  it("attaches live user extras, skips stale names, and preserves registry state (#6501)", {
    timeout: 90_000,
  }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-extra-provider-reconcile-"));
    try {
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "reconcile-provider-check.js");
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
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const _n = (command) => (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");

const commands = [];
registry.addExtraProvider("tavily-search");
registry.addExtraProvider("brave-search");
registry.addExtraProvider("custom-provider");
registry.addExtraProvider("my-slack-bridge");

runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider list -g nemoclaw --names")) {
    return { status: 0, stdout: "brave-search\ncustom-provider\nmy-slack-bridge\n" };
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  const normalized = _n(command);
  if (normalized.includes("sandbox get my-assistant")) return "";
  if (normalized.includes("sandbox list")) return "my-assistant Ready";
  const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
  if (mockedCapture !== null) return mockedCapture;
  if (normalized.includes("forward list")) {
    return "my-assistant 127.0.0.1 18789 12345 running";
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
  child.unref = () => {};
  child.pid = 4242;
  commands.push({
    command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]),
    env: args[2]?.env || null,
  });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({
    sandboxName,
    commands,
    extraProviders: registry.listExtraProviders(),
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
          OPENSHELL_GATEWAY_ENDPOINT: undefined,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);
      assert.equal(payload.sandboxName, "my-assistant");

      const createCommand = payload.commands.find((entry: CommandEntry) =>
        entry.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.match(createCommand.command, /--provider brave-search/);
      assert.match(createCommand.command, /--provider custom-provider/);
      assert.match(createCommand.command, /--provider my-slack-bridge/);
      assert.doesNotMatch(createCommand.command, /--provider tavily-search/);

      const providerLists = payload.commands.filter((entry: CommandEntry) =>
        entry.command.includes("provider list -g nemoclaw --names"),
      );
      assert.equal(providerLists.length, 1, "expected one gateway-scoped provider list");
      assert.deepEqual(payload.extraProviders, [
        "brave-search",
        "custom-provider",
        "my-slack-bridge",
        "tavily-search",
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
