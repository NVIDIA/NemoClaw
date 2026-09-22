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
const relative = "dist/provider-stream-shared-BmB0vX9b.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const patched = defaultWindowsOpenAiReasoningOff(relative, original);
assert.notEqual(patched, original);
assert.match(
  patched,
  /const raw = options\.reasoningEffort \?\? options\.reasoning \?\? params\.thinkingLevel \?\? "none";/u,
);
assert.doesNotMatch(
  patched,
  /const raw = options\.reasoningEffort \?\? options\.reasoning \?\? params\.thinkingLevel \?\? "high";/u,
);
assert.equal(defaultWindowsOpenAiReasoningOff("dist/unrelated.js", original), original);
assert.throws(
  () => defaultWindowsOpenAiReasoningOff(relative, original + "\n"),
  /reasoning transport changed/u,
);

const body = /function isOpenAICompatibleThinkingEnabled\(params\) \{([\s\S]*?)\n\}/u.exec(patched);
assert.ok(body);
const resolve = new Function(
  `return function isOpenAICompatibleThinkingEnabled(params) {${body[1]}\n}`,
)() as (params: {
  options?: { reasoningEffort?: string; reasoning?: string };
  thinkingLevel?: string;
}) => boolean;
assert.equal(resolve({}), false);
assert.equal(resolve({ options: {} }), false);
assert.equal(resolve({ thinkingLevel: "high" }), true);
assert.equal(resolve({ options: { reasoning: "off" } }), false);
assert.equal(resolve({ options: { reasoningEffort: "medium" } }), true);
console.log("PASS omitted reasoning stays off while explicit levels are preserved.");
