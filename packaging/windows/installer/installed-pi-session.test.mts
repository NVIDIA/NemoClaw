// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";
import { recordedPiReply } from "./installed-pi-session.mts";
import { piAcceptanceChallenge, retainedPiAcceptance } from "./qualify-installed-pi.mts";
import { acceptanceProcessesStopped } from "./qualify-finished-package.mts";

test("Pi restart binds a preserved successful cold run, exact artifact and unchanged settings", () => {
  const identity = {
    runtimeId: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    sourceRevision: "c".repeat(40),
    nodeSha256: "d".repeat(64),
    nodeVersion: "22.23.2",
  };
  const configuration = '{"agent":"pi","credentialStored":true}';
  const previous = {
    schemaVersion: 1,
    classification: "installed-pi-terminal-acceptance",
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
      stateRoot: "C:\\NemoClawState-S-1-5-21-1000-pi",
      cleanup: { cleanupSucceeded: true, stateRetained: true },
    },
  };
  assert.equal(
    retainedPiAcceptance(previous, identity, configuration, "123456:1"),
    previous.results.stateRoot,
  );
  for (const field of [
    "configurationPreserved",
    "realTerminal",
    "realModelReply",
    "fileToolsQualified",
  ] as const) {
    const value = structuredClone(previous);
    value.results[field] = false;
    assert.throws(() => retainedPiAcceptance(value, identity, configuration, "123456:1"));
  }
  for (const changed of [
    { ...previous, verdict: "fail" },
    { ...previous, controllerRun: "123457:1" },
    { ...previous, controllerRun: "123456:2" },
    { ...previous, cleanupErrors: ["retained sandbox"] },
    { ...previous, results: { ...previous.results, configurationReused: true } },
    {
      ...previous,
      results: { ...previous.results, cleanup: { cleanupSucceeded: false, stateRetained: true } },
    },
    {
      ...previous,
      results: { ...previous.results, cleanup: { cleanupSucceeded: true, stateRetained: false } },
    },
    { ...previous, results: { ...previous.results, stateRoot: "C:\\Unowned" } },
  ])
    assert.throws(() => retainedPiAcceptance(changed, identity, configuration, "123456:1"));
  for (const field of Object.keys(identity))
    assert.throws(() =>
      retainedPiAcceptance(
        { ...previous, runtime: { ...identity, [field]: "different" } },
        identity,
        configuration,
        "123456:1",
      ),
    );
  assert.throws(() => retainedPiAcceptance(previous, identity, configuration + " ", "123456:1"));
  assert.throws(() =>
    retainedPiAcceptance({ ...previous, runtime: {} }, {}, configuration, "123456:1"),
  );
  assert.throws(() =>
    retainedPiAcceptance(previous, identity, configuration, "undefined:undefined"),
  );
});

for (const existing of ["configuration", "agent-data"])
  test(`fresh Pi acceptance preserves pre-existing ${existing}`, async () => {
    const source = fs.readFileSync(new URL("./qualify-installed-pi.mts", import.meta.url), "utf8");
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
          ProgramFiles: "C:\\Program Files",
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
      acceptanceProcessesStopped,
      captureOwned: async (_launcher: string, args: string[]) => {
        calls.push(args);
        assert.deepEqual(args, ["--state-session", "pi"]);
        return {
          failure: null,
          exitCode: 0,
          stdout: JSON.stringify({
            agent: "pi",
            leaseHeld: true,
            stateRoot: "C:\\NemoClawState-S-1-5-21-1000-pi",
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
    await assert.rejects(main(), /Installed Pi acceptance failed/u);
    assert.deepEqual(calls, existing === "configuration" ? [] : [["--state-session", "pi"]]);
    const receipt = receipts["C:\\Evidence\\installed-pi-acceptance.json"];
    assert.equal(receipt.verdict, "fail");
    assert.equal(receipt.failedStage, "preflight");
    assert.match(
      receipt.error,
      /cannot (replace saved configuration|use pre-existing agent data)/u,
    );
    assert.deepEqual(receipt.cleanupErrors, []);
  });

test("the terminal challenge cannot pass by echoing the submitted prompt", () => {
  const challenge = piAcceptanceChallenge("0123456789abcdef0123");
  assert.equal(challenge.reply, "PI_REPLY_0123456789abcdef0123");
  assert.equal(challenge.prompt.includes(challenge.reply), false);
  assert.throws(() => piAcceptanceChallenge("bad\ninput"));
  const tools = piAcceptanceChallenge("0123456789abcdef0123", true);
  assert.equal(tools.prompt.includes(tools.reply), false);
  assert.deepEqual(tools.file, {
    path: "qualification-0123456789abcdef0123.txt",
    content: "PI_FILE_0123456789abcdef0123\n",
  });
});

const expected = {
  prompt: "Return exactly PI_REPLY_0123456789abcdef0123",
  reply: "PI_REPLY_0123456789abcdef0123",
  model: "qualification-model",
  cwd: "C:\\owned-pi-state",
  startedAt: Date.parse("2026-09-16T12:00:00Z"),
};
function fixture() {
  return [
    {
      type: "session",
      version: 3,
      id: "01995942-0000-7000-8000-000000000001",
      timestamp: "2026-09-16T12:00:01Z",
      cwd: expected.cwd,
    },
    {
      type: "model_change",
      id: "m1",
      parentId: null,
      provider: "openshell",
      modelId: expected.model,
    },
    {
      type: "message",
      id: "u1",
      parentId: "m1",
      message: { role: "user", content: [{ type: "text", text: expected.prompt }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: {
        role: "assistant",
        provider: "openshell",
        model: expected.model,
        stopReason: "stop",
        content: [{ type: "text", text: expected.reply }],
      },
    },
  ];
}
function jsonl(rows: unknown[]) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

const fileExpected = {
  ...expected,
  file: {
    path: "qualification-0123456789abcdef0123.txt",
    content: "PI_FILE_0123456789abcdef0123\n",
  },
};
function fileFixture() {
  const rows: unknown[] = fixture().slice(0, -1);
  let previous = "u1";
  for (const [index, name] of ["write", "read"].entries()) {
    const id = "call-" + name;
    const requestId = "request-" + name,
      resultId = "result-" + name;
    rows.push({
      type: "message",
      id: requestId,
      parentId: previous,
      message: {
        role: "assistant",
        provider: "openshell",
        model: expected.model,
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id,
            name,
            arguments: {
              path: fileExpected.file.path,
              ...(index === 0 ? { content: fileExpected.file.content } : {}),
            },
          },
        ],
      },
    });
    rows.push({
      type: "message",
      id: resultId,
      parentId: requestId,
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        isError: false,
        content: [
          {
            type: "text",
            text:
              index === 0
                ? `Successfully wrote ${fileExpected.file.content.length} bytes to ${fileExpected.file.path}`
                : fileExpected.file.content,
          },
        ],
      },
    });
    previous = resultId;
  }
  rows.push({ ...fixture().at(-1), parentId: previous });
  return rows;
}

test("file acceptance requires sequential matching write/read results and the final model reply", () => {
  const proof = recordedPiReply(jsonl(fileFixture()), fileExpected);
  assert.deepEqual(proof, {
    sessionId: fixture()[0].id,
    userEntryId: "u1",
    assistantEntryId: "a1",
    fileTools: true,
  });
  assert.equal(recordedPiReply(jsonl(fixture()), fileExpected), null);
  assert.equal(recordedPiReply(jsonl(fileFixture()), expected), null);
  assert.equal(recordedPiReply(jsonl(fileFixture().slice(0, -1)), fileExpected), null);
  for (const [before, after] of [
    ['"toolCallId":"call-write"', '"toolCallId":"another-call"'],
    ['"toolName":"read"', '"toolName":"write"'],
    ['"isError":false', '"isError":true'],
    ['"stopReason":"toolUse"', '"stopReason":"stop"'],
    ['"name":"read"', '"name":"bash"'],
    ['"provider":"openshell"', '"provider":"other"'],
    ['"model":"qualification-model"', '"model":"other"'],
    ['"id":"call-read"', '"id":"call-write"'],
    ["Successfully wrote", "Failed to write"],
    ['"path":"qualification-', '"path":"../qualification-'],
    ['"arguments":{"path":', '"arguments":{"offset":2,"path":'],
    ['"text":"PI_FILE_', '"text":"WRONG_'],
    ['"text":"PI_REPLY_', '"text":"WRONG_'],
  ])
    assert.equal(
      recordedPiReply(jsonl(fileFixture()).replaceAll(before, after), fileExpected),
      null,
      before,
    );
  const absolute = expected.cwd + "\\" + fileExpected.file.path;
  const aliased = jsonl(fileFixture())
    .replaceAll(JSON.stringify(fileExpected.file.path), JSON.stringify(absolute))
    .replaceAll(
      `bytes to ${fileExpected.file.path}`,
      `bytes to ${absolute.replaceAll("\\", "\\\\")}`,
    );
  assert.equal(recordedPiReply(aliased, fileExpected)?.fileTools, true);
});

test("records a completed Pi model reply with only conversation identity", () => {
  assert.deepEqual(recordedPiReply(jsonl(fixture()), expected), {
    sessionId: fixture()[0].id,
    userEntryId: "u1",
    assistantEntryId: "a1",
  });
});

test("an echoed prompt or incomplete assistant record is not a reply", () => {
  const rows = fixture();
  assert.equal(recordedPiReply(jsonl(rows.slice(0, -1)), expected), null);
  assert.equal(
    recordedPiReply(jsonl(rows.slice(0, -1)) + JSON.stringify(rows.at(-1)).slice(0, -1), expected),
    null,
  );
  assert.equal(
    recordedPiReply(jsonl(rows).replace('"role":"assistant"', '"role":"user"'), expected),
    null,
  );
});

test("reasoning may accompany a final answer but cannot establish the reply", () => {
  const rows = fixture();
  const answer = rows.at(-1)!.message!;
  const finalText = answer.content![0];
  const withContent = (content: unknown[]) =>
    jsonl([...rows.slice(0, -1), { ...rows.at(-1), message: { ...answer, content } }]);
  const reasoning = { type: "thinking", thinking: "private reasoning that must not be reported" };
  const proof = recordedPiReply(withContent([reasoning, finalText]), expected);
  assert.deepEqual(proof, {
    sessionId: rows[0].id,
    userEntryId: "u1",
    assistantEntryId: "a1",
  });
  assert.equal(JSON.stringify(proof).includes(reasoning.thinking), false);
  assert.equal(
    recordedPiReply(withContent([{ type: "thinking", thinking: expected.reply }]), expected),
    null,
  );
  for (const unsupported of [
    { type: "thinking", thinking: 42 },
    { type: "toolCall", id: "call1", name: "bash", arguments: {} },
    { type: "unknown", text: expected.reply },
  ])
    assert.equal(recordedPiReply(withContent([unsupported, finalText]), expected), null);
});

for (const [name, before, after] of [
  ["wrong provider", '"provider":"openshell"', '"provider":"other"'],
  ["wrong model", '"model":"qualification-model"', '"model":"other"'],
  ["failed model call", '"stopReason":"stop"', '"stopReason":"error"'],
  ["truncated output", '"stopReason":"stop"', '"stopReason":"length"'],
  ["unfinished tool call", '"stopReason":"stop"', '"stopReason":"toolUse"'],
  ["error text", '"stopReason":"stop"', '"stopReason":"stop","errorMessage":"private-value"'],
  ["wrong reply", '"text":"PI_REPLY_0123456789abcdef0123"', '"text":"incorrect"'],
])
  test("does not accept " + name, () => {
    assert.equal(recordedPiReply(jsonl(fixture()).replaceAll(before, after), expected), null);
  });

test("rejects another launch, working directory, or conversation identity", () => {
  const data = jsonl(fixture());
  assert.throws(
    () => recordedPiReply(data, { ...expected, startedAt: expected.startedAt + 2000 }),
    /predates/u,
  );
  assert.throws(
    () => recordedPiReply(data, { ...expected, cwd: "C:\\other" }),
    /working directory/u,
  );
  assert.throws(
    () => recordedPiReply(data, { ...expected, sessionId: "different" }),
    /changed sessions/u,
  );
});

test("does not combine branches or duplicate entries", () => {
  assert.throws(
    () => recordedPiReply(jsonl(fixture()).replace('"parentId":"u1"', '"parentId":"m1"'), expected),
    /linear/u,
  );
  const rows = fixture();
  assert.throws(() => recordedPiReply(jsonl([...rows, rows.at(-1)]), expected), /Duplicate/u);
});

test("a later turn invalidates the prior reply and a second turn keeps its identity", () => {
  const rows: unknown[] = fixture();
  const second = {
    ...expected,
    prompt: "Second turn: " + expected.reply,
    sessionId: fixture()[0].id,
  };
  rows.push({
    type: "message",
    id: "u2",
    parentId: "a1",
    message: { role: "user", content: second.prompt },
  });
  assert.equal(recordedPiReply(jsonl(rows), expected), null);
  assert.equal(recordedPiReply(jsonl(rows), second), null);
  rows.push({
    type: "message",
    id: "a2",
    parentId: "u2",
    message: {
      role: "assistant",
      provider: "openshell",
      model: expected.model,
      stopReason: "stop",
      content: [{ type: "text", text: expected.reply }],
    },
  });
  assert.deepEqual(recordedPiReply(jsonl(rows), second), {
    sessionId: second.sessionId,
    userEntryId: "u2",
    assistantEntryId: "a2",
  });
});

test("rejects bounded or malformed evidence without leaking its text", () => {
  assert.throws(() => recordedPiReply("x".repeat(1024 * 1024 + 1), expected), /bound/u);
  assert.throws(
    () => recordedPiReply('{"secret":"do-not-report", invalid}\n', expected),
    (error: unknown) =>
      error instanceof Error && error.message === "Pi session contains an invalid complete record",
  );
  assert.throws(
    () => recordedPiReply(jsonl(fixture()).replace('"version":3', '"version":4'), expected),
    /format/u,
  );
});
