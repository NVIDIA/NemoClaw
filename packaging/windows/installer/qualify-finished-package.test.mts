// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  environment,
  smokeAgent,
  turnArguments,
  validateTurn,
} from "./qualify-finished-package.mts";

test("startup smoke excludes inherited credentials and runtime overrides", () => {
  const filtered = environment("installed", {
    SystemRoot: "windows",
    PATH: "tools",
    NVIDIA_API_KEY: "synthetic-secret",
    NVIDIA_INFERENCE_API_KEY: "synthetic-secret",
    GH_TOKEN: "synthetic-secret",
    NODE_OPTIONS: "--require injected",
    NEMOCLAW_NATIVE_RUNTIME_ROOT: "substituted",
  });
  assert.deepEqual(filtered, {
    SystemRoot: "windows",
    PATH: "tools",
    NEMOCLAW_NATIVE_INSTALL_ROOT: "installed",
  });
});

test("Pi uses the compiled terminal route and OpenClaw keeps its existing route", () => {
  assert.equal(smokeAgent(), "openclaw");
  assert.equal(smokeAgent("pi"), "pi");
  for (const agent of ["", "hermes", "../pi", "PI"]) assert.throws(() => smokeAgent(agent));
  assert.deepEqual(turnArguments("pi", "evidence"), [
    "--runtime-host",
    "terminal-turn",
    "--agent",
    "pi",
    "--qualification",
    "--artifact-directory",
    "evidence",
  ]);
  assert.deepEqual(turnArguments("openclaw", "evidence"), [
    "--native-turn",
    "--wait",
    "--qualification",
    "--artifact-directory",
    "evidence",
  ]);
});

function piReceipt() {
  return {
    verdict: "pass",
    classification: "installed-nemoclaw-native-windows-pi",
    architecture: "arm64",
    backend: "process_container",
    piVersion: "0.84.1",
    deterministicLocalModel: true,
    turnCount: 3,
    turns: [1, 2, 3].map((index) => ({
      expected: `NATIVE_PI_TURN_${index}_OK`,
      output: `NATIVE_PI_TURN_${index}_OK`,
    })),
    createWatcherStopped: true,
    gatewayStopped: true,
    sandboxDeleted: true,
    sandboxRegistryAbsent: true,
    qualificationRootsRemoved: true,
  };
}

test("Pi smoke rejects incomplete, wrong-agent and failed-cleanup receipts", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-receipts-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "turn");
  fs.mkdirSync(output);
  const file = path.join(output, "native-windows-pi-0123456789.json");
  const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => validateTurn("pi", output, root));
  write(piReceipt());
  validateTurn("pi", output, root);
  for (const [key, value] of Object.entries({
    verdict: "fail",
    classification: "installed-nemoclaw-native-windows-hermes",
    architecture: "x64",
    backend: "isolation_session",
    piVersion: "0.0.0",
    deterministicLocalModel: false,
    turnCount: 2,
    turns: [],
    createWatcherStopped: false,
    gatewayStopped: false,
    sandboxDeleted: false,
    sandboxRegistryAbsent: false,
    qualificationRootsRemoved: false,
  })) {
    write({ ...piReceipt(), [key]: value });
    assert.throws(() => validateTurn("pi", output, root), key);
  }
  const noOutput = piReceipt();
  noOutput.turns[2].output = "not the required reply";
  write(noOutput);
  assert.throws(() => validateTurn("pi", output, root));
  fs.writeFileSync(file, '{"verdict":"pass"');
  assert.throws(() => validateTurn("pi", output, root));
  write(piReceipt());
  const duplicate = path.join(output, "native-windows-pi-abcdef0123.json");
  fs.copyFileSync(file, duplicate);
  assert.throws(() => validateTurn("pi", output, root));
  fs.unlinkSync(duplicate);
  for (const prefix of [
    "NemoClawNativeAgent",
    "NemoClawNativeAgentShare",
    "NemoClawNativeAgentRuntime",
  ]) {
    const retained = path.join(root, `${prefix}-pi-0123456789`);
    fs.mkdirSync(retained);
    assert.throws(() => validateTurn("pi", output, root), /retained an owned directory/u);
    fs.rmdirSync(retained);
  }
  validateTurn("pi", output, root);
});

test("OpenClaw smoke still requires its embedded reply and workload cleanup", (context) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-smoke-receipts-"));
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const file = path.join(output, "native-windows-turn-abcd.json");
  const receipt = {
    ...piReceipt(),
    exactReply: "CHAT_OK",
    openClawExecutionMode: "embedded-worker",
    workloadStopped: true,
  };
  fs.writeFileSync(file, JSON.stringify(receipt));
  validateTurn("openclaw", output);
  for (const change of [
    { exactReply: "wrong" },
    { openClawExecutionMode: "host" },
    { workloadStopped: false },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...receipt, ...change }));
    assert.throws(() => validateTurn("openclaw", output));
  }
});
