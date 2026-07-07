// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { testTimeout } from "./helpers/timeouts";

const CREDENTIAL_RETRY_PROMPT_RE =
  /Options: retry \(re-enter key\), back \(change provider\), exit \[retry\]: /;

const PROVIDER_SELECTION_TEST_TIMEOUT_MS = testTimeout(60_000);

function writeAnthropicStyleAuthRetryCurl(
  fakeBin: string,
  goodToken: string,
  models = ["claude-sonnet-4-6"],
) {
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
body='{"error":{"message":"forbidden"}}'
status="403"
outfile=""
auth=""
url=""
data=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -d) data="$2"; shift 2 ;;
    -H)
      if echo "$2" | grep -q '^x-api-key: '; then
        auth="$2"
      fi
      shift 2
      ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/models$'; then
  body='{"data":[${models.map((model) => `{"id":"${model}"}`).join(",")}]}'
  status="200"
elif echo "$auth" | grep -q '${goodToken}' && echo "$url" | grep -q '/v1/messages$'; then
  if echo "$data" | grep -q '"stream":true'; then
    # Streaming validation probe: serve a well-formed Anthropic SSE sequence.
    body='event: message_start
data: {"type":"message_start","message":{"id":"msg_123"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}

event: message_stop
data: {"type":"message_stop"}
'
  else
    body='{"id":"msg_123","content":[{"type":"text","text":"OK"}]}'
  fi
  status="200"
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
    { mode: 0o755 },
  );
}

describe("onboard Anthropic credential retry UX", {
  timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
}, () => {
  it("lets users re-enter an Anthropic API key after authorization failure (#6289)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-anthropic-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "anthropic-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAnthropicStyleAuthRetryCurl(fakeBin, "anthropic-good", ["claude-sonnet-4-6"]);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["4", "", "retry", "anthropic-good", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.ANTHROPIC_API_KEY = "anthropic-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines, key: process.env.ANTHROPIC_API_KEY }));
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
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "anthropic-prod");
    assert.equal(payload.result.model, "claude-sonnet-4-6");
    assert.equal(payload.result.preferredInferenceApi, "anthropic-messages");
    assert.equal(payload.key, "anthropic-good");
    assert.ok(
      payload.lines.some((line: string) => line.includes("Anthropic authorization failed")),
    );
    assert.ok(payload.messages.some((message: string) => CREDENTIAL_RETRY_PROMPT_RE.test(message)));
    assert.ok(payload.messages.some((message: string) => /Anthropic API key: /.test(message)));
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
    assert.equal(
      payload.messages.filter((message: string) => /Choose model \[1\]/.test(message)).length,
      2,
    );
  });

  it("lets users re-enter a custom Anthropic-compatible API key without re-entering the endpoint URL (#6289)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-custom-anthropic-auth-retry-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "custom-anthropic-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAnthropicStyleAuthRetryCurl(fakeBin, "anthropic-proxy-good", ["claude-proxy"]);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["5", "https://proxy.example.com/v1/messages?token=secret#frag", "claude-proxy", "retry", "anthropic-proxy-good", "claude-proxy"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_ANTHROPIC_API_KEY = "anthropic-proxy-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines, key: process.env.COMPATIBLE_ANTHROPIC_API_KEY }));
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
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "compatible-anthropic-endpoint");
    assert.equal(payload.result.model, "claude-proxy");
    assert.equal(payload.result.endpointUrl, "https://proxy.example.com");
    assert.equal(payload.result.preferredInferenceApi, "anthropic-messages");
    assert.equal(payload.key, "anthropic-proxy-good");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Other Anthropic-compatible endpoint authorization failed"),
      ),
    );
    assert.ok(payload.messages.some((message: string) => CREDENTIAL_RETRY_PROMPT_RE.test(message)));
    assert.ok(
      payload.messages.some((message: string) =>
        /Other Anthropic-compatible endpoint API key: /.test(message),
      ),
    );
    assert.equal(
      payload.messages.filter((message: string) => /Anthropic-compatible base URL/.test(message))
        .length,
      1,
    );
    assert.equal(
      payload.messages.filter((message: string) =>
        /Other Anthropic-compatible endpoint model/.test(message),
      ).length,
      2,
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
  });
});
