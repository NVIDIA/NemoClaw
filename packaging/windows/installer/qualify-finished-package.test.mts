// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import {
  environment,
  acceptanceProcessesStopped,
  retainedAcceptance,
  qualificationEnvironment,
  captureOwned,
  smokeAgent,
  turnArguments,
  validateTurn,
} from "./qualify-finished-package.mts";
import { piWorkloadSource } from "../runtime/run-installed-native-pi.mts";
import { retainedPiAcceptance } from "./qualify-installed-pi.mts";

for (const agent of ["pi", "hermes"] as const) {
  const identity = {
    runtimeId: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    sourceRevision: "c".repeat(40),
    nodeSha256: "d".repeat(64),
    nodeVersion: "22.23.2",
  };
  const configuration = JSON.stringify({ agent, credentialStored: true });
  const previous = {
    schemaVersion: 1,
    classification:
      agent === "pi" ? "installed-pi-terminal-acceptance" : "installed-canonical-hermes-acceptance",
    verdict: "pass",
    controllerRun: "123456:1",
    runtime: identity,
    cleanupErrors: [],
    results: {
      configurationReused: false,
      configurationPreserved: true,
      realTerminal: true,
      realModelReply: true,
      fileToolsQualified: true,
      configurationSha256: createHash("sha256").update(configuration).digest("hex"),
      stateRoot: `C:\\NemoClawState-S-1-5-21-1000-${agent}`,
      cleanup: { cleanupSucceeded: true, stateRetained: true },
    },
  };
  test(`${agent} restart requires the same run, artifact, agent, saved settings and successful cleanup`, () => {
    assert.equal(
      retainedAcceptance(agent, previous, identity, configuration, "123456:1"),
      previous.results.stateRoot,
    );
    for (const changed of [
      null,
      {},
      { ...previous, schemaVersion: 2 },
      { ...previous, classification: "other-agent" },
      { ...previous, verdict: "fail" },
      { ...previous, controllerRun: "123457:1" },
      { ...previous, controllerRun: "123456:2" },
      { ...previous, cleanupErrors: ["retained sandbox"] },
      { ...previous, results: { ...previous.results, configurationReused: true } },
      { ...previous, results: { ...previous.results, configurationPreserved: false } },
      {
        ...previous,
        results: { ...previous.results, cleanup: { cleanupSucceeded: false, stateRetained: true } },
      },
      {
        ...previous,
        results: { ...previous.results, cleanup: { cleanupSucceeded: true, stateRetained: false } },
      },
      { ...previous, results: { ...previous.results, stateRoot: "C:\\Unowned" } },
      {
        ...previous,
        results: {
          ...previous.results,
          stateRoot: `C:\\NemoClawState-S-1-5-21-1000-${agent === "pi" ? "hermes" : "pi"}`,
        },
      },
    ])
      assert.throws(() =>
        retainedAcceptance(agent, changed as any, identity, configuration, "123456:1"),
      );
    for (const field of Object.keys(identity))
      assert.throws(() =>
        retainedAcceptance(
          agent,
          { ...previous, runtime: { ...identity, [field]: "different" } },
          identity,
          configuration,
          "123456:1",
        ),
      );
    assert.throws(() =>
      retainedAcceptance(agent, previous, identity, configuration + " ", "123456:1"),
    );
    assert.throws(() =>
      retainedAcceptance(agent, { ...previous, runtime: {} }, {}, configuration, "123456:1"),
    );
    assert.throws(() =>
      retainedAcceptance(agent, previous, identity, configuration, "undefined:undefined"),
    );
  });

  for (const scenario of [
    "missing-receipt",
    "changed-settings",
    "recreated-state",
    "other-state",
    "state-failure",
    "owned-state",
  ])
    test(`${agent} actual restart cleanup refuses unowned data: ${scenario}`, async () => {
      const source = fs.readFileSync(
        new URL(`./qualify-installed-${agent}.mts`, import.meta.url),
        "utf8",
      );
      const start = source.indexOf("async function main() {");
      const end = source.indexOf("\nif (process.argv[1]", start);
      assert(start > 0 && end > start);
      const body = source
        .slice(start, end)
        .replaceAll("import.meta.url", '"file:///qualification.mts"');
      const calls: string[][] = [];
      const receipts: Record<string, any> = {};
      const bindings = {
        assert,
        path: path.win32,
        process: {
          platform: "win32",
          arch: "arm64",
          version: "v22.23.2",
          argv: ["--reuse-configuration"],
          env: {
            GITHUB_ACTIONS: "true",
            GITHUB_RUN_ID: "123456",
            GITHUB_RUN_ATTEMPT: "1",
            NVIDIA_API_KEY: "nvapi-synthetic-fixture",
            LOCALAPPDATA: "C:\\UserData",
            ProgramFiles: "C:\\Program Files",
            RUNNER_TEMP: "C:\\RunnerTemp",
            SystemRoot: "C:\\Windows",
          },
        },
        argument: (name: string, fallback?: string) =>
          ({
            "--install-root": "C:\\Installed",
            "--output": "C:\\RunnerTemp\\Evidence",
            "--runtime-identity": "identity.json",
            "--previous-acceptance": "previous.json",
          })[name] ?? fallback,
        fs: {
          readFileSync: () => JSON.stringify(identity),
          existsSync: () => false,
          mkdirSync() {},
          writeFileSync: (name: string, value: string) => {
            receipts[name] = JSON.parse(value);
          },
        },
        childEnvironment: () => ({}),
        randomBytes,
        acceptanceProcessesStopped,
        retainedAcceptance,
        retainedPiAcceptance,
        readOpenedRegularFile: (name: string) =>
          name === "previous.json"
            ? scenario === "missing-receipt"
              ? null
              : JSON.stringify(previous)
            : configuration + (scenario === "changed-settings" ? " " : ""),
        nativeCredentialBinding: () => {
          throw new Error("fixture-stop after ownership check");
        },
        captureOwned: async (_launcher: string, args: string[]) => {
          calls.push(args);
          return {
            failure: scenario === "state-failure" ? "fixture state failure" : null,
            exitCode: 0,
            stdout: JSON.stringify({
              agent,
              leaseHeld: true,
              stateRoot:
                scenario === "other-state"
                  ? previous.results.stateRoot.replace("1000", "2000")
                  : previous.results.stateRoot,
              created: scenario === "recreated-state",
            }),
          };
        },
        sanitizedFailure: (error: unknown) => String(error),
      };
      const main = new Function(
        ...Object.keys(bindings),
        `${stripTypeScriptTypes(body)}\nreturn main;`,
      )(...Object.values(bindings));
      await assert.rejects(main());
      const expected = ["missing-receipt", "changed-settings"].includes(scenario)
        ? []
        : [["--state-session", agent]];
      if (scenario === "owned-state") expected.push(["--remove-native-data", "--agent", agent]);
      assert.deepEqual(calls, expected);
      const receipt = receipts[`C:\\RunnerTemp\\Evidence\\installed-${agent}-acceptance.json`];
      assert.equal(receipt.verdict, "fail");
      assert.equal(receipt.results.configurationPreserved, false);
      assert.deepEqual(receipt.cleanupErrors, []);
      if (scenario === "owned-state")
        assert.match(receipt.error, /fixture-stop after ownership check/u);
    });
}

test("cleanup requires confirmed exit, not a successful kill request", async (context) => {
  assert.equal(acceptanceProcessesStopped(undefined), true);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: qualificationEnvironment(process.env),
    stdio: "ignore",
    windowsHide: true,
  });
  const finished = once(child, "close");
  context.after(async () => {
    child.kill();
    await finished;
  });
  await once(child, "spawn");
  const stopped = { exitCode: 0, signalCode: null };
  assert.equal(acceptanceProcessesStopped(stopped, child), false);
  assert.equal(child.kill(), true);
  assert.equal(acceptanceProcessesStopped(stopped, child), false);
  await finished;
  assert.equal(acceptanceProcessesStopped(stopped, child), true);
});

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

test("observer additions stay out of product children and do not admit secrets", () => {
  const input = {
    SystemRoot: "windows",
    PATH: "tools",
    GITHUB_ACTIONS: "true",
    RUNNER_TEMP: "runner-temp",
    PSModulePath: "modules",
    "ProgramFiles(x86)": "programs",
    NVIDIA_API_KEY: "secret",
    NODE_OPTIONS: "--require injected",
    NEMOCLAW_NATIVE_INSTALL_ROOT: "untrusted",
  };
  assert.deepEqual(qualificationEnvironment(input), { SystemRoot: "windows", PATH: "tools" });
  assert.deepEqual(qualificationEnvironment(input, true), {
    SystemRoot: "windows",
    PATH: "tools",
    GITHUB_ACTIONS: "true",
    PSModulePath: "modules",
    "ProgramFiles(x86)": "programs",
  });
  assert.deepEqual(environment("installed", input), {
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
