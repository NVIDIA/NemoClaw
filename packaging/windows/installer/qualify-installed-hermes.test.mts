// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { acceptanceProcessesStopped } from "./qualify-finished-package.mts";
import {
  recordedHermesTerminal,
  hermesInstalledToolCommand,
  hermesInstalledCodeCommand,
  recordedHermesCode,
  recordedHermesBrowser,
  validateHermesEdgeReceipt,
  createHermesPtyState,
  finalHermesAssistant,
} from "./qualify-installed-hermes.mts";

for (const existing of ["configuration", "agent-data"])
  test(`fresh Hermes rejection preserves pre-existing ${existing} and credentials`, async () => {
    const source = fs.readFileSync(
      new URL("./qualify-installed-hermes.mts", import.meta.url),
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
        argv: [],
        env: {
          GITHUB_ACTIONS: "true",
          NVIDIA_API_KEY: "nvapi-synthetic-fixture",
          LOCALAPPDATA: "C:\\UserData",
          SystemRoot: "C:\\Windows",
        },
      },
      argument: (name: string, fallback?: string) =>
        ({
          "--install-root": "C:\\Installed",
          "--output": "C:\\Evidence",
          "--runtime-identity": "identity.json",
        })[name] ?? fallback,
      fs: {
        readFileSync: () => "{}",
        existsSync: (name: string) => existing === "configuration" && name !== "C:\\Evidence",
        mkdirSync() {},
        writeFileSync: (name: string, value: string) => {
          receipts[name] = JSON.parse(value);
        },
      },
      childEnvironment: () => ({}),
      nativeCredentialBinding: () => "synthetic-binding",
      acceptanceProcessesStopped,
      captureOwned: async (_launcher: string, args: string[]) => {
        calls.push(args);
        assert.deepEqual(args, ["--state-session", "hermes"]);
        return {
          failure: null,
          exitCode: 0,
          stdout: JSON.stringify({
            agent: "hermes",
            leaseHeld: true,
            stateRoot: "C:\\NemoClawState-S-1-5-21-1000-hermes",
            created: false,
          }),
        };
      },
      sanitizedFailure: (error: unknown) => String(error),
    };
    const main = new Function(
      ...Object.keys(bindings),
      `${stripTypeScriptTypes(body)}\nreturn main;`,
    )(...Object.values(bindings));
    await assert.rejects(
      main(),
      /Fresh Hermes acceptance (requires no saved configuration|cannot use pre-existing agent data)/u,
    );
    assert.deepEqual(calls, existing === "configuration" ? [] : [["--state-session", "hermes"]]);
    const receipt = receipts["C:\\Evidence\\installed-hermes-acceptance.json"];
    assert.equal(receipt.verdict, "fail");
    assert.equal(receipt.failedStage, "configuration");
    assert.deepEqual(receipt.cleanupErrors, []);
  });

test("Hermes Edge acceptance requires the exact browser_exec code and successful sentinel", () => {
  const code = "print('EDGE_SENTINEL')";
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        { id: "browser", function: { name: "browser_exec", arguments: JSON.stringify({ code }) } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "browser",
      content: JSON.stringify({ success: true, exit_code: 0, output: "EDGE_SENTINEL\n" }),
    },
  ];
  assert(recordedHermesBrowser(messages, code, "EDGE_SENTINEL"));
  assert.equal(recordedHermesBrowser(messages, "different", "EDGE_SENTINEL"), null);
  assert.equal(
    recordedHermesBrowser(
      [messages[0], { ...messages[1], content: JSON.stringify({ success: false, exit_code: 1 }) }],
      code,
      "EDGE_SENTINEL",
    ),
    null,
  );
});

test("Hermes Edge receipt is bound to the exact native session", () => {
  const receipt = {
    schemaVersion: 1,
    classification: "native-hermes-edge-browser",
    agent: "hermes",
    sessionId: "session-1",
    identity: {
      architecture: "arm64",
      machine: 0xaa64,
      signatureStatus: "Valid",
      signerSubject: "Microsoft Corporation",
      provenance: "standard-windows-microsoft-edge-installation",
      path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      sha256: "a".repeat(64),
    },
    process: { pid: 42, creationTimeFileTime: "134000000000000000" },
    endpoint: { host: "127.0.0.1", port: 49152, path: "/devtools/browser/id-1" },
    authenticatedRelay: true,
    generalHostProxy: false,
    inheritedKillOnCloseJob: true,
  };
  assert.equal(validateHermesEdgeReceipt(receipt, "session-1"), receipt);
  assert.throws(() => validateHermesEdgeReceipt(receipt, "session-2"));
  assert.throws(() =>
    validateHermesEdgeReceipt({ ...receipt, generalHostProxy: true }, "session-1"),
  );
});

test("Hermes acceptance requires an exact model tool call and matching successful tool result", () => {
  const command = "printf fixture";
  const messages = [
    {
      role: "assistant",
      content: "fixture",
      tool_calls: [
        { id: "owned", function: { name: "terminal", arguments: JSON.stringify({ command }) } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "owned",
      content: JSON.stringify({ output: "fixture", exit_code: 0, error: null }),
    },
  ];
  assert(recordedHermesTerminal(messages, command, "fixture"));
  for (const changed of [
    [{ role: "assistant", content: "fixture" }],
    [messages[0], { ...messages[1], tool_call_id: "other" }],
    [
      messages[0],
      { ...messages[1], content: JSON.stringify({ output: "fixture", exit_code: 1, error: null }) },
    ],
    [
      messages[0],
      {
        ...messages[1],
        content: JSON.stringify({ output: "fixture", exit_code: 0, error: "failed" }),
      },
    ],
  ])
    assert.equal(recordedHermesTerminal(changed, command, "fixture"), null);
  assert.equal(recordedHermesTerminal(messages, "different command", "fixture"), null);
});

test(
  "the actual tool command performs its file, ripgrep and Python temporary roundtrip",
  { skip: process.platform === "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tool-command-"));
    try {
      fs.symlinkSync(
        process.env.NEMOCLAW_TEST_PYTHON ?? "/opt/homebrew/bin/python3",
        path.join(root, "python"),
      );
      if (process.env.NEMOCLAW_TEST_RG)
        fs.symlinkSync(process.env.NEMOCLAW_TEST_RG, path.join(root, "rg"));
      const nonce = "a".repeat(20);
      const result = spawnSync("/bin/bash", ["-c", hermesInstalledToolCommand(nonce)], {
        cwd: root,
        env: { ...process.env, PATH: root + path.delimiter + process.env.PATH },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim().split("\n").length, 3);
      assert(result.stdout.includes("NEMOCLAW_TOOLS_" + nonce));
      assert(!fs.existsSync(path.join(root, "nemoclaw-" + nonce + ".txt")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("actual PTY readiness excludes sidecar, lazy agent and tool completion before settled turn", () => {
  const state = createHermesPtyState();
  const info = (seq: number, payload: object = {}) => ({
    method: "event",
    params: {
      type: "session.info",
      session_id: "real-runtime",
      seq,
      payload: {
        version: "0.21.1",
        lazy: false,
        running: false,
        stored_session_id: "saved-real",
        ...payload,
      },
    },
  });
  state.bindEvents("actual-pty");
  state.bindPty("actual-pty");
  state.ptyData();
  // entry.py publishes this global before attaching the real session.
  state.receive("actual-pty", { method: "event", params: { type: "gateway.ready" } });
  // server._event_frame preserves an explicit empty session id for other
  // intentionally unsequenced global events.
  state.receive("actual-pty", {
    method: "event",
    params: { type: "sessions.changed", session_id: "", payload: {} },
  });
  state.assertHealthy();
  assert.equal(state.usable(), false);
  state.receive("sidecar", info(1));
  assert.equal(state.usable(), false);
  state.receive("actual-pty", info(1, { lazy: true }));
  assert.equal(state.usable(), false);
  state.receive("actual-pty", info(2, { running: true }));
  assert.equal(state.usable(), false);
  state.receive("actual-pty", info(3));
  assert.equal(state.usable(), true);
  assert.equal(state.storedSessionId(), "saved-real");
  const mark = state.markTurn();
  const event = (type: string, seq: number) => ({
    method: "event",
    // prompt_turn.py emits message.start without payload; server omits None.
    params: { type, session_id: "real-runtime", seq },
  });
  state.receive("actual-pty", event("message.start", 4));
  state.receive("actual-pty", event("tool.complete", 5));
  state.receive("actual-pty", info(6));
  assert.equal(state.settledAfter(mark), false);
  state.receive("actual-pty", event("message.complete", 7));
  assert.equal(state.settledAfter(mark), false);
  state.receive("actual-pty", info(8));
  assert.equal(state.settledAfter(mark), true);
  state.beginIdle(mark);
  state.receive("actual-pty", event("message.start", 9));
  assert.throws(() => state.assertHealthy(), /idle sample/u);
});

test("closing one same-channel PTY connection preserves the remaining live connection", () => {
  const state = createHermesPtyState();
  state.bindEvents("actual-pty");
  state.bindPty("actual-pty");
  state.bindPty("actual-pty");
  state.ptyData();
  state.ptyClosed("actual-pty");
  state.assertHealthy();
  state.ptyClosed("actual-pty");
  assert.throws(() => state.assertHealthy(), /PTY socket closed/u);
});

test("settled conversation still needs a final saved assistant and a real execute_code kernel bootstrap", () => {
  const code = hermesInstalledCodeCommand("b".repeat(20));
  const sentinel = "NEMOCLAW_EXECUTE_CODE_" + "b".repeat(20);
  const prompt = "controlled prompt";
  const messages: any[] = [
    { role: "user", content: prompt },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "code-call",
          function: { name: "execute_code", arguments: JSON.stringify({ code }) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "code-call",
      content: JSON.stringify({
        status: "success",
        exit_code: 0,
        output: sentinel,
        tool_calls_made: 1,
        kernel: { mode: "session", execution_count: 1 },
      }),
    },
  ];
  assert(recordedHermesCode(messages, code, sentinel));
  assert.equal(finalHermesAssistant(messages, prompt), false);
  messages.push({ role: "assistant", content: "Both operations completed." });
  assert.equal(finalHermesAssistant(messages, prompt), true);
  const failed = structuredClone(messages);
  failed[2].content = JSON.stringify({
    status: "success",
    exit_code: 0,
    output: sentinel,
    tool_calls_made: 0,
  });
  assert.equal(recordedHermesCode(failed, code, sentinel), null);
  const state = createHermesPtyState();
  state.bindEvents("actual");
  state.bindPty("actual");
  state.ptyData();
  state.receive("actual", {
    method: "event",
    params: {
      type: "message.error",
      session_id: "real",
      seq: 1,
      payload: { error: "controlled failure" },
    },
  });
  assert.throws(() => state.assertHealthy(), /reported an error/u);
});
