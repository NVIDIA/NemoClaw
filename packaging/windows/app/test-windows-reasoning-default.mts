// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultWindowsOpenAiReasoningOff } from "./openclaw-app-resources.mts";

const position = process.argv.indexOf("--source-root");
if (position < 0 || !process.argv[position + 1])
  throw new Error("The pinned materialized source root is required.");
const source = path.resolve(process.argv[position + 1]);
const relative = "dist/openai-transport-stream-D1R-kt0Q.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const patched = defaultWindowsOpenAiReasoningOff(relative, original);
assert.notEqual(patched, original);
assert.match(patched, /return options\?\.reasoningEffort \?\? options\?\.reasoning \?\? "none";/u);
assert.doesNotMatch(
  patched,
  /return options\?\.reasoningEffort \?\? options\?\.reasoning \?\? "high";/u,
);
assert.equal(defaultWindowsOpenAiReasoningOff("dist/unrelated.js", original), original);
assert.throws(
  () => defaultWindowsOpenAiReasoningOff(relative, original + "\n"),
  /reasoning transport changed/u,
);

const body = /function resolveOpenAICompletionsReasoningEffort\(options\) \{([\s\S]*?)\n\}/u.exec(
  patched,
);
assert.ok(body);
const resolve = new Function(
  `return function resolveOpenAICompletionsReasoningEffort(options) {${body[1]}\n}`,
)() as (options?: { reasoningEffort?: string; reasoning?: string }) => string;
assert.equal(resolve(), "none");
assert.equal(resolve({}), "none");
assert.equal(resolve({ reasoning: "high" }), "high");
assert.equal(resolve({ reasoningEffort: "medium" }), "medium");
console.log("PASS omitted reasoning stays off while explicit levels are preserved.");
