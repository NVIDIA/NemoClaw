// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  captureFailure,
  childEnvironment,
  exactChatAddress,
  recordedExec,
  sanitizedFailure,
  toolIds,
  verifyToolOutput,
} from "./qualify-installed-openclaw.mts";

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
