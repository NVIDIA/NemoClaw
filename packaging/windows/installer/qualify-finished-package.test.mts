// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { stripInheritedAcceptanceEnvironment } from "./qualify-installed-openclaw.mts";
import {
  environment,
  acceptanceProcessesStopped,
  retainedAcceptance,
  qualificationEnvironment,
  smokeAgent,
  turnArguments,
  validateTurn,
} from "./qualify-finished-package.mts";

for (const agent of ["hermes"] as const) {
  const identity = {
    runtimeId: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    sourceRevision: "c".repeat(40),
    nodeSha256: "d".repeat(64),
    nodeVersion: "22.23.2",
  };
  const configuration = JSON.stringify({ agent, credentialStored: true });
  const launcherAdmission = {
    launcherSha256: "e".repeat(64),
    packageBuildSha256: "f".repeat(64),
    artifactSourceSnapshotSha256: "1".repeat(64),
    controllerSourceRevision: "2".repeat(40),
  };
  const previous = {
    schemaVersion: 1,
    classification: "installed-canonical-hermes-acceptance",
    verdict: "pass",
    controllerRun: "123456:1",
    runtime: identity,
    cleanupErrors: [],
    results: {
      runtimeBootstrap: false,
      launcherAdmission,
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
          stateRoot: `C:\\NemoClawState-S-1-5-21-1000-pi`,
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
    "launcher-rejected",
    "changed-launcher-admission",
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
      const evidenceDirectories: string[] = [];
      const admissions: unknown[] = [];
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
            GITHUB_SHA: launcherAdmission.controllerSourceRevision,
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
            "--package-root": "C:\\RunnerTemp\\Package",
            "--artifact-source-snapshot": "C:\\RunnerTemp\\artifact-source.json",
            "--artifact-source-snapshot-sha256": launcherAdmission.artifactSourceSnapshotSha256,
          })[name] ?? fallback,
        fs: {
          readFileSync: () => JSON.stringify(identity),
          existsSync: () => false,
          mkdirSync() {},
          writeFileSync: (name: string, value: string) => {
            receipts[name] = JSON.parse(value);
          },
        },
        stripInheritedAcceptanceEnvironment,
        createHermesEvidenceDirectory: (output: string) => evidenceDirectories.push(output),
        randomBytes,
        acceptanceProcessesStopped,
        retainedAcceptance,
        admitInstalledHermesLauncher: (input: unknown) => {
          admissions.push(input);
          if (scenario === "launcher-rejected") throw new Error("fixture launcher rejected");
          return launcherAdmission;
        },
        readOpenedRegularFile: (name: string) =>
          name === "previous.json"
            ? scenario === "missing-receipt"
              ? null
              : JSON.stringify({
                  ...previous,
                  results: {
                    ...previous.results,
                    launcherAdmission:
                      scenario === "changed-launcher-admission"
                        ? { ...launcherAdmission, launcherSha256: "3".repeat(64) }
                        : launcherAdmission,
                  },
                })
            : configuration + (scenario === "changed-settings" ? " " : ""),
        nativeCredentialBinding: () => {
          throw new Error("fixture-stop after ownership check");
        },
        captureOwned: async (_launcher: string, args: string[], environment: NodeJS.ProcessEnv) => {
          assert.deepEqual(environment, {
            LOCALAPPDATA: "C:\\UserData",
            ProgramFiles: "C:\\Program Files",
            SystemRoot: "C:\\Windows",
          });
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
      assert.deepEqual(evidenceDirectories, ["C:\\RunnerTemp\\Evidence"]);
      assert.deepEqual(admissions, [
        {
          packageRoot: "C:\\RunnerTemp\\Package",
          launcher: "C:\\Installed\\bin\\NemoClaw.exe",
          sourceRevision: identity.sourceRevision,
          controllerRun: "123456:1",
          controllerSourceRevision: launcherAdmission.controllerSourceRevision,
          artifactSourceSnapshot: "C:\\RunnerTemp\\artifact-source.json",
          artifactSourceSnapshotSha256: launcherAdmission.artifactSourceSnapshotSha256,
        },
      ]);
      const expected = [
        "launcher-rejected",
        "changed-launcher-admission",
        "missing-receipt",
        "changed-settings",
      ].includes(scenario)
        ? []
        : [["--state-session", agent]];
      if (scenario === "owned-state") expected.push(["--remove-native-data", "--agent", agent]);
      assert.deepEqual(calls, expected);
      const receipt = receipts[`C:\\RunnerTemp\\Evidence\\installed-${agent}-acceptance.json`];
      assert.equal(receipt.verdict, "fail");
      assert.equal(receipt.controllerRun, "123456:1");
      assert.equal(receipt.results.configurationPreserved, false);
      assert.deepEqual(receipt.cleanupErrors, []);
      assert.equal(
        receipt.failedStage,
        scenario === "launcher-rejected" ? "launcher-input-admission" : "configuration",
      );
      if (scenario === "launcher-rejected")
        assert.match(receipt.error, /fixture launcher rejected/u);
      else if (["changed-launcher-admission", "missing-receipt"].includes(scenario))
        assert.match(receipt.error, /different package or controller/u);
      else if (scenario === "changed-settings") assert.match(receipt.error, /configuration/u);
      else if (["recreated-state", "other-state"].includes(scenario))
        assert.match(receipt.error, /different or recreated agent data/u);
      else if (scenario === "state-failure") assert.match(receipt.error, /fixture state failure/u);
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

test("OpenClaw smoke keeps its compiled route and rejects retired agents", () => {
  assert.equal(smokeAgent(), "openclaw");
  for (const agent of ["", "hermes", "pi", "langchain-deepagents-code", "nemocua", "../pi", "PI"])
    assert.throws(() => smokeAgent(agent));
  assert.deepEqual(turnArguments("openclaw", "evidence"), [
    "--native-turn",
    "--wait",
    "--qualification",
    "--artifact-directory",
    "evidence",
  ]);
});

function openClawReceipt() {
  return {
    verdict: "pass",
    exactReply: "CHAT_OK",
    openClawExecutionMode: "embedded-worker",
    workloadStopped: true,
    createWatcherStopped: true,
    gatewayStopped: true,
    sandboxDeleted: true,
    sandboxRegistryAbsent: true,
    qualificationRootsRemoved: true,
  };
}

test("OpenClaw smoke still requires its embedded reply and workload cleanup", (context) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-smoke-receipts-"));
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const file = path.join(output, "native-windows-turn-abcd.json");
  const receipt = {
    ...openClawReceipt(),
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
    { verdict: "fail" },
    { createWatcherStopped: false },
    { gatewayStopped: false },
    { sandboxDeleted: false },
    { sandboxRegistryAbsent: false },
    { qualificationRootsRemoved: false },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...receipt, ...change }));
    assert.throws(() => validateTurn("openclaw", output));
  }
});

test("receipt reads reject growth, links and path replacement and close the file", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-receipt-boundary-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "native-windows-turn-0123456789.json");
  const original = fs.lstatSync;
  const closes = context.mock.method(fs, "closeSync");
  for (const mode of ["growth", "link", "replacement"]) {
    fs.writeFileSync(file, JSON.stringify(openClawReceipt()));
    const check = context.mock.method(fs, "lstatSync", (name, ...args) => {
      const stat = original(name, ...args);
      if (name !== file) return stat;
      if (mode === "growth") {
        fs.appendFileSync(file, " ".repeat(1024 * 1024));
        return stat;
      }
      if (mode === "link") return Object.assign(stat, { isSymbolicLink: () => true });
      fs.renameSync(file, path.join(root, "original"));
      fs.writeFileSync(file, JSON.stringify(openClawReceipt()));
      return original(file);
    });
    const before = closes.mock.callCount();
    try {
      assert.throws(() => validateTurn("openclaw", root), /limit|link|identity/u);
      assert.ok(closes.mock.callCount() > before);
    } finally {
      check.mock.restore();
    }
  }
});
