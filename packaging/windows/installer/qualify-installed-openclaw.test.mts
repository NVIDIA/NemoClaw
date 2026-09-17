// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureFailure,
  terminalAgentError,
  decodeDiagnosticOwnerRead,
  retainNativeSessionDiagnostics,
  childEnvironment,
  exactChatAddress,
  recordedExec,
  recordedFileTool,
  sanitizedFailure,
  toolIds,
  verifyToolOutput,
  visibleChatReady,
} from "./qualify-installed-openclaw.mts";

test("an enabled composer waits for its actual session identity", () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldTextarea = Object.getOwnPropertyDescriptor(globalThis, "HTMLTextAreaElement");
  class Textarea {
    disabled = false;
  }
  const input = new Textarea();
  const shell: { activeSessionKey?: string } = {};
  Object.defineProperty(globalThis, "HTMLTextAreaElement", { configurable: true, value: Textarea });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) => (selector === "openclaw-app-shell" ? shell : input),
    },
  });
  try {
    assert.equal(visibleChatReady(), false);
    shell.activeSessionKey = "agent:other:main";
    assert.equal(visibleChatReady(), false);
    shell.activeSessionKey = "agent:main:main";
    assert.equal(visibleChatReady(), true);
    input.disabled = true;
    assert.equal(visibleChatReady(), false);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldTextarea) Object.defineProperty(globalThis, "HTMLTextAreaElement", oldTextarea);
    else Reflect.deleteProperty(globalThis, "HTMLTextAreaElement");
  }
});

test("only the intended dashboard path accepts its session query", () => {
  assert.equal(
    exactChatAddress(
      "http://127.0.0.1:32145/chat?session=agent%3Amain%3Amain",
      "http://127.0.0.1:32145",
    ),
    true,
  );
});
for (const address of [
  "http://localhost:32145/chat",
  "http://127.0.0.1:32146/chat",
  "http://127.0.0.1:32145/chat/",
  "http://127.0.0.1:32145/login",
  "https://127.0.0.1:32145/chat",
  "http://user@127.0.0.1:32145/chat",
])
  test("the browser rejects a different origin or route: " + address, () => {
    assert.equal(exactChatAddress(address, "http://127.0.0.1:32145"), false);
  });

test("provider and credential environment is absent from application children", () => {
  assert.deepEqual(
    childEnvironment({
      SystemRoot: "C:\\Windows",
      PATH: "owned",
      GITHUB_ACTIONS: "true",
      NVIDIA_API_KEY: "private",
      NVIDIA_INFERENCE_API_KEY: "private",
      TAVILY_API_KEY: "private",
      NODE_OPTIONS: "unreviewed",
      NODE_PATH: "source-shadow",
      NEMOCLAW_NATIVE_RUNTIME_ROOT: "unreviewed",
    }),
    { SystemRoot: "C:\\Windows", PATH: "owned", GITHUB_ACTIONS: "true" },
  );
});

test("effective tools retain actual IDs from the selected gateway agent", () => {
  assert.deepEqual(
    toolIds({ agentId: "main", groups: [{ tools: [{ id: "exec" }, { id: "read" }] }] }),
    ["exec", "read"],
  );
});
for (const value of [
  { agentId: "foreign", groups: [] },
  { agentId: "main", groups: null },
  { agentId: "main", groups: [{ tools: [{ id: null }] }] },
])
  test("invalid effective-tool identities fail", () => assert.throws(() => toolIds(value)));

test("actual completed tool output carries its controlled result", () => {
  verifyToolOutput(
    {
      ok: true,
      output: {
        content: [{ type: "text", text: "sentinel:42" }],
        details: { status: "completed", exitCode: 0 },
      },
    },
    "sentinel:42",
  );
});
for (const value of [
  { ok: false, output: { content: [{ type: "text", text: "sentinel:42" }] } },
  { ok: true, output: { isError: true, content: [{ type: "text", text: "sentinel:42" }] } },
  {
    ok: true,
    output: { content: [{ type: "text", text: "sentinel:42" }], details: { exitCode: 1 } },
  },
  {
    ok: true,
    output: { content: [{ type: "text", text: "sentinel:42" }], details: { status: "running" } },
  },
  { ok: true, output: { content: [{ type: "text", text: "different" }] } },
])
  test("a rejected, failed, incomplete or incorrect tool result cannot qualify", () =>
    assert.throws(() => verifyToolOutput(value, "sentinel:42")));

const call = {
  role: "assistant",
  content: [
    { type: "toolCall", id: "call-owned", name: "exec", arguments: { command: "exact command" } },
  ],
};
for (const name of ["write", "read"] as const) {
  const file = "owned-nonce.txt",
    content = "owned-content";
  const fileCall = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name,
        id: "file-owned",
        arguments: { path: file, ...(name === "write" ? { content } : {}) },
      },
    ],
  };
  const fileResult = {
    role: "toolResult",
    toolName: name,
    toolCallId: "file-owned",
    isError: false,
    content: [
      { type: "text", text: name === "write" ? "Successfully wrote 13 bytes to " + file : content },
    ],
  };
  test(
    name + " proof requires exact agent arguments followed by its successful tool result",
    () => {
      assert.deepEqual(
        recordedFileTool({ messages: [fileCall, fileResult] }, name, file, content),
        fileResult,
      );
    },
  );
  for (const [label, messages] of [
    ["assistant claim", [fileCall, { ...fileResult, role: "assistant" }]],
    ["foreign call", [fileCall, { ...fileResult, toolCallId: "foreign" }]],
    [
      "foreign file",
      [
        {
          ...fileCall,
          content: [{ ...fileCall.content[0], arguments: { path: "foreign.txt", content } }],
        },
        fileResult,
      ],
    ],
    ["missing call", [fileResult]],
    ["result before call", [fileResult, fileCall]],
    ["failed tool", [fileCall, { ...fileResult, isError: true }]],
    ["wrong output", [fileCall, { ...fileResult, content: [{ type: "text", text: "different" }] }]],
  ] as const)
    test(name + " proof rejects " + label, () => {
      assert.throws(() => recordedFileTool({ messages: [...messages] }, name, file, content));
    });
  if (name === "write")
    test("a write of different content cannot qualify", () => {
      assert.throws(() =>
        recordedFileTool(
          {
            messages: [
              {
                ...fileCall,
                content: [
                  { ...fileCall.content[0], arguments: { path: file, content: "foreign" } },
                ],
              },
              fileResult,
            ],
          },
          name,
          file,
          content,
        ),
      );
    });
}
const result = {
  role: "toolResult",
  toolCallId: "call-owned",
  toolName: "exec",
  content: [{ type: "text", text: "sentinel:42" }],
  details: { exitCode: 0, status: "completed" },
};
test("shell proof requires the actual matching tool call and successful result", () => {
  assert.deepEqual(
    recordedExec({ messages: [call, result] }, "exact command", "sentinel:42"),
    result,
  );
});
for (const messages of [
  [call, { ...result, role: "assistant" }],
  [call, { ...result, toolCallId: "foreign" }],
  [call, { ...result, toolName: "read" }],
  [result],
  [call, { ...result, isError: true }],
  [call, { ...result, details: { exitCode: 1 } }],
])
  test("assistant claims, foreign calls and unsuccessful shell results fail", () => {
    assert.throws(() => recordedExec({ messages }, "exact command", "sentinel:42"));
  });

test("failure stacks and causes are retained with the provider key removed", () => {
  const secret = "nvapi-private-control";
  const cause = new Error("state lease release: " + secret);
  const primary = new Error("dashboard: " + secret, { cause });
  const result = sanitizedFailure(primary, secret);
  assert.equal(result.chain.length, 2);
  assert.ok(result.chain[0].stack?.includes("dashboard: [REDACTED]"));
  assert.ok(result.chain[1].stack?.includes("state lease release: [REDACTED]"));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("cyclic and oversized diagnostic causes remain bounded", () => {
  const primary = new Error("x".repeat(100000));
  primary.cause = primary;
  const result = sanitizedFailure(primary, "");
  assert.equal(result.chain.length, 1);
  assert.equal(result.truncatedOrCyclicCause, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 9000);
});

test("a failure screenshot is awaited before cleanup can continue", async () => {
  const primary = new Error("original dashboard failure");
  let completed = false;
  const result = await captureFailure(
    primary,
    {
      async screenshot(options) {
        assert.equal(options.timeout, 5000);
        await new Promise((resolve) => setTimeout(resolve, 1));
        completed = true;
      },
    },
    "/owned/failure.png",
    "",
  );
  assert.equal(completed, true);
  assert.equal(result.screenshot, "failure.png");
  assert.equal(result.primary.chain[0].message, primary.message);
});

test("screenshot failure retains the original failure and a separate sanitized cause", async () => {
  const primary = new Error("original dashboard failure");
  const result = await captureFailure(
    primary,
    {
      async screenshot() {
        throw new Error("screenshot nvapi-private-control");
      },
    },
    "/owned/failure.png",
    "nvapi-private-control",
  );
  assert.equal(result.primary.chain[0].message, primary.message);
  assert.equal(result.screenshot, null);
  assert.equal(result.screenshotError?.chain[0].message, "screenshot [REDACTED]");
});

test("native diagnostic framing admits only the bounded canonical read and close reply", () => {
  const bytes = Buffer.from('{"owned":"ready"}');
  assert.deepEqual(
    decodeDiagnosticOwnerRead(`READY\nOK\t${bytes.toString("base64")}\nOK\n`),
    bytes,
  );
  assert.equal(decodeDiagnosticOwnerRead("READY\nMISS\nOK\n"), null);
  for (const value of [
    "READY\nOK\tYQ==\nOK",
    "READY\nOK\tYQ=\nOK\n",
    "READY\nERR\tread\nOK\n",
    "READY\nMISS\nOK\nextra\n",
  ])
    assert.throws(() => decodeDiagnosticOwnerRead(value));
  assert.throws(() =>
    decodeDiagnosticOwnerRead(
      `READY\nOK\t${Buffer.alloc(1024 * 1024 + 1).toString("base64")}\nOK\n`,
    ),
  );
});

test("native diagnostic retention copies and redacts closed documents before state removal", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = "session-diagnostics-" + "a".repeat(20);
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, "native-windows.json"), "must not read configuration");
  const data = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      classification: "native-session-success",
      agent: "openclaw",
      output: { gateway: "Bearer private-value\nknown-secret" },
    }),
  );
  fs.writeFileSync(path.join(directory, "ready"), data);
  const saved: { name: string; value: unknown }[] = [];
  const result = await retainNativeSessionDiagnostics(
    root,
    async (value) => {
      assert.equal(value, directory);
      return fs.readFileSync(path.join(value, "ready"));
    },
    (name, value) => {
      saved.push({ name, value });
    },
    "known-secret",
  );
  assert.equal(result.status, "retained");
  assert.equal(result.retained.length, 1);
  assert.equal(saved[0].name, "native-session-diagnostic-0.json");
  assert(!JSON.stringify(saved).includes("known-secret"));
  assert(!JSON.stringify(saved).includes("private-value"));
  assert.deepEqual(fs.readFileSync(path.join(directory, "ready")), data);
});

test("native diagnostic enumeration refuses linked directories and invalid documents", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-diagnostics-refuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "actual");
  fs.mkdirSync(target);
  const linked = path.join(root, "session-diagnostics-" + "b".repeat(20));
  fs.symlinkSync(target, linked, "junction");
  let reads = 0;
  await assert.rejects(
    retainNativeSessionDiagnostics(
      root,
      async () => {
        reads++;
        return null;
      },
      () => {},
      "",
    ),
  );
  assert.equal(reads, 0);
  fs.unlinkSync(linked);
  fs.mkdirSync(linked);
  await assert.rejects(
    retainNativeSessionDiagnostics(
      root,
      async () => Buffer.from("not JSON with private bytes"),
      () => {},
      "",
    ),
    /document is malformed/u,
  );
  await assert.rejects(
    retainNativeSessionDiagnostics(
      root,
      async () =>
        Buffer.from(
          JSON.stringify({ schemaVersion: 1, classification: "foreign", agent: "openclaw" }),
        ),
      () => {},
      "",
    ),
  );
});

const ownPrompt = "Reply exactly NEMOCLAW_NVIDIA_0123456789abcdef";
const ownUser = { role: "user", content: [{ type: "text", text: ownPrompt }] };
const actualMissing = "⚠️ Agent failed before reply: Cannot find module 'undici'";
test("terminal error keeps the actual cause after this exact fresh prompt", () => {
  assert.equal(
    terminalAgentError(
      {
        messages: [
          ownUser,
          { role: "assistant", stopReason: "error", errorMessage: "Cannot find module 'undici'" },
        ],
      },
      ownPrompt,
    ),
    "Cannot find module 'undici'",
  );
  assert.equal(
    terminalAgentError(
      {
        messages: [
          ownUser,
          { role: "assistant", content: [{ type: "text", text: actualMissing }] },
        ],
      },
      ownPrompt,
    ),
    actualMissing,
  );
});
test("earlier, unrelated, user and tool failures cannot end this reply wait", () => {
  const failure = { role: "assistant", stopReason: "error", errorMessage: "old" };
  for (const messages of [
    [failure, ownUser],
    [{ ...ownUser, content: "foreign" }, failure],
    [ownUser, { ...failure, role: "user" }],
    [ownUser, { ...failure, role: "toolResult" }],
    [ownUser, { role: "user", content: "later" }, failure],
  ]) {
    assert.equal(terminalAgentError({ messages }, ownPrompt), null);
  }
});
test("ordinary or incomplete assistant output is never a terminal failure", () => {
  for (const value of [
    null,
    {},
    { messages: [ownUser, { role: "assistant", content: "working" }] },
    { messages: [ownUser, { role: "assistant", stopReason: "error" }] },
  ])
    assert.equal(terminalAgentError(value, ownPrompt), null);
});

const projectedError = {
  role: "assistant",
  stopReason: "error",
  content: [{ type: "text", text: "The agent run failed before producing a reply." }],
};
test("canonical projected terminal errors retain failure without errorMessage", () => {
  assert.equal(
    terminalAgentError({ messages: [ownUser, projectedError] }, ownPrompt),
    projectedError.content[0].text,
  );
});
test("projected-error display prose alone cannot terminate an ordinary reply", () => {
  assert.equal(
    terminalAgentError(
      { messages: [ownUser, { ...projectedError, stopReason: "end_turn" }] },
      ownPrompt,
    ),
    null,
  );
});
test("projected terminal errors still require the exact current prompt", () => {
  for (const messages of [
    [projectedError, ownUser],
    [{ ...ownUser, content: "foreign" }, projectedError],
    [ownUser, { role: "user", content: "later" }, projectedError],
    [ownUser, { ...projectedError, role: "toolResult" }],
  ])
    assert.equal(terminalAgentError({ messages }, ownPrompt), null);
});
