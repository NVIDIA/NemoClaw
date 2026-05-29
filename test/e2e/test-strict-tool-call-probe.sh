#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Coverage guard for #4537. The Local Ollama onboarding path is the only
# current caller that requires strict Chat Completions tool calls. This
# hermetic E2E exercises that validation path against an OpenAI-compatible
# mock endpoint so payload-shape and retry regressions do not require a GPU
# Ollama runner to catch.

set -euo pipefail

LOG_FILE="/tmp/nemoclaw-e2e-strict-tool-call-probe.log"
exec > >(tee "$LOG_FILE") 2>&1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
diag() { echo -e "${YELLOW}[DIAG]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  diag "strict tool-call probe log tail:"
  tail -120 "$LOG_FILE" 2>/dev/null || true
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

info "Preparing CLI build"
if [ ! -d node_modules ]; then
  npm ci --ignore-scripts
fi
npm run build:cli

info "Running strict Chat Completions tool-call probe against a hermetic mock"
set +e
NEMOCLAW_TEST_NO_SLEEP=1 node <<'NODE' 2>&1 | tee /tmp/nemoclaw-e2e-strict-tool-call-probe-node.log
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");

const {
  createInferenceSelectionValidationHelpers,
} = require("./dist/lib/onboard/inference-selection-validation");
const localInference = require("./dist/lib/inference/local");

function assertStrictPayload(payload) {
  assert.equal(payload.model, "mock-tool-model");
  assert.equal(payload.tool_choice, "required");
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.stream, false);
  assert.equal(payload.temperature, 0);
  assert.ok(Array.isArray(payload.messages), "messages must be present");
  assert.ok(Array.isArray(payload.tools), "tools must be present");
  assert.ok(
    payload.tools.some((tool) => tool?.function?.name === "sessions_send"),
    "sessions_send tool must be present",
  );
}

function makeValidationHelpers(recoveryCalls) {
  return createInferenceSelectionValidationHelpers({
    isNonInteractive: () => false,
    agentProductName: () => "NemoClaw",
    promptValidationRecovery: async (_label, recovery) => {
      recoveryCalls.push(recovery);
      return "retry";
    },
  });
}

function strictOllamaProbeOptions() {
  const options = localInference.buildOllamaProbeOptions(false);
  assert.equal(options.skipResponsesProbe, true);
  assert.equal(options.requireChatCompletionsToolCalling, true);
  return options;
}

async function validate(endpoint, recoveryCalls = []) {
  const helpers = makeValidationHelpers(recoveryCalls);
  return helpers.validateOpenAiLikeSelection(
    "Local Ollama",
    endpoint,
    "mock-tool-model",
    null,
    "Choose a different Ollama model or select Other.",
    null,
    strictOllamaProbeOptions(),
  );
}

function serverSource() {
  return String.raw`
const fs = require("node:fs");
const http = require("node:http");

const mode = process.env.MOCK_MODE;
const requestsFile = process.env.REQUESTS_FILE;
let count = 0;

function toolCallResponse() {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: "sessions_send",
                arguments: JSON.stringify({ message: "hello" }),
              },
            },
          ],
        },
      },
    ],
  };
}

function plainTextResponse() {
  return { choices: [{ message: { role: "assistant", content: "OK" } }] };
}

function responseForRequest() {
  if (mode === "success") return { status: 200, body: toolCallResponse() };
  if (mode === "transient-502") {
    return count === 1
      ? { status: 502, body: { error: { message: "transient upstream failure" } } }
      : { status: 200, body: toolCallResponse() };
  }
  if (mode === "plain-text") return { status: 200, body: plainTextResponse() };
  return { status: 500, body: { error: { message: "unknown mock mode" } } };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    count += 1;
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let parsedBody = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch (error) {
      parsedBody = { parseError: error.message, rawBody };
    }
    fs.appendFileSync(
      requestsFile,
      JSON.stringify({ count, method: req.method, url: req.url, body: parsedBody }) + "\n",
    );
    const response = responseForRequest();
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
}

async function startMockEndpoint(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-strict-probe-${mode}-`));
  const requestsFile = path.join(dir, "requests.jsonl");
  fs.writeFileSync(requestsFile, "");
  const child = spawn(process.execPath, ["-e", serverSource()], {
    env: { ...process.env, MOCK_MODE: mode, REQUESTS_FILE: requestsFile },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    process.stderr.write(`[mock ${mode}] ${chunk}`);
  });

  const port = await new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      reject(new Error(`mock ${mode} did not report a port; stderr=${stderr}`));
    }, 5000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`mock ${mode} exited before ready with ${code}; stderr=${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split(/\r?\n/).find(Boolean);
      if (!line) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(line).port);
      } catch (error) {
        reject(error);
      }
    });
  });

  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    readRequests() {
      const raw = fs.readFileSync(requestsFile, "utf8").trim();
      return raw ? raw.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withMockEndpoint(mode, exercise) {
  const mock = await startMockEndpoint(mode);
  try {
    await exercise(mock.endpoint, () => mock.readRequests());
  } finally {
    await mock.stop();
  }
}

(async () => {
  await withMockEndpoint("success", async (endpoint, readRequests) => {
    const result = await validate(endpoint);
    assert.deepEqual(result, { ok: true, api: "openai-completions" });
    const requests = readRequests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/chat/completions");
    assertStrictPayload(requests[0].body);
    console.log("[PASS] strict validation succeeds with structured tool_calls");
  });

  await withMockEndpoint("transient-502", async (endpoint, readRequests) => {
    const result = await validate(endpoint);
    assert.deepEqual(result, { ok: true, api: "openai-completions" });
    const requests = readRequests();
    assert.equal(requests.length, 2);
    assertStrictPayload(requests[0].body);
    assertStrictPayload(requests[1].body);
    console.log("[PASS] strict validation retries a transient 502 and keeps bounded payloads");
  });

  await withMockEndpoint("plain-text", async (endpoint, readRequests) => {
    const recoveryCalls = [];
    const result = await validate(endpoint, recoveryCalls);
    assert.deepEqual(result, { ok: false, retry: "retry" });
    const requests = readRequests();
    assert.equal(requests.length, 1);
    assertStrictPayload(requests[0].body);
    assert.equal(recoveryCalls.length, 1);
    console.log("[PASS] strict validation fails closed when no structured tool_call is returned");
  });
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
NODE
NODE_EXIT=$?
set -e

if [ "$NODE_EXIT" -ne 0 ]; then
  fail "strict Chat Completions tool-call probe harness failed"
fi

pass "strict Chat Completions tool-call probe E2E passed"
