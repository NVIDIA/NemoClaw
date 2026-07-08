// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";

it("honors NEMOCLAW_REASONING for custom OpenAI-compatible endpoint models (#3279)", () => {
  const repoRoot = path.join(import.meta.dirname, "..", "..", "..");
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-onboard-custom-openai-reasoning-"),
  );
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "custom-openai-reasoning-check.js");
  const curlArgsLog = path.join(tmpDir, "custom-openai-reasoning-curl-args.log");
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
args_log=${JSON.stringify(curlArgsLog)}
printf '%s\\n' "$*" >> "$args_log"
body='{"error":{"message":"bad request"}}'
status="400"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/chat/completions$'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"","reasoning_content":"OK"}}]}'
  status="200"
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
    { mode: 0o755 },
  );

  const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["3", "https://proxy.example.com/v1", "reasoning-model"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_API_KEY = "proxy-key";
  process.env.NEMOCLAW_REASONING = "yes";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({
      result,
      messages,
      lines,
      reasoning: process.env.NEMOCLAW_REASONING,
    }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, script);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const stdoutLines = result.stdout.trim().split("\n");
  const payload = JSON.parse(stdoutLines.at(-1) || "{}");
  assert.equal(payload.result.provider, "compatible-endpoint");
  assert.equal(payload.result.model, "reasoning-model");
  assert.equal(payload.result.preferredInferenceApi, "openai-completions");
  assert.equal(payload.reasoning, "true");
  assert.ok(payload.lines.some((line: string) => line.includes("tools and streaming")));
  const curlInvocations = fs.readFileSync(curlArgsLog, "utf-8");
  assert.match(curlInvocations, /chat\/completions/);
  assert.doesNotMatch(curlInvocations, /\/responses/);
  assert.doesNotMatch(curlInvocations, /(^|\s)-N(\s|$)/);
  assert.ok(
    payload.messages.every(
      (message: string) => !/Enable reasoning mode for this model/.test(message),
    ),
  );
});
