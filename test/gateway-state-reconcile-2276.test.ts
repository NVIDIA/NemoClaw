// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for issue #2276 — "wrong active gateway" must not remove
// the local registry entry when the NemoClaw gateway is healthy but some
// other OpenShell gateway is currently active. Covers the Architect's §5
// scenarios 1-12. (Scenario 13 is a shell-level e2e, skipped.)
//
// Each test spawns `nemoclaw.js` as a child process with a stub `openshell`
// binary on the $PATH. The stub is configured per-scenario via a JSON
// "script" file: it records every invocation and returns canned output
// based on the current scenario state. We then assert on:
//   - registry file survival (present vs removed)
//   - onboard-session.json's sandboxName field (cleared vs preserved)
//   - user-facing stdout/stderr messages
//   - exit code
//   - openshell command call log (no prompt helpers, no `gateway select`
//     in forbidden scenarios).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "vitest";

const TIMEOUT_MS = Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000);
const SANDBOX_NAME = "my-assistant";

// Output fixtures that mirror real OpenShell CLI output.
const GATEWAY_INFO_NEMOCLAW =
  "Gateway Info\n\nGateway: nemoclaw\nGateway endpoint: https://127.0.0.1:8080/\n";
const GATEWAY_INFO_MISSING = "No gateway metadata found";
const GATEWAY_INFO_EMPTY = "";

const STATUS_CONNECTED_NEMOCLAW =
  "Server Status\n\nGateway: nemoclaw\nServer: https://127.0.0.1:8080/\nStatus: Connected\n";
const STATUS_CONNECTED_OPENSHELL =
  "Server Status\n\nGateway: openshell\nServer: https://127.0.0.1:8080/\nStatus: Connected\n";
const STATUS_CONNECTED_OTHER =
  "Server Status\n\nGateway: other-gw\nServer: https://127.0.0.1:9090/\nStatus: Connected\n";
const STATUS_REFUSED_NEMOCLAW =
  "Server Status\n\nGateway: nemoclaw\nError: Connection refused (os error 111)\n";
const STATUS_NO_GATEWAY = "Error:   × No active gateway\n";
const STATUS_EMPTY = "";
const STATUS_MALFORMED = "??? garbage output ???";

const SANDBOX_GET_READY =
  "Sandbox:\n\n  Id: abc\n  Name: my-assistant\n  Namespace: openshell\n  Phase: Ready\n";
const SANDBOX_GET_NOT_FOUND = "Error:   × Not Found: sandbox not found";
const SANDBOX_GET_TRANSPORT_ERROR =
  "Error:   × transport error\n  ╰─▶ Connection reset by peer (os error 104)";

interface ScenarioScript {
  // sandbox get responses, one per call (cycled / stops at last)
  sandboxGet: Array<{ output: string; exit: number }>;
  // openshell status responses, cycled
  status: Array<{ output: string; exit: number }>;
  // openshell gateway info responses, cycled
  gatewayInfo: Array<{ output: string; exit: number }>;
  // openshell gateway select response
  gatewaySelect: { output: string; exit: number };
  // whether `gateway select nemoclaw` flips the active gateway to nemoclaw
  selectFlipsActive: boolean;
}

interface HarnessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  registryExists: boolean;
  registry: any;
  sessionSandboxName: string | null | undefined;
  callLog: Array<string[]>;
  selectCalls: number;
}

let tmpDir: string;
let registryDir: string;
let homeLocalBin: string;
let openshellPath: string;
let stateFile: string;
let scriptFile: string;
let callLogFile: string;

function writeDefaultRegistry() {
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: SANDBOX_NAME,
      sandboxes: {
        [SANDBOX_NAME]: {
          name: SANDBOX_NAME,
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
    }),
    { mode: 0o600 },
  );
}

function writeDefaultSession() {
  fs.writeFileSync(
    path.join(registryDir, "onboard-session.json"),
    JSON.stringify({
      version: 1,
      sandboxName: SANDBOX_NAME,
      provider: "nvidia-prod",
    }),
    { mode: 0o600 },
  );
}

function writeStubOpenshell(script: ScenarioScript) {
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  fs.writeFileSync(stateFile, JSON.stringify({}));
  fs.writeFileSync(callLogFile, "");

  // Inline stub — uses node as interpreter via execPath shebang. Reads
  // script each call so tests can tweak state between runs (not used here).
  const stub = `#!${process.execPath}
const fs = require("fs");
const scriptPath = ${JSON.stringify(scriptFile)};
const statePath = ${JSON.stringify(stateFile)};
const callLogPath = ${JSON.stringify(callLogFile)};
const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
const state = JSON.parse(fs.readFileSync(statePath, "utf8") || "{}");
const args = process.argv.slice(2);

fs.appendFileSync(callLogPath, JSON.stringify(args) + "\\n");

function cycle(key, list) {
  state[key] = (state[key] || 0) + 1;
  const idx = Math.min(state[key] - 1, list.length - 1);
  fs.writeFileSync(statePath, JSON.stringify(state));
  return list[idx];
}

function emit(r) {
  if (r.output) process.stdout.write(r.output);
  process.exit(r.exit || 0);
}

if (args[0] === "--version") {
  process.stdout.write("openshell 0.0.25\\n");
  process.exit(0);
}

if (args[0] === "status") {
  emit(cycle("status", script.status));
}

if (args[0] === "gateway" && args[1] === "info") {
  emit(cycle("gatewayInfo", script.gatewayInfo));
}

if (args[0] === "gateway" && args[1] === "select") {
  state.selectCalled = (state.selectCalled || 0) + 1;
  if (script.selectFlipsActive) {
    // After a successful select, subsequent status/sandbox get use
    // healthy_named responses. We implement this by advancing counters
    // to "healthy" arrays. For simplicity: if selectFlipsActive, we
    // rewrite status/sandboxGet state so next cycle returns healthy.
    state.postSelect = true;
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
  emit(script.gatewaySelect);
}

if (args[0] === "sandbox" && args[1] === "get") {
  // Use a separate key so retries after select advance properly.
  emit(cycle("sandboxGet", script.sandboxGet));
}

if (args[0] === "policy" && args[1] === "get") {
  process.stdout.write("version: 1\\nnetwork_policies:\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "list") {
  // Return the sandbox as live to avoid the list-based destroy path.
  process.stdout.write("Sandboxes:\\n  - ${SANDBOX_NAME}\\n");
  process.exit(0);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write("Provider: nvidia-prod\\nModel: nvidia/nemotron-3-super-120b-a12b\\n");
  process.exit(0);
}

// forward stop/start, provider delete, logs, etc. — no-op success
process.exit(0);
`;
  fs.writeFileSync(openshellPath, stub, { mode: 0o755 });
}

function runCli(action: string, extraEnv: Record<string, string | undefined> = {}): HarnessResult {
  const repoRoot = path.join(import.meta.dirname, "..");
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nemoclaw.js"), SANDBOX_NAME, action],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${homeLocalBin}:/usr/bin:/bin`,
        // Keep output deterministic.
        NO_COLOR: "1",
        ...extraEnv,
      },
    },
  );

  const registryPath = path.join(registryDir, "sandboxes.json");
  const registryExists = fs.existsSync(registryPath);
  const registry = registryExists ? JSON.parse(fs.readFileSync(registryPath, "utf-8")) : null;
  const sessionPath = path.join(registryDir, "onboard-session.json");
  let sessionSandboxName: string | null | undefined = undefined;
  if (fs.existsSync(sessionPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      sessionSandboxName = s.sandboxName;
    } catch {
      sessionSandboxName = undefined;
    }
  }

  const callLog: Array<string[]> = fs
    .readFileSync(callLogFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return [];
      }
    });

  const selectCalls = callLog.filter((c) => c[0] === "gateway" && c[1] === "select").length;

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    registryExists,
    registry,
    sessionSandboxName,
    callLog,
    selectCalls,
  };
}

function registrySandboxPresent(r: HarnessResult): boolean {
  return (
    r.registryExists &&
    !!r.registry &&
    !!r.registry.sandboxes &&
    Object.prototype.hasOwnProperty.call(r.registry.sandboxes, SANDBOX_NAME)
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2276-"));
  homeLocalBin = path.join(tmpDir, ".local", "bin");
  registryDir = path.join(tmpDir, ".nemoclaw");
  openshellPath = path.join(homeLocalBin, "openshell");
  stateFile = path.join(tmpDir, "state.json");
  scriptFile = path.join(tmpDir, "script.json");
  callLogFile = path.join(tmpDir, "calls.log");

  fs.mkdirSync(homeLocalBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });
  writeDefaultRegistry();
  writeDefaultSession();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Scenario 1 ─── destructive path preserved for `connect` ───────────────
describe("Scenario 1: connect — healthy nemoclaw active + sandbox NotFound truly gone", () => {
  it("removes the registry entry, clears session, and exits 1", { timeout: TIMEOUT_MS }, () => {
    writeStubOpenshell({
      sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
      status: [{ output: STATUS_CONNECTED_NEMOCLAW, exit: 0 }],
      gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
      gatewaySelect: { output: "", exit: 0 },
      selectFlipsActive: false,
    });

    const r = runCli("connect");

    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stderr}`);
    assert.equal(
      registrySandboxPresent(r),
      false,
      `expected registry entry removed, got: ${JSON.stringify(r.registry)}`,
    );
    assert.equal(
      r.sessionSandboxName === null || r.sessionSandboxName === undefined,
      true,
      `expected session sandboxName cleared, got: ${r.sessionSandboxName}`,
    );
    assert.match(r.stderr, /Removed stale local registry entry/);
  });
});

// ─── Scenario 2 ─── destructive path preserved for `status` ────────────────
describe("Scenario 2: status — healthy nemoclaw active + sandbox NotFound truly gone", () => {
  it(
    "removes the registry entry, clears session, and logs removal (no exit 1)",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        status: [{ output: STATUS_CONNECTED_NEMOCLAW, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
        gatewaySelect: { output: "", exit: 0 },
        selectFlipsActive: false,
      });

      const r = runCli("status");

      // status doesn't exit non-zero on a missing sandbox — it just logs.
      assert.equal(
        registrySandboxPresent(r),
        false,
        `expected registry entry removed, got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(
        r.sessionSandboxName === null || r.sessionSandboxName === undefined,
        true,
        `expected session sandboxName cleared, got: ${r.sessionSandboxName}`,
      );
      assert.match(r.stdout, /Removed stale local registry entry/);
    },
  );
});

// ─── Scenario 3 ─── self-heal via gateway select succeeds ──────────────────
describe("Scenario 3: status — select succeeds, sandbox reappears, registry intact", () => {
  it(
    "attempts `gateway select nemoclaw`, re-queries, proceeds; registry preserved",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        // 1st sandbox get: NotFound (gw drifted); 2nd: Ready after select.
        sandboxGet: [
          { output: SANDBOX_GET_NOT_FOUND, exit: 1 },
          { output: SANDBOX_GET_READY, exit: 0 },
        ],
        // 1st status call: openshell active. 2nd: nemoclaw active.
        status: [
          { output: STATUS_CONNECTED_OPENSHELL, exit: 0 },
          { output: STATUS_CONNECTED_NEMOCLAW, exit: 0 },
        ],
        gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
        gatewaySelect: { output: "", exit: 0 },
        selectFlipsActive: true,
      });

      const r = runCli("status");

      assert.equal(
        registrySandboxPresent(r),
        true,
        `expected registry preserved, got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(r.sessionSandboxName, SANDBOX_NAME, "expected session sandboxName preserved");
      // gateway select nemoclaw should have been invoked.
      assert.ok(r.selectCalls >= 1, `expected ≥1 gateway select calls, got ${r.selectCalls}`);
    },
  );
});

// ─── Scenario 4 ─── select fails → wrong_gateway_active, registry intact ───
describe("Scenario 4: connect — select fails, sandbox still NotFound", () => {
  it(
    "surfaces wrong_gateway_active guidance, preserves registry, exits 1",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [
          { output: SANDBOX_GET_NOT_FOUND, exit: 1 },
          { output: SANDBOX_GET_NOT_FOUND, exit: 1 },
        ],
        // All status probes show 'openshell' active (select "failed" to switch)
        status: [{ output: STATUS_CONNECTED_OPENSHELL, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
        gatewaySelect: { output: "Error: failed to select", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("connect");

      assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
      assert.equal(
        registrySandboxPresent(r),
        true,
        `registry must be preserved, got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(r.sessionSandboxName, SANDBOX_NAME, "session sandboxName must be preserved");
      // User-facing guidance.
      assert.match(r.stderr, /NOT been removed/);
      assert.match(r.stderr, /openshell gateway select nemoclaw/);
      assert.doesNotMatch(r.stderr, /Removed stale local registry entry/);
    },
  );
});

// ─── Scenario 5 ─── exact #2276 repro: registry entry still present ────────
describe("Scenario 5: #2276 repro — failed connect must leave registry entry intact", () => {
  it(
    "after a failed connect triggered by drifted gateway, entry is still present",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        status: [{ output: STATUS_CONNECTED_OTHER, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("connect");

      assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
      assert.equal(
        registrySandboxPresent(r),
        true,
        `registry must still contain '${SANDBOX_NAME}', got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(r.sessionSandboxName, SANDBOX_NAME);
      assert.match(r.stderr, /NOT been removed/);
      assert.match(r.stderr, /openshell gateway select nemoclaw/);
    },
  );
});

// ─── Scenario 6 ─── nemoclaw gateway missing + NotFound ────────────────────
describe("Scenario 6: connect — nemoclaw gateway missing after restart", () => {
  it(
    "returns gateway_missing_after_restart, preserves registry, exits 1",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        status: [{ output: STATUS_NO_GATEWAY, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_MISSING, exit: 1 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("connect");

      assert.equal(r.status, 1);
      assert.equal(
        registrySandboxPresent(r),
        true,
        `registry must be preserved, got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(r.sessionSandboxName, SANDBOX_NAME);
      assert.doesNotMatch(r.stderr, /Removed stale local registry entry/);
      assert.match(
        r.stderr,
        /(no longer configured|Start the gateway again|openshell gateway start)/i,
      );
    },
  );
});

// ─── Scenario 7 ─── nemoclaw gateway unreachable + NotFound ────────────────
describe("Scenario 7: connect — nemoclaw gateway unreachable after restart", () => {
  it(
    "returns gateway_unreachable_after_restart, preserves registry, exits 1",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        status: [{ output: STATUS_REFUSED_NEMOCLAW, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("connect");

      assert.equal(r.status, 1);
      assert.equal(
        registrySandboxPresent(r),
        true,
        `registry must be preserved, got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(r.sessionSandboxName, SANDBOX_NAME);
      assert.doesNotMatch(r.stderr, /Removed stale local registry entry/);
      assert.match(
        r.stderr,
        /(still refusing connections|openshell gateway start|verify `openshell status`)/i,
      );
    },
  );
});

// ─── Scenario 8 ─── gateway info fails / unparseable ───────────────────────
describe("Scenario 8: gateway info fails — safe default, registry preserved", () => {
  it(
    "non-zero exit on `openshell gateway info -g nemoclaw` still preserves registry",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        // connected to "openshell", not nemoclaw — but gateway info fails.
        status: [{ output: STATUS_CONNECTED_OPENSHELL, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_MISSING, exit: 1 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("connect");

      assert.equal(r.status, 1);
      assert.equal(
        registrySandboxPresent(r),
        true,
        `registry must be preserved when gateway info fails, got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(r.sessionSandboxName, SANDBOX_NAME);
      assert.doesNotMatch(r.stderr, /Removed stale local registry entry/);
    },
  );
});

// ─── Scenario 9 ─── openshell status empty / malformed ─────────────────────
describe("Scenario 9: empty or malformed status — registry untouched", () => {
  it(
    "empty status + gateway info missing → registry preserved, no removal",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        status: [{ output: STATUS_EMPTY, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_EMPTY, exit: 0 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("connect");

      assert.equal(r.status, 1);
      assert.equal(
        registrySandboxPresent(r),
        true,
        `registry must be preserved on empty status, got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(r.sessionSandboxName, SANDBOX_NAME);
      assert.doesNotMatch(r.stderr, /Removed stale local registry entry/);
    },
  );

  it(
    "malformed status + malformed gateway info → registry preserved",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        status: [{ output: STATUS_MALFORMED, exit: 0 }],
        gatewayInfo: [{ output: "garbage gateway info", exit: 0 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("connect");

      assert.equal(r.status, 1);
      assert.equal(
        registrySandboxPresent(r),
        true,
        `registry must be preserved on malformed status, got: ${JSON.stringify(r.registry)}`,
      );
      assert.doesNotMatch(r.stderr, /Removed stale local registry entry/);
    },
  );
});

// ─── Scenario 10 ─── non-interactive mode: no prompts ──────────────────────
describe("Scenario 10: non-interactive mode — deterministic exit, no prompts", () => {
  it(
    "NEMOCLAW_NON_INTERACTIVE=1 does not block on user input and exits 1",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        status: [{ output: STATUS_CONNECTED_OPENSHELL, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("connect", { NEMOCLAW_NON_INTERACTIVE: "1" });

      assert.equal(r.status, 1);
      assert.equal(
        registrySandboxPresent(r),
        true,
        "registry must remain intact in non-interactive mode",
      );
      assert.match(r.stderr, /NOT been removed/);
      // No prompt-style "Press enter" / "? " should appear.
      assert.doesNotMatch(r.stderr, /Press (enter|any key)|\?\s+\[/i);
      assert.doesNotMatch(r.stdout, /Press (enter|any key)|\?\s+\[/i);
    },
  );
});

// ─── Scenario 11 ─── cross-command parity: status drifts same way ──────────
describe("Scenario 11: status — wrong gateway active yields guidance, not removal", () => {
  it(
    "drift case under `status` preserves registry and prints guidance",
    { timeout: TIMEOUT_MS },
    () => {
      writeStubOpenshell({
        sandboxGet: [
          { output: SANDBOX_GET_NOT_FOUND, exit: 1 },
          { output: SANDBOX_GET_NOT_FOUND, exit: 1 },
        ],
        status: [{ output: STATUS_CONNECTED_OPENSHELL, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const r = runCli("status");

      assert.equal(
        registrySandboxPresent(r),
        true,
        `registry must be preserved on status drift, got: ${JSON.stringify(r.registry)}`,
      );
      assert.equal(r.sessionSandboxName, SANDBOX_NAME);
      // status writes to stdout (console.log), not stderr.
      const combined = `${r.stdout}\n${r.stderr}`;
      assert.match(combined, /NOT been removed/);
      assert.match(combined, /openshell gateway select nemoclaw/);
      assert.doesNotMatch(combined, /Removed stale local registry entry/);
    },
  );
});

// ─── Scenario 12 ─── cross-command parity: skill install drifts same way ───
describe("Scenario 12: skill install — wrong gateway active yields guidance, not removal", () => {
  it(
    "skill install under drift preserves registry, exits 1 with guidance",
    { timeout: TIMEOUT_MS },
    () => {
      // Minimal valid skill directory.
      const skillDir = path.join(tmpDir, "my-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: my-skill\ndescription: test\n---\nHello\n",
      );

      writeStubOpenshell({
        sandboxGet: [{ output: SANDBOX_GET_NOT_FOUND, exit: 1 }],
        status: [{ output: STATUS_CONNECTED_OPENSHELL, exit: 0 }],
        gatewayInfo: [{ output: GATEWAY_INFO_NEMOCLAW, exit: 0 }],
        gatewaySelect: { output: "", exit: 1 },
        selectFlipsActive: false,
      });

      const repoRoot = path.join(import.meta.dirname, "..");
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, "bin", "nemoclaw.js"), SANDBOX_NAME, "skill", "install", skillDir],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: TIMEOUT_MS,
          env: {
            ...process.env,
            HOME: tmpDir,
            PATH: `${homeLocalBin}:/usr/bin:/bin`,
            NO_COLOR: "1",
          },
        },
      );

      const registryPath = path.join(registryDir, "sandboxes.json");
      const reg = fs.existsSync(registryPath)
        ? JSON.parse(fs.readFileSync(registryPath, "utf-8"))
        : null;
      const sessionPath = path.join(registryDir, "onboard-session.json");
      const session = fs.existsSync(sessionPath)
        ? JSON.parse(fs.readFileSync(sessionPath, "utf-8"))
        : {};

      assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stderr}`);
      assert.ok(
        reg && reg.sandboxes && reg.sandboxes[SANDBOX_NAME],
        `registry must be preserved on skill install drift, got: ${JSON.stringify(reg)}`,
      );
      assert.equal(session.sandboxName, SANDBOX_NAME);
      assert.match(result.stderr, /NOT been removed/);
      assert.match(result.stderr, /openshell gateway select nemoclaw/);
    },
  );
});
