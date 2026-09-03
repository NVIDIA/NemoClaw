// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { it, onTestFinished } from "vitest";

import { createOnboardProcessWorkspace } from "../helpers/onboard-child-process-harness.js";
import { onboardChildRuntimeSource } from "../helpers/onboard-child-runtime.js";

const repoRoot = path.join(import.meta.dirname, "../..");
const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

it("keeps the NVIDIA request payload for final build-provider revalidation (#10880)", () => {
  const workspace = createOnboardProcessWorkspace("nemoclaw-onboard-build-payload-");
  onTestFinished(() => workspace.remove());
  const { root: tmpDir } = workspace;
  const fakeBin = workspace.binDir;
  const payloadLogPath = path.join(tmpDir, "chat-payloads.jsonl");

  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
body='{"choices":[{"message":{"content":"OK"}}]}'
status="200"
outfile=""
payload=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -d) payload="$2"; shift 2 ;;
    --config) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/chat/completions$'; then
  printf '%s\n' "$payload" >> "$NEMOCLAW_CHAT_PAYLOAD_LOG"
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
    { mode: 0o755 },
  );

  const script = String.raw`
${onboardChildRuntimeSource}
const runner = require(${runnerPath});
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});

reportChildScenario(async () => {
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  process.env.NEMOCLAW_PROVIDER = "build";
  process.env.NEMOCLAW_MODEL = "nvidia/nemotron-3-super-120b-a12b";
  process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-test";
  return setupNim(null);
});
`;
  const result = workspace.runNodeSource(script, {
    name: "build-payload-check.js",
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      HTTPS_PROXY: "http://proxy.invalid:8080",
      https_proxy: "http://proxy.invalid:8080",
      NO_PROXY: "",
      no_proxy: "",
      NEMOCLAW_CHAT_PAYLOAD_LOG: payloadLogPath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payloadText = fs.readFileSync(payloadLogPath, "utf8").trim();
  assert.equal(payloadText.split("\n").length, 1);
  const payload = JSON.parse(payloadText) as Record<string, unknown>;
  assert.equal(payload.temperature, 1);
  assert.equal(payload.top_p, 0.95);
  assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
});
