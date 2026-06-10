// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Process-level driver for the Local Ollama strict Chat Completions
// tool-call probe. Loaded by test/strict-tool-call-probe.test.ts via
// `tsx <driver>`; not picked up by Vitest's discovery (lives under
// test/fixtures/, which is excluded from the test glob).
//
// Mirrors the inline `node -e` block from the retired
// test/e2e/test-strict-tool-call-probe.sh, retained here so the
// caller-level behavior under test stays identical to production
// runtime conditions (subprocess curl probes, real env propagation,
// no Vitest worker shims). Refs #4537, #4349, #5098, #5119.
//
// CWD must be the repo root; cli build artifacts under dist/ are required.
//
// Authored as TypeScript (rather than .cjs) per the codebase-growth
// guardrail forbidding newly added .js/.cjs/.mjs files. Body is JS-shaped
// because the embedded `node -e` strings must remain plain CommonJS for
// the spawned children, and the dist/lib/* targets are CJS modules.
// `@ts-nocheck` keeps the surface unchanged from the retired bash heredoc.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const requireFromHere = createRequire(import.meta.url);
const { createInferenceSelectionValidationHelpers } = requireFromHere(
  path.join(REPO_ROOT, "dist", "lib", "onboard", "inference-selection-validation"),
);
const localInference = requireFromHere(path.join(REPO_ROOT, "dist", "lib", "inference", "local"));

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

function runOnboardingCallerAgainstMock(endpoint) {
  const port = new URL(endpoint).port;
  // The child runs with cwd=REPO_ROOT (set via spawnSync below) so its
  // `./dist/...` requires resolve consistently regardless of how this
  // driver was launched.
  const childScript = String.raw`
const assert = require("node:assert/strict");

process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_PROVIDER = "ollama";
process.env.NEMOCLAW_MODEL = "mock-tool-model";
process.env.NEMOCLAW_TEST_NO_SLEEP = "1";

const runner = require("./dist/lib/runner");
runner.run = () => ({ status: 0 });
runner.runShell = () => ({ status: 0 });
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : String(command);
  if (cmd.includes("command -v") && cmd.includes("ollama")) return "";
  if (cmd.includes("/api/tags")) {
    return JSON.stringify({ models: [{ name: "mock-tool-model" }] });
  }
  if (cmd.includes("/api/show")) {
    return JSON.stringify({ capabilities: ["completion", "tools"] });
  }
  if (cmd.includes("/api/ps")) {
    return JSON.stringify({ models: [{ name: "mock-tool-model", context_length: 4096 }] });
  }
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};
runner.runCaptureEx = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : String(command);
  if (cmd.includes("/api/generate")) {
    return { stdout: JSON.stringify({ response: "hello" }), stderr: "", exitCode: 0, timedOut: false };
  }
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
};

require("./dist/lib/onboard/ollama-systemd").ensureOllamaLoopbackSystemdOverride = () => "ready";
require("./dist/lib/onboard/local-inference-topology").shouldFrontOllamaWithProxy = () => false;

const credentials = require("./dist/lib/credentials/store");
credentials.prompt = async (message) => {
  throw new Error("Unexpected prompt during non-interactive Ollama onboarding: " + message);
};
credentials.ensureApiKey = async () => {
  throw new Error("Unexpected API key request during Local Ollama onboarding");
};

const lines = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => lines.push(args.join(" "));
console.error = (...args) => lines.push(args.join(" "));

(async () => {
  try {
    const { setupNim } = require("./dist/lib/onboard");
    const result = await setupNim(null, null);
    originalLog(JSON.stringify({ result, lines }));
  } catch (error) {
    originalError(lines.join("\n"));
    originalError(error && error.stack ? error.stack : error);
    process.exit(1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
})();
`;

  const result = spawnSync(process.execPath, ["-e", childScript], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NEMOCLAW_OLLAMA_PORT: port },
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
  assert.equal(payload.result.provider, "ollama-local");
  assert.equal(payload.result.model, "mock-tool-model");
  assert.equal(payload.result.preferredInferenceApi, "openai-completions");
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

  await withMockEndpoint("success", async (endpoint, readRequests) => {
    runOnboardingCallerAgainstMock(endpoint);
    const requests = readRequests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/chat/completions");
    assertStrictPayload(requests[0].body);
    console.log(
      "[PASS] Local Ollama onboarding caller enforces strict Chat Completions validation",
    );
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
