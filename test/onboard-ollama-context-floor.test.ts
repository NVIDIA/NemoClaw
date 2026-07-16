// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const OLLAMA_MODEL = "nemotron-3-nano:30b";
const OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE =
  '{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}';

type OnboardResult = SpawnSyncReturns<string>;

function writeFakeCurl(fakeBin: string): void {
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
body='${OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE}'
status="200"
outfile=""
url=""
has_config=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) has_config=1; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ "$has_config" -eq 0 ] && [[ "$url" == *:11435/* ]]; then
  status="401"
fi
if [ -n "$outfile" ]; then
  printf '%s' "$body" > "$outfile"
fi
printf '%s' "$status"
`,
    { mode: 0o755 },
  );
}

function runHermesOllamaOnboard(
  runtimeContextLength: number,
  configuredContextWindow = "",
): OnboardResult {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-ollama-context-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "onboard.js");
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const agentDefsPath = JSON.stringify(path.join(repoRoot, "src", "lib", "agent", "defs.ts"));
  const httpProbePath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "adapters", "http", "probe.ts"),
  );
  const ollamaProxyPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
  );
  const localInferenceTopologyPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
  );

  fs.mkdirSync(fakeBin, { recursive: true });
  writeFakeCurl(fakeBin);

  const script = String.raw`
const runner = require(${runnerPath});
const childProcess = require("child_process");
const nodeChildProcess = require("node:child_process");

const fakeSpawn = () => ({ pid: 99999, unref() {}, on() {} });
childProcess.spawn = fakeSpawn;
nodeChildProcess.spawn = fakeSpawn;
const originalSpawnSync = nodeChildProcess.spawnSync;
const fakeSpawnSync = (command, args, options) => {
  if (command === "nc" && args?.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  return originalSpawnSync(command, args, options);
};
childProcess.spawnSync = fakeSpawnSync;
nodeChildProcess.spawnSync = fakeSpawnSync;

runner.run = () => ({ status: 0 });
runner.runCapture = (command) => {
  const normalized = Array.isArray(command) ? command.join(" ") : command;
  if (normalized.includes("command -v ollama")) return "/usr/bin/ollama";
  if (normalized.includes("127.0.0.1:11434/api/tags")) {
    return JSON.stringify({ models: [{ name: "${OLLAMA_MODEL}" }] });
  }
  if (normalized.includes("ollama list")) return "${OLLAMA_MODEL}  abc  24 GB  now";
  if (normalized.includes("127.0.0.1:8000/v1/models")) return "";
  if (normalized.includes("127.0.0.1:11434/api/ps")) {
    return JSON.stringify({
      models: [{ name: "${OLLAMA_MODEL}", context_length: ${runtimeContextLength} }],
    });
  }
  if (normalized.includes("api/generate")) return '{"response":"hello"}';
  if (normalized.includes("-o args=") || normalized.includes(" ps ")) {
    return "node ollama-auth-proxy.js";
  }
  return "";
};
runner.runCaptureEx = (command) => {
  const normalized = Array.isArray(command) ? command.join(" ") : command;
  if (normalized.includes("api/generate")) {
    return { stdout: '{"response":"hello"}', stderr: "", exitCode: 0, timedOut: false };
  }
  return { stdout: runner.runCapture(command), stderr: "", exitCode: 0, timedOut: false };
};

const ollamaProxy = require(${ollamaProxyPath});
ollamaProxy.startOllamaAuthProxy = () => true;
ollamaProxy.ensureOllamaAuthProxy = () => {};
ollamaProxy.isProxyHealthy = () => true;
const localInferenceTopology = require(${localInferenceTopologyPath});
localInferenceTopology.shouldFrontOllamaWithProxy = () => false;

const httpProbe = require(${httpProbePath});
const successfulOpenAiProbe = () => ({
  ok: true,
  httpStatus: 200,
  curlStatus: 0,
  body: ${JSON.stringify(OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE)},
  stderr: "",
  message: "HTTP 200",
});
httpProbe.runCurlProbe = successfulOpenAiProbe;
httpProbe.runChatCompletionsStreamingProbe = successfulOpenAiProbe;
httpProbe.runStreamingEventProbe = () => ({ ok: true, missingEvents: [], message: "" });

const { loadAgent } = require(${agentDefsPath});
const { setupNim } = require(${onboardPath});

setupNim(null, null, loadAgent("hermes"))
  .then((result) => {
    console.log(JSON.stringify({
      result,
      contextWindow: process.env.NEMOCLAW_CONTEXT_WINDOW,
    }));
  })
  .catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
`;

  try {
    fs.writeFileSync(scriptPath, script);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_PROVIDER: "ollama",
      NEMOCLAW_MODEL: OLLAMA_MODEL,
      NEMOCLAW_YES: "1",
      NEMOCLAW_CONTEXT_WINDOW: configuredContextWindow,
      NEMOCLAW_OLLAMA_PORT: "11434",
      NEMOCLAW_OLLAMA_PROXY_PORT: "11435",
    };
    delete env.OLLAMA_HOST;

    return spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Hermes Ollama runtime context floor", () => {
  it("stops onboarding when the loaded model reports only 16384 tokens", () => {
    const result = runHermesOllamaOnboard(16_384);
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /nemotron-3-nano:30b/);
    assert.match(output, /context_length=16384/);
    assert.match(output, /required 64000-token window/);
    assert.match(output, /OLLAMA_CONTEXT_LENGTH=64000/);
    assert.doesNotMatch(output, /"provider":"ollama-local"/);
  });

  it("does not let an explicit 64000-token prompt budget mask a 16384-token daemon", () => {
    const result = runHermesOllamaOnboard(16_384, "64000");
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /context_length=16384/);
    assert.match(output, /required 64000-token window/);
    assert.match(output, /OLLAMA_CONTEXT_LENGTH=64000/);
    assert.doesNotMatch(output, /"provider":"ollama-local"/);
  });

  it("finishes onboarding when the loaded model reports the 64000-token floor", () => {
    const result = runHermesOllamaOnboard(64_000);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) || "");
    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, OLLAMA_MODEL);
    assert.equal(payload.contextWindow, "64000");
  });
});
