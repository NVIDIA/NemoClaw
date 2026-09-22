// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundleWindowsOllamaStreamRuntime } from "./openclaw-app-resources.mts";

const position = process.argv.indexOf("--source-root");
if (position < 0 || !process.argv[position + 1])
  throw new Error("The pinned materialized source root is required.");
const source = path.resolve(process.argv[position + 1]);
const relative = "dist/stream-api-BC8FZL1o.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const patched = bundleWindowsOllamaStreamRuntime(relative, original);
assert.notEqual(patched, original);
assert.doesNotMatch(patched, /const ollamaStreamRuntime = await/u);
assert.match(patched, /const ollamaStreamRuntime = require\("\.\/stream\.runtime\.js"\);/u);
assert.equal(bundleWindowsOllamaStreamRuntime("dist/unrelated.js", original), original);
assert.throws(
  () => bundleWindowsOllamaStreamRuntime(relative, original + "\n"),
  /reviewed Ollama stream adapter changed/u,
);
console.log("PASS reviewed Ollama stream runtime is admitted into the CommonJS application unit.");
