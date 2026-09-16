// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  environment,
  captureOwned,
  smokeAgent,
  turnArguments,
  validateTurn,
} from "./qualify-finished-package.mts";
import { piWorkloadSource } from "../runtime/run-installed-native-pi.mts";

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
      modelRequests: [`NATIVE_PI_TURN_${index}_OK`],
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
  for (const observed of [undefined, [], ["wrong-token"], ["NATIVE_PI_TURN_3_OK", "wrong-token"]]) {
    const missingRequest = piReceipt();
    Object.assign(missingRequest.turns[2], { modelRequests: observed });
    write(missingRequest);
    assert.throws(() => validateTurn("pi", output, root), /local-model request/u);
  }
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

test("receipt reads reject growth, links and path replacement and close the file", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-receipt-boundary-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "native-windows-pi-0123456789.json");
  const original = fs.lstatSync;
  const closes = context.mock.method(fs, "closeSync");
  for (const mode of ["growth", "link", "replacement"]) {
    fs.writeFileSync(file, JSON.stringify(piReceipt()));
    const check = context.mock.method(fs, "lstatSync", (name, ...args) => {
      const stat = original(name, ...args);
      if (name !== file) return stat;
      if (mode === "growth") {
        fs.appendFileSync(file, " ".repeat(1024 * 1024));
        return stat;
      }
      if (mode === "link") return Object.assign(stat, { isSymbolicLink: () => true });
      fs.renameSync(file, path.join(root, "original"));
      fs.writeFileSync(file, JSON.stringify(piReceipt()));
      return original(file);
    });
    const before = closes.mock.callCount();
    try {
      assert.throws(() => validateTurn("pi", root, root), /limit|link|identity/u);
      assert.ok(closes.mock.callCount() > before);
    } finally {
      check.mock.restore();
    }
  }
});

test("Pi worker requires a matching local-model request, not an echoed prompt", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-observation-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worker = path.join(root, "worker.mjs");
  const cli = path.join(root, "cli.mjs");
  fs.writeFileSync(worker, piWorkloadSource());
  fs.writeFileSync(
    cli,
    `
const prompt = process.argv.at(-1);
if (process.env.PI_TEST_MODE !== "echo") {
  const response = await fetch("http://127.0.0.1:" + process.env.NEMOCLAW_PI_MODEL_PORT + "/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ model: process.env.PI_TEST_MODE === "wrong-model" ? "other" : "native-preview",
      messages: [{ role: "user", content: prompt }] }),
  });
  const result = await response.json();
  console.log(result.choices[0].message.content);
} else console.log(prompt);
`,
  );
  for (const mode of ["request", "echo", "wrong-model"]) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const receipt = path.join(root, mode + ".json");
    const result = await captureOwned(
      process.execPath,
      [worker],
      {
        ...environment(root),
        PI_TEST_MODE: mode,
        NEMOCLAW_PI_HOME: path.join(root, mode),
        NEMOCLAW_PI_ENTRY: cli,
        NEMOCLAW_PI_MODEL_PORT: String(port),
        NEMOCLAW_PI_RESULT: receipt,
      },
      "",
      15000,
    );
    assert.equal(result.failure, null);
    if (mode === "request") {
      assert.equal(result.exitCode, 0, result.stderr);
      const observed = JSON.parse(fs.readFileSync(receipt, "utf8"));
      assert.deepEqual(
        observed.turns.map((turn: { modelRequests: string[] }) => turn.modelRequests),
        [1, 2, 3].map((index) => [`NATIVE_PI_TURN_${index}_OK`]),
      );
    } else {
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /expected local-model request/u);
      assert.equal(fs.existsSync(receipt), false);
    }
  }
});
