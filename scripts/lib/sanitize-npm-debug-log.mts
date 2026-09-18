// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

const path = process.argv[2];
const stat = path ? fs.statSync(path) : null;
if (!path || !stat?.isFile()) process.exit(2);

const maxBytes = 128 * 1024;
const length = Math.min(stat.size, maxBytes);
const input = Buffer.alloc(length);
const descriptor = fs.openSync(path, "r");
let bytesRead = 0;
try {
  bytesRead = fs.readSync(descriptor, input, 0, length, Math.max(0, stat.size - length));
} finally {
  fs.closeSync(descriptor);
}
let text = input.subarray(0, bytesRead).toString("utf8");
const tokenPatterns = [
  /(?:github_pat_|ghp_|glpat-|gsk_|hf_|pypi-|sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{10,}/g,
  /\b(?:A(?:K|S)IA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?<=Bearer\s+)[A-Za-z0-9_.+/=-]{10,}/gi,
  /(?<=https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
];
for (const pattern of tokenPatterns) text = text.replace(pattern, "<REDACTED>");
text = text.replace(
  /((?:token|password|passwd|secret|credential|_auth|:_authToken)\s*[=:]\s*)[^\s]+/gi,
  "$1<REDACTED>",
);

process.stdout.write("--- npm-debug-sanitized-begin ---\n");
process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
process.stdout.write("--- npm-debug-sanitized-end ---\n");
