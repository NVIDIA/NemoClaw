// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { testTimeout } from "./helpers/timeouts";

const CREDENTIAL_RETRY_PROMPT =
  "  Options: retry (re-enter key), back (change provider), exit [retry]: ";
const CREDENTIAL_RETRY_PROMPT_RE =
  /Options: retry \(re-enter key\), back \(change provider\), exit \[retry\]: /;
const OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE =
  '{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}';
const PROVIDER_SELECTION_TEST_TIMEOUT_MS = testTimeout(60_000);

function writeOpenAiStyleAuthRetryCurl(fakeBin: string, goodToken: string, models = ["gpt-5.4"]) {
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
body='{"error":{"message":"forbidden"}}'
status="403"
outfile=""
auth=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -H)
      if echo "$2" | grep -q '^Authorization: Bearer '; then
        auth="$2"
      fi
      shift 2
      ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
# Also extract auth from ?key= query parameter (Gemini uses this instead of Bearer header)
url_auth=""
if echo "$url" | grep -q '[?&]key='; then
  url_auth=$(echo "$url" | sed 's/.*[?&]key=\\([^&]*\\).*/\\1/')
fi
# Strip query params for URL path matching
url_path=$(echo "$url" | sed 's/?.*//')
if echo "$url_path" | grep -q '/models$'; then
  body='{"data":[${models.map((model) => `{"id":"${model}"}`).join(",")}]}'
  status="200"
elif (echo "$auth" | grep -q '${goodToken}' || echo "$url_auth" | grep -q '${goodToken}') && echo "$url_path" | grep -q '/responses$'; then
  body='{"id":"resp_123"}'
  status="200"
elif (echo "$auth" | grep -q '${goodToken}' || echo "$url_auth" | grep -q '${goodToken}') && echo "$url_path" | grep -q '/chat/completions$'; then
  body='{"id":"chatcmpl-123"}'
  status="200"
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
    { mode: 0o755 },
  );
}

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
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
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
  body='{"id":"msg_123","content":[{"type":"text","text":"OK"}]}'
  status="200"
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
    { mode: 0o755 },
  );
}

type CredentialBackScenario = {
  name: string;
  answers: string[];
  menuSelections?: string[];
  credentialEnv: string;
  promptPattern: RegExp;
  expectedOutcome?: "back" | "exit";
  env?: Record<string, string>;
  agent?: "hermes";
  gpu?: Record<string, unknown> | null;
  stubNim?: boolean;
};

function writeAlwaysOkCurl(fakeBin: string, body = '{"id":"resp_123"}') {
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
body='${body}'
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
# Model the real auth proxy: an unauthenticated request to :11435 gets 401,
# so startOllamaAuthProxy's readiness proof (unauth 401 + authenticated non-401)
# recognises this as our proxy. Harmless to non-proxy probes.
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

function runCredentialBackScenario(scenario: CredentialBackScenario) {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-credential-back-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(
    tmpDir,
    `${scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.js`,
  );
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const agentDefsPath = JSON.stringify(path.join(repoRoot, "src", "lib", "agent", "defs.ts"));
  const nimPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "nim.ts"));

  fs.mkdirSync(fakeBin, { recursive: true });
  writeAlwaysOkCurl(fakeBin);

  const script = String.raw`
const answers = ${JSON.stringify(scenario.answers)};
const menuSelections = ${JSON.stringify(scenario.menuSelections || [])};
let menuSelectionIndex = 0;
const expectedOutcome = ${JSON.stringify(scenario.expectedOutcome || "back")};
const scenarioEnv = ${JSON.stringify(scenario.env || {})};
const messages = [];
const prompts = [];
const saved = [];
const lines = [];
const clearCredentialEnv = [
  "NVIDIA_API_KEY", "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "NOUS_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "NGC_API_KEY",
  "NEMOCLAW_PROVIDER_KEY",
];
const clearOnboardControlEnv = [
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_YES",
  "NEMOCLAW_PREFERRED_API",
  "NEMOCLAW_EXPERIMENTAL",
];

for (const key of [...clearCredentialEnv, ...clearOnboardControlEnv]) {
  delete process.env[key];
}
Object.assign(process.env, scenarioEnv);

const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const nim = require(${nimPath});

function selectRecentMenuOption(patternText, lines) {
  const pattern = new RegExp(patternText, "i");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*(\d+)\)\s+(.+)$/.exec(lines[index]);
    if (match && pattern.test(match[2])) return match[1];
  }
  throw new Error(
    "Could not find menu option matching " +
      pattern +
      "\\nRecent output:\\n" +
      lines.slice(-20).join("\\n"),
  );
}

credentials.prompt = async (message, opts = {}) => {
  messages.push(message);
  prompts.push({ message, secret: opts.secret === true });
  if (/Choose \[/.test(message) && menuSelectionIndex < menuSelections.length) {
    return selectRecentMenuOption(menuSelections[menuSelectionIndex++], lines);
  }
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => {
  return { kind: "credential", value: "nvapi-good" };
};
const originalSaveCredential = credentials.saveCredential;
credentials.saveCredential = (key, value) => {
  saved.push({ key, value });
  return originalSaveCredential(key, value);
};
runner.runCapture = () => "";

if (${JSON.stringify(scenario.stubNim === true)}) {
  nim.isNgcLoggedIn = () => false;
  nim.dockerLoginNgc = () => {
    throw new Error("NGC login should not run after back navigation");
  };
  nim.pullNimImage = () => "image";
  nim.startNimContainerByName = () => "container";
  nim.waitForNimHealth = () => true;
}

const { setupNim } = require(${onboardPath});
const agent = ${JSON.stringify(scenario.agent || null)}
  ? require(${agentDefsPath}).loadAgent(${JSON.stringify(scenario.agent || null)})
  : null;

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  if (expectedOutcome === "exit") {
    process.exit = (code) => {
      const error = new Error("process.exit:" + code);
      error.exitCode = code;
      throw error;
    };
  }
  try {
    const result = await setupNim(${JSON.stringify(scenario.gpu ?? null)}, null, agent);
    originalLog(JSON.stringify({
      outcome: "completed",
      result,
      messages,
      prompts,
      lines,
      saved,
      menuSelectionIndex,
      credentialValue: process.env[${JSON.stringify(scenario.credentialEnv)}] || null,
    }));
  } catch (error) {
    if (expectedOutcome !== "exit" || error.exitCode === undefined) {
      throw error;
    }
    originalLog(JSON.stringify({
      outcome: "exit",
      exitCode: error.exitCode,
      messages,
      prompts,
      lines,
      saved,
      menuSelectionIndex,
      credentialValue: process.env[${JSON.stringify(scenario.credentialEnv)}] || null,
    }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
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
    timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.menuSelectionIndex, scenario.menuSelections?.length || 0);
  if (scenario.expectedOutcome === "exit") {
    assert.equal(payload.outcome, "exit");
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.credentialValue, null);
    assert.deepEqual(payload.saved, []);
    assert.ok(payload.lines.some((line: string) => line.includes("Exiting onboarding.")));
    assert.ok(
      payload.prompts.some(
        (entry: { message: string; secret: boolean }) =>
          scenario.promptPattern.test(entry.message) && entry.secret,
      ),
    );
    return;
  }
  assert.equal(payload.outcome, "completed");
  assert.equal(payload.result.provider, "nvidia-prod");
  assert.ok(
    payload.lines.some((line: string) => line.includes("Returning to provider selection.")),
  );
  assert.ok(
    payload.prompts.some(
      (entry: { message: string; secret: boolean }) =>
        scenario.promptPattern.test(entry.message) && entry.secret,
    ),
  );
  assert.ok(payload.saved.every((entry: { key: string; value: string }) => entry.value !== "back"));
  assert.equal(payload.credentialValue, null);
}

describe("onboard provider selection UX", { timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS }, () => {
  it("prompts explicitly instead of silently auto-selecting detected Ollama", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-selection-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "selection-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, '{"id":"ok"}');
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});

let promptCalls = 0;
const messages = [];
const updates = [];

credentials.prompt = async (message) => {
  promptCalls += 1;
  messages.push(message);
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [{ name: "nemotron-3-nano:30b" }] });
  if (cmd.includes("ollama list")) return "nemotron-3-nano:30b  abc  24 GB  now\\nqwen3:32b  def  20 GB  now";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};
registry.updateSandbox = (_name, update) => updates.push(update);

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("selection-test", null);
    originalLog(JSON.stringify({ result, promptCalls, messages, updates, lines }));
  } finally {
    console.log = originalLog;
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

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.equal(payload.result.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.equal(payload.promptCalls, 2);
    assert.match(payload.messages[0], /Choose \[/);
    assert.match(payload.messages[1], /Choose model \[2\]/);
    assert.ok(
      payload.lines.some((line: string) => line.includes("Detected local inference option")),
    );
    assert.ok(payload.lines.some((line: string) => line.includes("Cloud models:")));
    assert.ok(
      payload.lines.some((line: string) => line.includes("Chat Completions API available")),
    );
    // #3951: step 3 banner must be provider-agnostic — selecting a non-NIM
    // provider (here, NVIDIA Endpoints) must not be labeled "(NIM)".
    assert.ok(
      payload.lines.some((line: string) => /\[3\/8\] Configuring inference provider\b/.test(line)),
      "expected provider-agnostic [3/8] banner",
    );
    assert.ok(
      !payload.lines.some((line: string) => line.includes("Configuring inference (NIM)")),
      'step 3 banner must not be labeled "Configuring inference (NIM)" for non-NIM providers',
    );
  });

  it("does not label NVIDIA Endpoints as recommended in the provider list", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-no-recommended-label-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "no-recommended-label-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, '{"id":"ok"}');

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const messages = [];
credentials.prompt = async (message) => {
  messages.push(message);
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await setupNim(null);
    originalLog(JSON.stringify({ messages, lines }));
  } finally {
    console.log = originalLog;
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
    assert.ok(payload.lines.some((line: string) => line.includes("NVIDIA Endpoints")));
    assert.ok(
      !payload.lines.some((line: string) => line.includes("NVIDIA Endpoints (recommended)")),
    );
  });

  it("selects Kimi K2.6 from the filtered NVIDIA Endpoints featured model list", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-build-kimi-selection-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-kimi-selection-check.js");
    const curlArgsLog = path.join(tmpDir, "kimi-curl-args.log");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
args_log=${JSON.stringify(curlArgsLog)}
printf '%s\\n' "$*" >> "$args_log"
body='{"id":"ok"}'
status="200"
outfile="" streaming=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -N) streaming="1"; shift ;;
    -w) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q 'featured-models.json$'; then
  body='{"featured-models":[{"model":"nvidia/nemotron-3-ultra-550b-a55b","model-name":"Nemotron 3 Ultra 550B"},{"model":"nemotron-3-super-120b-a12b","model-name":"Nemotron 3 Super 120B"},{"model":"z-ai/glm-5.1","model-name":"GLM 5.1"},{"model":"moonshotai/kimi-k2.6","model-name":"Kimi K2.6"},{"model":"minimaxai/minimax-m2.7","model-name":"Minimax M2.7"}]}'
elif [ "$streaming" = "1" ]; then
  body='data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"OK"}}]}'$'\\n\\n''data: [DONE]'$'\\n'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["1", "3"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-test"; };
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.equal(payload.result.model, "moonshotai/kimi-k2.6");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.match(payload.messages[1], /Choose model \[2\]/);
    assert.ok(payload.lines.some((line: string) => line.includes("Loading NVIDIA")));
    assert.ok(payload.lines.some((line: string) => line.includes("Kimi K2.6")));
    assert.ok(!payload.lines.some((line: string) => line.includes("GLM 5.1")));
    assert.ok(
      payload.lines.some((line: string) => line.includes("Chat Completions API available")),
    );
    const curlInvocations = fs.readFileSync(curlArgsLog, "utf-8");
    assert.match(curlInvocations, /chat\/completions/);
  });

  it("accepts a manually entered NVIDIA Endpoints model after validating it against /models", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-build-model-selection-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-model-selection-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
status="200"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/models$'; then
  body='{"data":[{"id":"nvidia/nemotron-3-super-120b-a12b"},{"id":"custom/provider-model"}]}'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["1", "5", "custom/provider-model"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-test"; };
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.equal(payload.result.model, "custom/provider-model");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.match(payload.messages[1], /Choose model \[2\]/);
    assert.match(payload.messages[2], /NVIDIA Endpoints model id:/);
    assert.ok(payload.lines.some((line: string) => line.includes("Other...")));
  });

  it("reprompts for a manual NVIDIA Endpoints model when /models validation rejects it", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-build-model-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-model-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
status="200"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/models$'; then
  body='{"data":[{"id":"nvidia/nemotron-3-super-120b-a12b"},{"id":"custom/provider-model"}]}'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["1", "5", "bad/model", "custom/provider-model"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-test"; };
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.model, "custom/provider-model");
    assert.equal(
      payload.messages.filter((message: string) => /NVIDIA Endpoints model id:/.test(message))
        .length,
      2,
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("is not available from NVIDIA Endpoints")),
    );
  });

  it("shows curated Gemini models and supports Other for manual entry", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-gemini-selection-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "gemini-selection-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body=""
status="404"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if echo "$url" | grep -q '/chat/completions'; then
  status="200"
  body='{"choices":[{"message":{"content":"OK"}}]}'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

    const answers = ["6", "7", "gemini-custom"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.GEMINI_API_KEY = "gemini-secret";
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
  } finally {
    console.log = originalLog;
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
    assert.equal(payload.result.provider, "gemini-api");
    assert.equal(payload.result.model, "gemini-custom");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.match(payload.messages[0], /Choose \[/);
    assert.match(payload.messages[1], /Choose model \[5\]/);
    assert.match(payload.messages[2], /Google Gemini model id:/);
    assert.ok(payload.lines.some((line: string) => line.includes("Google Gemini models:")));
    assert.ok(payload.lines.some((line: string) => line.includes("gemini-2.5-flash")));
    assert.ok(payload.lines.some((line: string) => line.includes("Other...")));
    assert.ok(
      payload.lines.some((line: string) => line.includes("Chat Completions API available")),
    );
  });

  it("warms and validates Ollama via 127.0.0.1 before moving on", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-validation-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-validation-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const child_process = require("child_process");

child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });
const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  if (cmd === "nc" && args?.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

const answers = ["7", "1"];
const messages = [];
const commands = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.run = (command, opts = {}) => {
  commands.push(Array.isArray(command) ? command.join(" ") : command);
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [{ name: "nemotron-3-nano:30b" }] });
  if (cmd.includes("ollama list")) return "nemotron-3-nano:30b  abc  24 GB  now";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("127.0.0.1:11434/api/ps")) {
    return JSON.stringify({
      models: [{ name: "nemotron-3-nano:30b", context_length: 262144 }],
    });
  }
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(
      JSON.stringify({
        result,
        messages,
        lines,
        commands,
        contextWindow: process.env.NEMOCLAW_CONTEXT_WINDOW,
      }),
    );
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
        NEMOCLAW_CONTEXT_WINDOW: "",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    // GH #2519: ollama-local must not capture the host's OPENAI_API_KEY.
    // credentialEnv should be null so the wizard summary shows
    // "(not required for ollama-local)" and onboard-session.json does not
    // record OPENAI_API_KEY (which would later trip the rebuild preflight).
    assert.equal(payload.result.credentialEnv, null);
    // credentials.json must not have been written with an OPENAI_API_KEY
    // entry by the ollama-local path.
    const credsPath = path.join(tmpDir, ".nemoclaw", "credentials.json");
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
      assert.ok(
        !Object.prototype.hasOwnProperty.call(creds, "OPENAI_API_KEY"),
        "ollama-local onboard must not write OPENAI_API_KEY to credentials.json",
      );
    }
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Loading Ollama model: nemotron-3-nano:30b"),
      ),
    );
    assert.ok(
      payload.commands.some((command: string) =>
        command.includes("http://127.0.0.1:11434/api/generate"),
      ),
    );
    assert.equal(payload.contextWindow, "262144");
  });

  it("re-resolves auto-detected Ollama context windows across model selections", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-context-"));
    const scriptPath = path.join(tmpDir, "ollama-context-check.js");
    const localInferencePath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "local.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    const script = String.raw`
const runner = require(${runnerPath});

let models = [];
runner.runCapture = (command) => {
  const rendered = Array.isArray(command) ? command.join(" ") : command;
  if (rendered.includes("/api/ps")) {
    return JSON.stringify({ models });
  }
  return "";
};

const {
  applyOllamaRuntimeContextWindow,
  resetOllamaRuntimeContextWindowAutoState,
} = require(${localInferencePath});

const result = {};
const originalWarn = console.warn;
const originalLog = console.log;
console.warn = () => {};
console.log = () => {};
try {
  resetOllamaRuntimeContextWindowAutoState();
  delete process.env.NEMOCLAW_CONTEXT_WINDOW;

  models = [{ name: "qwen3.6:35b", context_length: 262144 }];
  applyOllamaRuntimeContextWindow("qwen3.6:35b");
  result.initial = process.env.NEMOCLAW_CONTEXT_WINDOW || null;

  models = [{ name: "qwen2.5:7b", context_length: 32768 }];
  applyOllamaRuntimeContextWindow("qwen2.5:7b");
  result.updated = process.env.NEMOCLAW_CONTEXT_WINDOW || null;

  models = [];
  applyOllamaRuntimeContextWindow("qwen2.5:7b");
  result.cleared = process.env.NEMOCLAW_CONTEXT_WINDOW || null;

  resetOllamaRuntimeContextWindowAutoState();
  process.env.NEMOCLAW_CONTEXT_WINDOW = "262144";
  models = [{ name: "qwen2.5:7b", context_length: 32768 }];
  applyOllamaRuntimeContextWindow("qwen2.5:7b");
  result.userOverride = process.env.NEMOCLAW_CONTEXT_WINDOW || null;

  resetOllamaRuntimeContextWindowAutoState();
  process.env.NEMOCLAW_CONTEXT_WINDOW = "bogus";
  models = [{ name: "qwen2.5:7b", context_length: 32768 }];
  applyOllamaRuntimeContextWindow("qwen2.5:7b");
  result.invalidOverride = process.env.NEMOCLAW_CONTEXT_WINDOW || null;
} finally {
  console.warn = originalWarn;
  console.log = originalLog;
}

console.log(JSON.stringify(result));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      initial: "262144",
      updated: "32768",
      cleared: null,
      userOverride: "262144",
      invalidOverride: "bogus",
    });
  });

  it("starts managed Ollama on loopback before exposing the auth proxy", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-loopback-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-loopback-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const wait = require(${waitPath});
const child_process = require("child_process");

child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });
const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  if (cmd === "nc" && args?.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

const messages = [];
const runCommands = [];
const shellCommands = [];
const answers = ["7", "1"];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("ollama list")) return "qwen3:8b  abc  5 GB  now";
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
runner.run = (command) => {
  runCommands.push(Array.isArray(command) ? command.join(" ") : command);
  return { status: 0 };
};
runner.runShell = (command) => {
  shellCommands.push(command);
  return { status: 0 };
};

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;
wait.sleepSeconds = () => {};
// installOllamaSystem probes loopback at tries=1 before launching, then
// waits at tries=10 after launch. The fake curl in these tests answers 200
// to any URL, so real waitForHttp would short-circuit the manual launch.
// Differentiate by tries count.
wait.waitForHttp = (_url, tries) => (tries ?? 0) > 1;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines, runCommands, shellCommands }));
  } finally {
    console.log = originalLog;
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
        // Force the historical system-install path so this test still
        // exercises the install.sh + systemd loopback flow.  Vitest spawns
        // child processes without a TTY, which would otherwise route the
        // install through the sudo-free user-local fallback added for #4114.
        NEMOCLAW_OLLAMA_INSTALL_MODE: "system",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "ollama-local");
    assert.ok(
      payload.shellCommands.some((command: string) =>
        command.includes("OLLAMA_HOST=127.0.0.1:11434 ollama serve"),
      ),
      "managed Ollama launch should be loopback-only",
    );
    assert.ok(
      !payload.shellCommands.some((command: string) =>
        command.includes("OLLAMA_HOST=0.0.0.0:11434"),
      ),
      "managed Ollama launch must not expose raw Ollama on all interfaces",
    );
  });

  it("applies the systemd loopback override for an existing running Ollama install", {
    timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
  }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-systemd-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-systemd-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const runner = require(${runnerPath});
const platform = require(${platformPath});
const child_process = require("child_process");

child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });
const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  if (cmd === "nc" && args && args.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

const runCommands = [];
const shellCommands = [];

runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service enabled";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  return "";
};
runner.run = (command) => {
  runCommands.push(Array.isArray(command) ? command.join(" ") : command);
  return { status: 0 };
};
runner.runShell = (command) => {
  shellCommands.push(command);
  return { status: 0 };
};

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, lines, runCommands, shellCommands }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "ollama-local");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Configuring Ollama systemd loopback override"),
      ),
      "existing Ollama systemd installs should get the loopback override",
    );
    assert.ok(
      payload.shellCommands.some(
        (command: string) =>
          command.includes("install -D -m 0644") &&
          command.includes("/etc/systemd/system/ollama.service.d/override.conf") &&
          command.includes("systemctl daemon-reload") &&
          command.includes("systemctl --no-block restart ollama") &&
          command.includes("pre_state=$(") &&
          command.includes("current_state=$("),
      ),
      "should install and wait for the Ollama systemd drop-in restart",
    );
  });

  it("preserves existing Ollama systemd override settings while repairing loopback", {
    timeout: 10_000,
  }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-systemd-merge-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-systemd-merge-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const fs = require("fs");
const runner = require(${runnerPath});
const platform = require(${platformPath});
const child_process = require("child_process");

child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });
const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  if (cmd === "nc" && args && args.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

let installedBody = "";
const shellCommands = [];
const shellCalls = [];

runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service enabled";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  return "";
};
runner.run = () => ({ status: 0 });
runner.runShell = (command, opts = {}) => {
  shellCommands.push(command);
  shellCalls.push({ command, opts });
  if (command.includes("cat") && command.includes("ollama.service.d/override.conf")) {
    return {
      status: 0,
      stdout: [
        "[Service]",
        "Environment=\"OLLAMA_MODELS=/srv/ollama\"",
        "Environment=\"OLLAMA_HOST=0.0.0.0:11434\"",
        "Environment=\"HTTPS_PROXY=http://proxy.internal:8080\"",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n"),
    };
  }
  const match = command.match(/(?:sudo(?: -n)? )?install -D -m 0644 '([^']+)'/);
  if (match) installedBody = fs.readFileSync(match[1], "utf8");
  return { status: 0 };
};

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, shellCommands, shellCalls, installedBody }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "ollama-local");
    assert.ok(payload.installedBody.includes('Environment="OLLAMA_MODELS=/srv/ollama"'));
    assert.ok(
      payload.installedBody.includes('Environment="HTTPS_PROXY=http://proxy.internal:8080"'),
    );
    assert.ok(payload.installedBody.includes("[Install]"));
    assert.ok(payload.installedBody.includes("WantedBy=multi-user.target"));
    assert.ok(
      payload.shellCommands.some((command: string) =>
        command.includes("sudo -n install -D -m 0644"),
      ),
      "non-interactive systemd drop-in install should use sudo -n",
    );
    const catCall = payload.shellCalls.find(
      (call: { command: string }) =>
        call.command.includes("cat") && call.command.includes("ollama.service.d/override.conf"),
    );
    assert.ok(catCall, "expected existing drop-in inspection command");
    assert.equal(catCall.opts?.suppressOutput, true);
    assert.ok(
      catCall.command.includes("if [ -r"),
      "readable drop-ins should be inspected without sudo first",
    );
    assert.ok(
      catCall.command.indexOf("cat") < catCall.command.indexOf("sudo -n cat"),
      "sudo cat should only be the unreadable-file fallback",
    );

    const repairedHost = 'Environment="OLLAMA_HOST=127.0.0.1:11434"';
    const oldHost = 'Environment="OLLAMA_HOST=0.0.0.0:11434"';
    assert.ok(payload.installedBody.includes(repairedHost), "loopback host should be installed");
    assert.ok(
      !payload.installedBody.includes(oldHost),
      "legacy 0.0.0.0 OLLAMA_HOST line should be removed, not just shadowed (#3342)",
    );
    assert.ok(
      payload.installedBody.includes('Environment="OLLAMA_MODELS=/srv/ollama"'),
      "non-OLLAMA_HOST settings should be preserved",
    );
    assert.ok(
      payload.installedBody.includes('Environment="HTTPS_PROXY=http://proxy.internal:8080"'),
      "other Environment= settings should be preserved",
    );
  });

  it("adds Spark CUDA v13 and enables the Ollama systemd service on managed install", {
    timeout: 10_000,
  }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-systemd-spark-"));
    const scriptPath = path.join(tmpDir, "ollama-systemd-spark-check.js");
    const ollamaSystemdPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "ollama-systemd.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const localInferencePath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "local.ts"),
    );

    const script = String.raw`
const fs = require("fs");
const runner = require(${runnerPath});
const platform = require(${platformPath});
const localInference = require(${localInferencePath});

let installedBody = "";
const shellCommands = [];
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service disabled";
  return "";
};
runner.runShell = (command) => {
  shellCommands.push(command);
  if (command.includes("cat") && command.includes("ollama.service.d/override.conf")) {
    return {
      status: 0,
      stdout: [
        "[Service]",
        "Environment=\"OLLAMA_HOST=0.0.0.0:11434\"",
        "Environment=\"OLLAMA_LLM_LIBRARY=cuda\"",
        "",
      ].join("\\n"),
    };
  }
  const match = command.match(/(?:sudo(?: -n)? )?install -D -m 0644 '([^']+)'/);
  if (match) installedBody = fs.readFileSync(match[1], "utf8");
  return { status: 0, stdout: "" };
};
platform.isWsl = () => false;
localInference.findReachableOllamaHost = () => true;
Object.defineProperty(process, "platform", { value: "linux" });

const { ensureOllamaLoopbackSystemdOverride } = require(${ollamaSystemdPath});
const result = ensureOllamaLoopbackSystemdOverride({
  isNonInteractive: () => true,
  enableService: true,
  detectNvidiaPlatformImpl: () => "spark",
  hasOllamaCudaV13LibraryImpl: () => true,
});
console.log(JSON.stringify({ result, installedBody, shellCommands }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}");
    const installedLines = payload.installedBody.split(/\r?\n/);
    assert.equal(payload.result, "ready");
    assert.ok(payload.installedBody.includes('Environment="OLLAMA_HOST=127.0.0.1:11434"'));
    assert.ok(payload.installedBody.includes('Environment="OLLAMA_LLM_LIBRARY=cuda_v13"'));
    assert.ok(!installedLines.includes('Environment="OLLAMA_LLM_LIBRARY=cuda"'));
    assert.ok(
      payload.shellCommands.some((command: string) => command.includes("systemctl enable ollama")),
      "managed Ollama installs should enable the service for reboot survival",
    );
  });

  it("allows prompt-capable sudo in non-interactive Ollama systemd setup", {
    timeout: 10_000,
  }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-systemd-sudo-mode-"));
    const scriptPath = path.join(tmpDir, "ollama-systemd-sudo-mode-check.js");
    const ollamaSystemdPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "ollama-systemd.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const localInferencePath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "local.ts"),
    );

    const script = String.raw`
const runner = require(${runnerPath});
const platform = require(${platformPath});
const localInference = require(${localInferencePath});

const shellCommands = [];
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service enabled";
  return "";
};
runner.runShell = (command) => {
  shellCommands.push(command);
  return { status: 0, stdout: "" };
};
platform.isWsl = () => false;
localInference.findReachableOllamaHost = () => true;
Object.defineProperty(process, "platform", { value: "linux" });

const { ensureOllamaLoopbackSystemdOverride } = require(${ollamaSystemdPath});
const result = ensureOllamaLoopbackSystemdOverride({ isNonInteractive: () => true });
console.log(JSON.stringify({ result, shellCommands }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_NON_INTERACTIVE_SUDO_MODE: "prompt",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}");
    assert.equal(payload.result, "ready");
    assert.ok(
      payload.shellCommands.some((command: string) => command.includes("sudo install -D -m 0644")),
      "prompt sudo mode should use sudo without -n",
    );
    assert.ok(
      !payload.shellCommands.some((command: string) =>
        command.includes("sudo -n install -D -m 0644"),
      ),
      "prompt sudo mode should not use sudo -n",
    );
  });

  it("rejects unsupported non-interactive sudo mode values", { timeout: 10_000 }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-systemd-sudo-invalid-"));
    const scriptPath = path.join(tmpDir, "ollama-systemd-sudo-invalid-check.js");
    const ollamaSystemdPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "ollama-systemd.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));

    const script = String.raw`
const runner = require(${runnerPath});
const platform = require(${platformPath});

runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service enabled";
  return "";
};
platform.isWsl = () => false;
Object.defineProperty(process, "platform", { value: "linux" });

const { ensureOllamaLoopbackSystemdOverride } = require(${ollamaSystemdPath});
ensureOllamaLoopbackSystemdOverride({ isNonInteractive: () => true });
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_NON_INTERACTIVE_SUDO_MODE: "foo",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported NEMOCLAW_NON_INTERACTIVE_SUDO_MODE value: foo/);
  });

  it("repairs already-loopback systemd Ollama without starting a duplicate daemon", {
    timeout: 10_000,
  }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-ollama-systemd-loopback-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-systemd-loopback-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const runner = require(${runnerPath});
const platform = require(${platformPath});
const child_process = require("child_process");

child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });
const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  if (cmd === "nc" && args && args.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

const events = [];
const shellCommands = [];

runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) {
    events.push("tags");
    return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  }
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service enabled";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  return "";
};
runner.run = () => ({ status: 0 });
runner.runShell = (command) => {
  shellCommands.push(command);
  if (command.includes("systemctl") && command.includes("restart ollama")) events.push("restart");
  return { status: 0 };
};

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, lines, shellCommands, events }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "ollama-local");
    assert.ok(
      payload.shellCommands.some((command: string) =>
        command.includes("/etc/systemd/system/ollama.service.d/override.conf"),
      ),
      "already-loopback systemd Ollama still needs the persistent drop-in",
    );
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Configuring Ollama systemd loopback override"),
      ),
      "already-loopback repair should emit the visible loopback-override transcript",
    );
    assert.ok(
      !payload.shellCommands.some((command: string) =>
        command.includes("OLLAMA_HOST=127.0.0.1:11434 ollama serve"),
      ),
      "systemd restart success should not spawn a duplicate manual daemon",
    );
    const restartIndex = payload.events.indexOf("restart");
    assert.ok(restartIndex >= 0, "expected a systemd restart");
    assert.ok(
      payload.events.slice(restartIndex + 1).includes("tags"),
      "should re-probe after the systemd restart instead of trusting a stale loopback cache",
    );
  });

  it("fails closed instead of starting unmanaged Ollama when systemd restart stays unreachable", {
    timeout: 15_000,
  }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-existing-systemd-restart-fail-"),
    );
    const scriptPath = path.join(tmpDir, "existing-systemd-restart-fail-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));

    const script = String.raw`
const runner = require(${runnerPath});
const platform = require(${platformPath});
const wait = require(${waitPath});

let tagsProbeCount = 0;

runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) {
    tagsProbeCount += 1;
    return tagsProbeCount === 1 ? JSON.stringify({ models: [{ name: "qwen3:8b" }] }) : "";
  }
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service enabled";
  return "";
};
runner.runShell = (command) => {
  if (command.includes("ollama serve")) console.error("manual-start");
  return { status: 0 };
};

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;
wait.sleepSeconds = () => {};
// installOllamaSystem probes loopback at tries=1 before launching, then
// waits at tries=10 after launch. The fake curl in these tests answers 200
// to any URL, so real waitForHttp would short-circuit the manual launch.
// Differentiate by tries count.
wait.waitForHttp = (_url, tries) => (tries ?? 0) > 1;

const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim(null);
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Ollama systemd restart did not recover/);
    assert.doesNotMatch(result.stderr, /manual-start/);
  });

  it("fails closed when an existing Ollama systemd override cannot be applied", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-existing-systemd-fail-"),
    );
    const scriptPath = path.join(tmpDir, "existing-systemd-fail-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));

    const script = String.raw`
const runner = require(${runnerPath});
const platform = require(${platformPath});

runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service enabled";
  return "";
};
runner.runShell = (command) => {
  if (command.includes("ollama serve")) console.error("manual-start");
  if (command.includes("install -D -m 0644")) return { status: 1 };
  return { status: 0 };
};

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;

const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim(null);
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Failed to apply Ollama systemd loopback override/);
    assert.match(result.stderr, /Refusing to continue/);
    assert.doesNotMatch(result.stderr, /manual-start/);
  });

  it("returns to provider selection when Ollama manual entry chooses back", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["7", "2", "back", "1", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-good"; };
runner.run = () => ({ status: 0 });
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [{ name: "nemotron-3-nano:30b" }] });
  if (cmd.includes("ollama list")) return "nemotron-3-nano:30b  abc  24 GB  now";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.ok(
      payload.lines.some((line: string) => line.includes("Returning to provider selection.")),
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 2);
    assert.equal(
      payload.messages.filter((message: string) => /Ollama model id: /.test(message)).length,
      1,
    );
  });

  it("offers starter Ollama models when none are installed and pulls the selected model", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-bootstrap-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-bootstrap-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const pullLog = path.join(tmpDir, "pulls.log");

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);
    fs.writeFileSync(
      path.join(fakeBin, "ollama"),
      `#!/usr/bin/env bash
if [ "$1" = "pull" ]; then
  echo "$2" >> ${JSON.stringify(pullLog)}
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["7", "1", "y"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [] });
  if (cmd.includes("ollama list")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, "qwen3.5:9b");
    assert.ok(payload.lines.some((line: string) => line.includes("Ollama starter models:")));
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("No local Ollama models are installed yet"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("Pulling Ollama model: qwen3.5:9b")),
    );
    assert.equal(fs.readFileSync(pullLog, "utf8").trim(), "qwen3.5:9b");
  });

  it("reprompts inside the Ollama model flow when a pull fails", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const pullLog = path.join(tmpDir, "pulls.log");

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);
    fs.writeFileSync(
      path.join(fakeBin, "ollama"),
      `#!/usr/bin/env bash
if [ "$1" = "pull" ]; then
  echo "$2" >> ${JSON.stringify(pullLog)}
  if [ "$2" = "qwen3.5:9b" ]; then
    exit 1
  fi
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["7", "1", "y", "2", "llama3.2:3b", "y"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [] });
  if (cmd.includes("ollama list")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, "llama3.2:3b");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Failed to pull Ollama model 'qwen3.5:9b'"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Choose a different Ollama model or select Other."),
      ),
    );
    assert.equal(
      payload.messages.filter((message: string) => /Ollama model id:/.test(message)).length,
      1,
    );
    assert.equal(fs.readFileSync(pullLog, "utf8").trim(), "qwen3.5:9b\nllama3.2:3b");
  });

  it("re-prompts for a model when the user declines the size confirmation", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-decline-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-decline-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const pullLog = path.join(tmpDir, "pulls.log");

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);
    fs.writeFileSync(
      path.join(fakeBin, "ollama"),
      `#!/usr/bin/env bash
if [ "$1" = "pull" ]; then
  echo "$2" >> ${JSON.stringify(pullLog)}
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["7", "1", "n", "1", "y"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [] });
  if (cmd.includes("ollama list")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, "qwen3.5:9b");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Skipped pulling Ollama model 'qwen3.5:9b'"),
      ),
    );
    // Pull only happened on the second confirmation, not on the declined first attempt.
    assert.equal(fs.readFileSync(pullLog, "utf8").trim(), "qwen3.5:9b");
    const downloadPrompts = payload.messages.filter((message: string) =>
      /Download Ollama model/.test(message),
    );
    assert.equal(downloadPrompts.length, 2);
    // Each prompt must surface the resolved size — the whole point of #2639 —
    // either a "<value> <unit>" label or the explicit "size unknown" fallback.
    const sizePattern = /\((\d+(\.\d+)? (B|KB|MB|GB|TB)( \(estimated\))?|size unknown)\)/;
    for (const prompt of downloadPrompts) {
      assert.match(prompt, sizePattern);
    }
  });

  it("bypasses the size confirmation when NEMOCLAW_YES=1 is set", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-yes-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-yes-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const pullLog = path.join(tmpDir, "pulls.log");

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);
    fs.writeFileSync(
      path.join(fakeBin, "ollama"),
      `#!/usr/bin/env bash
if [ "$1" = "pull" ]; then
  echo "$2" >> ${JSON.stringify(pullLog)}
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["7", "1"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [] });
  if (cmd.includes("ollama list")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
        NEMOCLAW_YES: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, "qwen3.5:9b");
    assert.equal(fs.readFileSync(pullLog, "utf8").trim(), "qwen3.5:9b");
    // No "Download Ollama model 'X'?" prompt was issued — the env var bypassed it.
    assert.equal(
      payload.messages.filter((message: string) => /Download Ollama model/.test(message)).length,
      0,
    );
    // The size is still surfaced in the auto-yes path so unattended installs
    // record what was downloaded — assert the "Pulling Ollama model" log line
    // includes a size label or the "size unknown" fallback.
    const sizePattern = /\((\d+(\.\d+)? (B|KB|MB|GB|TB)( \(estimated\))?|size unknown)\)/;
    const pullingLine = payload.lines.find((line: string) =>
      /Pulling Ollama model 'qwen3.5:9b'/.test(line),
    );
    assert.ok(pullingLine, "expected a 'Pulling Ollama model' log line under NEMOCLAW_YES=1");
    assert.match(pullingLine, sizePattern);
  });

  it("reprompts for an OpenAI Other model when /models validation rejects it", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-model-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "openai-model-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
status="200"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/models$'; then
  body='{"data":[{"id":"gpt-5.4"},{"id":"gpt-5.4-mini"}]}'
elif echo "$url" | grep -q '/responses$'; then
  body='{"id":"resp_123"}'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["2", "5", "bad-model", "gpt-5.4-mini"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.model, "gpt-5.4-mini");
    assert.equal(
      payload.messages.filter((message: string) => /OpenAI model id:/.test(message)).length,
      2,
    );
    assert.ok(payload.lines.some((line: string) => line.includes("is not available from OpenAI")));
  });

  it("reprompts for an Anthropic Other model when /v1/models validation rejects it", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-anthropic-model-retry-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "anthropic-model-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"data":[{"id":"claude-sonnet-4-6"},{"id":"claude-haiku-4-5"}]}'
status="200"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["4", "4", "claude-bad", "claude-haiku-4-5"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.ANTHROPIC_API_KEY = "anthropic-test";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.model, "claude-haiku-4-5");
    assert.equal(
      payload.messages.filter((message: string) => /Anthropic model id:/.test(message)).length,
      2,
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("is not available from Anthropic")),
    );
  });

  it("returns to provider selection when Anthropic live validation fails interactively", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-anthropic-validation-retry-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "anthropic-validation-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"error":{"message":"invalid model"}}'
status="400"
outfile=""
url=""
args="$*"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/models$'; then
  body='{"data":[{"id":"claude-sonnet-4-6"},{"id":"claude-haiku-4-5"}]}'
  status="200"
elif echo "$url" | grep -q '/v1/messages$' && printf '%s' "$args" | grep -q 'claude-haiku-4-5'; then
  body='{"id":"msg_123","content":[{"type":"text","text":"OK"}]}'
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

const answers = ["4", "", "4", "2"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.ANTHROPIC_API_KEY = "anthropic-test";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.model, "claude-haiku-4-5");
    assert.ok(
      payload.lines.some((line: string) => line.includes("Anthropic endpoint validation failed")),
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("Please choose a provider/model again")),
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 2);
  });

  it("supports Other Anthropic-compatible endpoint with live validation", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-anthropic-compatible-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "anthropic-compatible-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"msg_123","content":[{"type":"text","text":"OK"}]}'
status="200"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["5", "https://proxy.example.com/v1/messages?token=secret#frag", "claude-sonnet-proxy"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_ANTHROPIC_API_KEY = "proxy-key";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.model, "claude-sonnet-proxy");
    assert.equal(payload.result.endpointUrl, "https://proxy.example.com");
    assert.equal(payload.result.preferredInferenceApi, "anthropic-messages");
    assert.match(payload.messages[1], /Anthropic-compatible base URL/);
    assert.match(payload.messages[2], /Other Anthropic-compatible endpoint model/);
    assert.ok(
      payload.lines.some((line: string) => line.includes("Anthropic Messages API available")),
    );
  });

  it("reprompts only for model name when Other OpenAI-compatible endpoint validation fails", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-custom-openai-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "custom-openai-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"error":{"message":"bad model"}}'
status="400"
outfile=""
body_arg=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -d) body_arg="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/responses$' && echo "$body_arg" | grep -q 'good-model'; then
  body='{"id":"resp_123","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}'
  status="200"
elif echo "$url" | grep -q '/chat/completions$' && echo "$body_arg" | grep -q 'good-model'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"OK"}}]}'
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

const answers = ["3", "https://proxy.example.com/v1/chat/completions?token=secret#frag", "bad-model", "good-model"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_API_KEY = "proxy-key";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "compatible-endpoint");
    assert.equal(payload.result.model, "good-model");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Other OpenAI-compatible endpoint endpoint validation failed"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Please enter a different Other OpenAI-compatible endpoint model name."),
      ),
    );
    assert.equal(
      payload.messages.filter((message: string) => /OpenAI-compatible base URL/.test(message))
        .length,
      1,
    );
    assert.equal(
      payload.messages.filter((message: string) =>
        /Other OpenAI-compatible endpoint model/.test(message),
      ).length,
      2,
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
  });

  it("falls back to chat completions for custom OpenAI-compatible endpoints when /responses lacks tool calls", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-custom-openai-responses-fallback-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "custom-openai-responses-fallback-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"error":{"message":"bad request"}}'
status="400"
outfile=""
body_arg=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -d) body_arg="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/responses$'; then
  body='{"id":"resp_123","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}'
  status="200"
elif echo "$url" | grep -q '/chat/completions$'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"OK"}}]}'
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

const answers = ["3", "https://proxy.example.com/v1", "custom-model"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_API_KEY = "proxy-key";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "compatible-endpoint");
    assert.equal(payload.result.model, "custom-model");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.ok(
      payload.lines.some((line: string) => line.includes("Chat Completions API available")),
    );
  });

  it("forces chat completions for custom OpenAI-compatible endpoints even when /responses returns valid tool calls (#1932)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-custom-openai-responses-force-completions-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "custom-openai-responses-force-completions-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Mock curl: /v1/responses returns a VALID response with tool calls
    // (simulates Ollama 0.20+ which exposes /v1/responses successfully)
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"error":{"message":"bad request"}}'
status="400"
outfile=""
body_arg=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -d) body_arg="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/responses$'; then
  body='{"id":"resp_123","output":[{"id":"fc_1","type":"function_call","name":"read","arguments":"{\\"path\\":\\"/tmp/test\\"}"},{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}'
  status="200"
elif echo "$url" | grep -q '/chat/completions$'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"OK"}}]}'
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

const answers = ["3", "https://ollama.local:11434/v1", "my-model"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_API_KEY = "ollama-key";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "compatible-endpoint");
    assert.equal(payload.result.model, "my-model");
    // Even though /v1/responses returned valid tool calls, we must force
    // chat completions because many backends (Ollama, vLLM, LiteLLM) do not
    // correctly handle the developer role used by the Responses API.
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    // Verify the wizard selected chat completions (either via our forced
    // override or via the streaming fallback — both are correct).
    assert.ok(payload.lines.some((line: string) => line.includes("openai-completions")));
  });

  it("honors NEMOCLAW_PREFERRED_API=openai-responses override for custom OpenAI-compatible endpoints (#1932)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-custom-openai-responses-override-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "custom-openai-responses-override-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Mock curl: /v1/responses returns a valid response (probe passes)
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"error":{"message":"bad request"}}'
status="400"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -d) shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/responses$'; then
  body='{"id":"resp_123","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}'
  status="200"
elif echo "$url" | grep -q '/chat/completions$'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"OK"}}]}'
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

const answers = ["3", "https://openai-proxy.example.com/v1", "gpt-4o"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_API_KEY = "sk-test";
  // Explicit override: user knows their backend supports the Responses API
  process.env.NEMOCLAW_PREFERRED_API = "openai-responses";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "compatible-endpoint");
    assert.equal(payload.result.model, "gpt-4o");
    // With NEMOCLAW_PREFERRED_API=openai-responses, the code path that
    // forces openai-completions is bypassed: our override check sees the
    // env var and uses validation.api instead. In this test, the mock
    // curl doesn't support SSE streaming, so the probe's streaming
    // fallback returns openai-completions regardless. A real backend with
    // proper streaming would yield openai-responses here.
    // The important thing: the env var is read and the forced-completions
    // override does NOT fire, proving the escape hatch works.
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    // Verify the forced-override message was NOT printed (env var bypassed it)
    assert.ok(
      !payload.lines.some((line: string) =>
        line.includes("compatible endpoints may not support the Responses API developer role"),
      ),
    );
  });

  it("returns to provider selection instead of exiting on blank custom endpoint input", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-custom-endpoint-blank-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "custom-endpoint-blank-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, '{"id":"ok"}');

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["3", "", "", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.equal(payload.result.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Endpoint URL is required for Other OpenAI-compatible endpoint."),
      ),
    );
    assert.ok(
      payload.messages.some((message: string) => /OpenAI-compatible base URL/.test(message)),
    );
    assert.ok(
      payload.messages.filter((message: string) => /Choose \[1\]/.test(message)).length >= 2,
    );
  });

  it("reprompts only for model name when Other Anthropic-compatible endpoint validation fails", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-custom-anthropic-retry-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "custom-anthropic-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"error":{"message":"bad model"}}'
status="400"
outfile=""
body_arg=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -d) body_arg="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/messages$' && echo "$body_arg" | grep -q 'good-claude'; then
  body='{"id":"msg_123","content":[{"type":"text","text":"OK"}]}'
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

const answers = ["5", "https://proxy.example.com/v1/messages?token=secret#frag", "bad-claude", "good-claude"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_ANTHROPIC_API_KEY = "proxy-key";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.model, "good-claude");
    assert.equal(payload.result.preferredInferenceApi, "anthropic-messages");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Other Anthropic-compatible endpoint endpoint validation failed"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Please enter a different Other Anthropic-compatible endpoint model name."),
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

  it("lets users type back at a lower-level model prompt to return to provider selection", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-model-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "model-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["3", "https://proxy.example.com/v1", "back", "1", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-good"; };
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_API_KEY = "proxy-key";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.ok(
      payload.lines.some((line: string) => line.includes("Returning to provider selection.")),
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 2);
    assert.equal(
      payload.messages.filter((message: string) => /OpenAI-compatible base URL/.test(message))
        .length,
      1,
    );
  });

  it("lets users type back at a secret provider credential prompt to return to provider selection", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-credential-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "credential-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin);

    const script = String.raw`
const clearCredentialEnv = [
  "NVIDIA_API_KEY", "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "NOUS_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "NGC_API_KEY",
  "NEMOCLAW_PROVIDER_KEY",
];
const clearOnboardControlEnv = [
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_YES",
  "NEMOCLAW_PREFERRED_API",
  "NEMOCLAW_EXPERIMENTAL",
];

for (const key of [...clearCredentialEnv, ...clearOnboardControlEnv]) {
  delete process.env[key];
}

const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["2", "back", "1", ""];
const messages = [];
const prompts = [];
const saved = [];

credentials.prompt = async (message, opts = {}) => {
  messages.push(message);
  prompts.push({ message, secret: opts.secret === true });
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => {
  return { kind: "credential", value: "nvapi-good" };
};
const originalSaveCredential = credentials.saveCredential;
credentials.saveCredential = (key, value) => {
  saved.push({ key, value });
  return originalSaveCredential(key, value);
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
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
      prompts,
      lines,
      saved,
      openaiKey: process.env.OPENAI_API_KEY || null,
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
      timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.equal(payload.openaiKey, null);
    assert.ok(
      payload.saved.every((entry: { key: string; value: string }) => entry.value !== "back"),
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("Returning to provider selection.")),
    );
    assert.ok(
      payload.prompts.some(
        (entry: { message: string; secret: boolean }) =>
          /OpenAI API key: /.test(entry.message) && entry.secret,
      ),
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 2);
  });

  const secretCredentialBackScenarios: CredentialBackScenario[] = [
    {
      name: "Anthropic",
      answers: ["4", "back", "1", ""],
      credentialEnv: "ANTHROPIC_API_KEY",
      promptPattern: /Anthropic API key: /,
    },
    {
      name: "Anthropic exit",
      answers: ["4", "exit"],
      credentialEnv: "ANTHROPIC_API_KEY",
      promptPattern: /Anthropic API key: /,
      expectedOutcome: "exit",
    },
    {
      name: "Google Gemini",
      answers: ["6", "back", "1", ""],
      credentialEnv: "GEMINI_API_KEY",
      promptPattern: /Google Gemini API key: /,
    },
    {
      name: "Other OpenAI-compatible endpoint",
      answers: ["3", "https://proxy.example.com/v1", "back", "1", ""],
      credentialEnv: "COMPATIBLE_API_KEY",
      promptPattern: /Other OpenAI-compatible endpoint API key: /,
    },
    {
      name: "Other Anthropic-compatible endpoint",
      answers: ["5", "https://proxy.example.com", "back", "1", ""],
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      promptPattern: /Other Anthropic-compatible endpoint API key: /,
    },
    {
      name: "Model Router",
      answers: ["back", ""],
      menuSelections: ["Model Router", "NVIDIA Endpoints"],
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      promptPattern: /Model Router API key: /,
    },
    {
      name: "Hermes Provider Nous API key",
      answers: ["back", ""],
      menuSelections: ["Hermes Provider", "Nous API Key", "NVIDIA Endpoints"],
      credentialEnv: "NOUS_API_KEY",
      promptPattern: /Nous API Key: /,
      agent: "hermes",
    },
    {
      name: "Local NIM NGC API key",
      answers: ["", "back", ""],
      menuSelections: ["Local NVIDIA NIM", "NVIDIA Endpoints"],
      credentialEnv: "NGC_API_KEY",
      promptPattern: /NGC API Key: /,
      env: { NEMOCLAW_EXPERIMENTAL: "1" },
      gpu: {
        type: "nvidia",
        name: "test-gpu",
        count: 1,
        totalMemoryMB: 999999,
        perGpuMB: 999999,
        nimCapable: true,
      },
      stubNim: true,
    },
  ];

  for (const scenario of secretCredentialBackScenarios) {
    const action = scenario.expectedOutcome === "exit" ? "exit" : "back";
    it(`lets users type ${action} at the ${scenario.name} secret credential prompt`, () => {
      runCredentialBackScenario(scenario);
    });
  }

  it("lets users type back after a transport validation failure to return to provider selection", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-transport-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "transport-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q 'api.openai.com'; then
  printf '%s' 'curl: (6) Could not resolve host: api.openai.com' >&2
  exit 6
fi
printf '%s' '{"id":"resp_123"}' > "$outfile"
printf '200'
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["2", "", "back", "1", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-good"; };
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("could not resolve the provider hostname"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("Returning to provider selection.")),
    );
    assert.equal(
      payload.messages.filter((message: string) =>
        /Type 'retry', 'back', or 'exit' \[retry\]: /.test(message),
      ).length,
      1,
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 2);
  });

  it("returns to provider selection when endpoint validation fails interactively", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-selection-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "selection-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"error":{"message":"bad request"}}'
status="400"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if echo "$url" | grep -q 'generativelanguage.googleapis.com' && echo "$url" | grep -q '/responses$'; then
  body='{"id":"ok"}'
  status="200"
elif echo "$url" | grep -q 'generativelanguage.googleapis.com' && echo "$url" | grep -q '/chat/completions$'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"OK"}}]}'
  status="200"
elif echo "$url" | grep -q 'integrate.api.nvidia.com' && echo "$url" | grep -q '/responses$'; then
  body='{"id":"resp_123"}'
  status="200"
elif echo "$url" | grep -q 'integrate.api.nvidia.com' && echo "$url" | grep -q '/chat/completions$'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"OK"}}]}'
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

const answers = ["2", "", "back", "1", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-good"; };
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.GEMINI_API_KEY = "gemini-test";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.ok(
      payload.lines.some((line: string) => line.includes("OpenAI endpoint validation failed")),
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("Please choose a provider/model again")),
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 2);
  });

  it("fails early in non-interactive mode when explicit cloud provider key is not nvapi-", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-build-noninteractive-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-noninteractive-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const prompts = [];
credentials.prompt = async (message) => {
  prompts.push(message);
  throw new Error("unexpected prompt");
};
credentials.ensureApiKey = async () => {
  throw new Error("unexpected ensureApiKey");
};
runner.runCapture = () => "";

process.env.NVIDIA_INFERENCE_API_KEY = "sk-test";
process.env.NEMOCLAW_PROVIDER = "cloud";
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  process.exit = (code) => {
    const error = new Error("process.exit:" + code);
    error.exitCode = code;
    throw error;
  };
  try {
    await setupNim(null);
    originalLog(JSON.stringify({ completed: true, prompts, lines }));
  } catch (error) {
    originalLog(
      JSON.stringify({
        completed: false,
        prompts,
        lines,
        message: error.message,
        exitCode: error.exitCode ?? null,
      }),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
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
    assert.equal(payload.completed, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.prompts.length, 0);
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Invalid NVIDIA API key. Must start with nvapi-"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Get a key from https://build.nvidia.com/settings/api-keys"),
      ),
    );
  });

  it("fails early in non-interactive mode with copy-paste recovery hints when no NVIDIA_INFERENCE_API_KEY is set", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-build-missingkey-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-missingkey-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Fake openshell: report the inference provider as absent so the
    // gateway-credential-reuse fallback does NOT swallow the missing-key
    // error path under test.
    fs.writeFileSync(path.join(fakeBin, "openshell"), `#!${process.execPath}\nprocess.exit(1);\n`, {
      mode: 0o755,
    });

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const prompts = [];
credentials.prompt = async (message) => {
  prompts.push(message);
  throw new Error("unexpected prompt");
};
credentials.ensureApiKey = async () => {
  throw new Error("unexpected ensureApiKey");
};
runner.runCapture = () => "";

for (const key of ["NVIDIA_API_KEY", "NVIDIA_INFERENCE_API_KEY", "NGC_API_KEY", "NEMOCLAW_PROVIDER_KEY"]) delete process.env[key];
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  process.exit = (code) => {
    const error = new Error("process.exit:" + code);
    error.exitCode = code;
    throw error;
  };
  try {
    await setupNim(null);
    originalLog(JSON.stringify({ completed: true, prompts, lines }));
  } catch (error) {
    originalLog(
      JSON.stringify({
        completed: false,
        prompts,
        lines,
        message: error.message,
        exitCode: error.exitCode ?? null,
      }),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
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
    assert.equal(payload.completed, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.prompts.length, 0);
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes(
          "NVIDIA_INFERENCE_API_KEY (or NEMOCLAW_PROVIDER_KEY) is required for NVIDIA Endpoints in non-interactive mode.",
        ),
      ),
    );
    const setWithIndex = payload.lines.findIndex((line: string) => line.trim() === "Set with:");
    assert.ok(setWithIndex >= 0, "expected a standalone 'Set with:' line");
    assert.equal(
      payload.lines[setWithIndex + 1].trim(),
      "export NVIDIA_INFERENCE_API_KEY=nvapi-...",
      "expected the export command on its own line so it can be copy-pasted",
    );
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Get a key from https://build.nvidia.com/settings/api-keys"),
      ),
    );
  });

  it("lets users re-enter an NVIDIA API key after authorization failure without restarting selection", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-build-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"error":{"message":"forbidden"}}'
status="403"
outfile=""
auth=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -H)
      if echo "$2" | grep -q '^Authorization: Bearer '; then
        auth="$2"
      fi
      shift 2
      ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$auth" | grep -q 'nvapi-good' && echo "$url" | grep -q '/responses$'; then
  body='{"id":"resp_123"}'
  status="200"
elif echo "$auth" | grep -q 'nvapi-good' && echo "$url" | grep -q '/chat/completions$'; then
  body='{"id":"chatcmpl-123"}'
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

const answers = ["", "", "retry", "nvapi-good"];
const messages = [];
const prompts = [];

credentials.prompt = async (message, opts = {}) => {
  messages.push(message);
  prompts.push({ message, secret: opts.secret === true });
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, prompts, lines, key: process.env.NVIDIA_INFERENCE_API_KEY }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.equal(payload.key, "nvapi-good");
    assert.ok(
      payload.lines.some((line: string) => line.includes("NVIDIA Endpoints authorization failed")),
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
    assert.equal(
      payload.messages.filter((message: string) => /Choose model \[2\]/.test(message)).length,
      1,
    );
    assert.ok(payload.messages.some((message: string) => CREDENTIAL_RETRY_PROMPT_RE.test(message)));
    const retryPrompt = payload.prompts.find((entry: { message: string }) =>
      CREDENTIAL_RETRY_PROMPT_RE.test(entry.message),
    );
    assert.deepEqual(retryPrompt, {
      message: CREDENTIAL_RETRY_PROMPT,
      secret: true,
    });
    assert.ok(
      payload.messages.some((message: string) => /NVIDIA Endpoints API key: /.test(message)),
    );
  });

  it("treats a pasted NVIDIA API key at the retry prompt as retry and re-prompts securely", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-nvidia-paste-guard-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "nvidia-paste-guard-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOpenAiStyleAuthRetryCurl(fakeBin, "nvapi-good", ["nim/meta/llama-3.1-70b-instruct"]);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["1", "", "nvapi-fake-key-value", "nvapi-good", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines, key: process.env.NVIDIA_INFERENCE_API_KEY }));
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
    assert.equal(payload.result.provider, "nvidia-prod");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.equal(payload.key, "nvapi-good");
    assert.ok(payload.lines.some((line: string) => line.includes("That looks like an API key")));
    assert.ok(payload.lines.some((line: string) => line.includes("Treating as 'retry'")));
    assert.ok(payload.messages.some((message: string) => CREDENTIAL_RETRY_PROMPT_RE.test(message)));
    assert.ok(
      payload.messages.some((message: string) => /NVIDIA Endpoints API key: /.test(message)),
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
    assert.equal(
      payload.messages.filter((message: string) => /Choose model \[2\]/.test(message)).length,
      1,
    );
  });

  it("lets users re-enter an OpenAI API key after authorization failure", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "openai-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOpenAiStyleAuthRetryCurl(fakeBin, "sk-good", ["gpt-5.4"]);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["2", "", "retry", "sk-good", ""];
const messages = [];
const prompts = [];

credentials.prompt = async (message, opts = {}) => {
  messages.push(message);
  prompts.push({ message, secret: opts.secret === true });
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.OPENAI_API_KEY = "sk-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, prompts, lines, key: process.env.OPENAI_API_KEY }));
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
    assert.equal(payload.result.provider, "openai-api");
    assert.equal(payload.result.model, "gpt-5.4");
    assert.equal(payload.result.preferredInferenceApi, "openai-responses");
    assert.equal(payload.key, "sk-good");
    assert.ok(payload.lines.some((line: string) => line.includes("OpenAI authorization failed")));
    assert.ok(payload.messages.some((message: string) => CREDENTIAL_RETRY_PROMPT_RE.test(message)));
    assert.ok(payload.messages.some((message: string) => /OpenAI API key: /.test(message)));
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
    assert.equal(
      payload.messages.filter((message: string) => /Choose model \[1\]/.test(message)).length,
      2,
    );
  });

  it("lets users re-enter an Anthropic API key after authorization failure", () => {
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

  it("lets users re-enter a Gemini API key after authorization failure", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-gemini-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "gemini-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOpenAiStyleAuthRetryCurl(fakeBin, "gemini-good", ["gemini-2.5-flash"]);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["6", "", "retry", "gemini-good", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.GEMINI_API_KEY = "gemini-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines, key: process.env.GEMINI_API_KEY }));
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
    assert.equal(payload.result.provider, "gemini-api");
    assert.equal(payload.result.model, "gemini-2.5-flash");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.equal(payload.key, "gemini-good");
    assert.ok(
      payload.lines.some((line: string) => line.includes("Google Gemini authorization failed")),
    );
    assert.ok(payload.messages.some((message: string) => CREDENTIAL_RETRY_PROMPT_RE.test(message)));
    assert.ok(payload.messages.some((message: string) => /Google Gemini API key: /.test(message)));
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
    assert.equal(
      payload.messages.filter((message: string) => /Choose model \[5\]/.test(message)).length,
      2,
    );
  });

  it("lets users re-enter a custom OpenAI-compatible API key without re-entering the endpoint URL", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-custom-openai-auth-retry-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "custom-openai-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOpenAiStyleAuthRetryCurl(fakeBin, "proxy-good", ["custom-model"]);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["3", "https://proxy.example.com/v1/chat/completions?token=secret#frag", "custom-model", "retry", "proxy-good", "custom-model"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  process.env.COMPATIBLE_API_KEY = "proxy-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines, key: process.env.COMPATIBLE_API_KEY }));
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
    assert.equal(payload.result.provider, "compatible-endpoint");
    assert.equal(payload.result.model, "custom-model");
    assert.equal(payload.result.endpointUrl, "https://proxy.example.com/v1");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.equal(payload.key, "proxy-good");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Other OpenAI-compatible endpoint authorization failed"),
      ),
    );
    assert.ok(payload.messages.some((message: string) => CREDENTIAL_RETRY_PROMPT_RE.test(message)));
    assert.ok(
      payload.messages.some((message: string) =>
        /Other OpenAI-compatible endpoint API key: /.test(message),
      ),
    );
    assert.equal(
      payload.messages.filter((message: string) => /OpenAI-compatible base URL/.test(message))
        .length,
      1,
    );
    assert.equal(
      payload.messages.filter((message: string) =>
        /Other OpenAI-compatible endpoint model/.test(message),
      ).length,
      2,
    );
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
  });

  it("lets users re-enter a custom Anthropic-compatible API key without re-entering the endpoint URL", () => {
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

  it("forces openai-completions for vLLM even when probe detects openai-responses", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-vllm-override-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "vllm-override-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Fake curl: /v1/responses returns 200 (so probe detects openai-responses),
    // /v1/models returns a vLLM model list
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body=''
status="200"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/models'; then
  body='{"data":[{"id":"meta-llama/Llama-3.3-70B-Instruct"}]}'
elif echo "$url" | grep -q '/v1/responses'; then
  body='{"id":"resp_123","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}'
elif echo "$url" | grep -q '/v1/chat/completions'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"ok"}}]}'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    // vLLM is option 7 (build, openai, custom, anthropic, anthropicCompatible, gemini, vllm)
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["7"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return JSON.stringify({ data: [{ id: "meta-llama/Llama-3.3-70B-Instruct" }] });
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_EXPERIMENTAL: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "vllm-local");
    assert.equal(payload.result.model, "meta-llama/Llama-3.3-70B-Instruct");
    // Key assertion: even though probe detected openai-responses, the override
    // forces openai-completions so tool-call-parser works correctly.
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.ok(payload.lines.some((line: string) => line.includes("Using existing vLLM")));
    assert.ok(payload.lines.some((line: string) => line.includes("tool-call-parser requires")));
  });

  it("forces openai-completions for NIM-local even when probe detects openai-responses", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-nim-override-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "nim-override-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const nimPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "nim.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Fake curl: /v1/responses returns 200 (probe detects openai-responses)
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body=''
status="200"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) auth="$(cat "$2" 2>/dev/null)"; shift 2 ;; *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/models'; then
  body='{"data":[{"id":"nvidia/nemotron-3-nano"}]}'
elif echo "$url" | grep -q '/v1/responses'; then
  body='{"id":"resp_123","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}'
elif echo "$url" | grep -q '/v1/chat/completions'; then
  body='{"id":"chatcmpl-123","choices":[{"message":{"content":"ok"}}]}'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    // NIM-local is option 7 (build, openai, custom, anthropic, anthropicCompatible, gemini, nim-local)
    // No ollama, no vLLM — only NIM-local shows up as experimental option
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

// Mock nim module before onboard.js requires it
const nimMod = require(${nimPath});
nimMod.listModels = () => [{ name: "nvidia/nemotron-3-nano", image: "fake", minGpuMemoryMB: 8000 }];
nimMod.pullNimImage = () => {};
nimMod.containerName = () => "nemoclaw-nim-test";
nimMod.startNimContainerByName = () => "container-123";
nimMod.waitForNimHealth = () => true;
nimMod.isNgcLoggedIn = () => true;

// Select option 7 (nim-local), then model 1
const answers = ["7", "1"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  // Once onboard.ts is migrated to argv (#1889), these mocks can assert Array.isArray.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    // Pass a GPU object with nimCapable: true
    const result = await setupNim({ type: "nvidia", totalMemoryMB: 16000, nimCapable: true });
    originalLog(JSON.stringify({ result, messages, lines }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_EXPERIMENTAL: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "vllm-local");
    assert.equal(payload.result.model, "nvidia/nemotron-3-nano");
    // Key assertion: NIM uses vLLM internally — same override must apply.
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.ok(payload.lines.some((line: string) => line.includes("tool-call-parser requires")));
  });

  it("offers install-ollama option on Linux when Ollama is not installed", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-install-ollama-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "install-ollama-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));

    // Fake curl binary that returns a successful response — needed because
    // runCurlProbe and validateOllamaModel spawn real curl via child_process.
    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    // Simulate: no Ollama installed, no Ollama running, no vLLM on native
    // Linux, so cloud + install-ollama should appear.
    const installOptionIndex = "7";
    const expectedInstallLabel = "Install Ollama (Linux)";
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const platform = require(${platformPath});
const wait = require(${waitPath});

// Mock child_process.spawn so startOllamaAuthProxy doesn't try to spawn a real process.
const child_process = require("child_process");
const originalSpawn = child_process.spawn;
child_process.spawn = (...args) => {
  // Return a fake ChildProcess with a pid and unref()
  return { pid: 99999, unref() {}, on() {} };
};

// Mock spawnSync for ollama pull (real ollama is not installed) and ps checks.
const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  const cmdStr = [cmd, ...(args || [])].join(" ");
  if (cmd === "nc" && args?.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  // ollama pull — pretend it succeeds
  if (cmd === "ollama" && args && args[0] === "pull") {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  // ps check for isOllamaProxyProcess — pretend the proxy is running
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  // Everything else (curl for probes) — use real spawnSync so fake curl binary handles it
  return originalSpawnSync(cmd, args, opts);
};

let promptCalls = 0;
const messages = [];
const updates = [];
const runCommands = [];
const events = [];

credentials.prompt = async (message) => {
  promptCalls += 1;
  messages.push(message);
  // Select install-ollama on first prompt, default on model prompt.
  if (promptCalls === 1) return "${installOptionIndex}";
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  // Normalize: onboard.ts still sends strings, local-inference.ts sends arrays.
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  // No ollama installed
  if (cmd.includes("command -v ollama")) return "";
  // No ollama running
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  // No vLLM running
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  // After install, ollama list returns a model
  if (cmd.includes("ollama list")) return "qwen3:8b  abc  5 GB  now";
  // isOllamaProxyProcess — ps check for auth proxy
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  // validateOllamaModel probe via local-inference — return a valid JSON response
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
runner.run = (command, opts) => {
  const rendered = typeof command === "string" ? command : command.join(" ");
  runCommands.push(rendered);
  events.push({ type: "command", value: rendered });
};
runner.runShell = (command, opts = {}) => {
  runCommands.push(command);
  events.push({ type: "command", value: command, stdio: opts.stdio || null });
};
registry.updateSandbox = (_name, update) => updates.push(update);

// Force platform to linux for this test
Object.defineProperty(process, 'platform', { value: 'linux' });
platform.isWsl = () => false;
wait.sleepSeconds = () => {};
// installOllamaSystem probes loopback at tries=1 before launching, then
// waits at tries=10 after launch. The fake curl in these tests answers 200
// to any URL, so real waitForHttp would short-circuit the manual launch.
// Differentiate by tries count.
wait.waitForHttp = (_url, tries) => (tries ?? 0) > 1;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    const line = args.join(" ");
    lines.push(line);
    events.push({ type: "log", value: line });
  };
  try {
    const result = await setupNim("install-test", null);
    originalLog(JSON.stringify({ result, promptCalls, messages, updates, lines, runCommands, events }));
  } finally {
    console.log = originalLog;
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
        // See #4114: Vitest spawns child processes without a TTY, which
        // would otherwise route the install through the sudo-free
        // user-local fallback.  This case asserts the system-install path.
        NEMOCLAW_OLLAMA_INSTALL_MODE: "system",
      },
    });

    assert.equal(result.status, 0, `Process failed: ${result.stderr}`);
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    // Should have shown the install-ollama menu option (label varies on WSL).
    assert.ok(
      payload.lines.some((line: string) => line.includes(expectedInstallLabel)),
      `Should show ${expectedInstallLabel} option`,
    );

    // Should have selected ollama-local provider after install
    assert.equal(payload.result.provider, "ollama-local");

    // Should have run the curl installer (not brew)
    const zstdPreflightIndex = payload.runCommands.findIndex((cmd: string) =>
      cmd.includes("apt-get install -y -qq --no-install-recommends zstd"),
    );
    const ollamaInstallerIndex = payload.runCommands.findIndex((cmd: string) =>
      cmd.includes("ollama.com/install.sh"),
    );
    assert.ok(zstdPreflightIndex >= 0, "Should preflight zstd before the Ollama installer");
    assert.ok(
      ollamaInstallerIndex > zstdPreflightIndex,
      "Should install zstd before running the Ollama installer",
    );
    const zstdWarningEventIndex = payload.events.findIndex(
      (event: { type: string; value: string }) =>
        event.type === "log" && event.value.includes("requires zstd for archive extraction"),
    );
    const zstdCommandEventIndex = payload.events.findIndex(
      (event: { type: string; value: string }) =>
        event.type === "command" &&
        event.value.includes("apt-get install -y -qq --no-install-recommends zstd"),
    );
    const installerWarningEventIndex = payload.events.findIndex(
      (event: { type: string; value: string }) =>
        event.type === "log" &&
        event.value.includes("creates a system user, a systemd service, and writes to /usr/local"),
    );
    const installerCommandEventIndex = payload.events.findIndex(
      (event: { type: string; value: string }) =>
        event.type === "command" && event.value.includes("ollama.com/install.sh"),
    );
    const installerProgressEventIndex = payload.events.findIndex(
      (event: { type: string; value: string }) =>
        event.type === "log" && event.value.includes("installer output will stream below"),
    );
    const installerCommandEvent = payload.events.find(
      (event: { type: string; value: string }) =>
        event.type === "command" && event.value.includes("ollama.com/install.sh"),
    );
    assert.ok(
      zstdWarningEventIndex >= 0 && zstdWarningEventIndex < zstdCommandEventIndex,
      "Should explain the zstd sudo install before running apt-get",
    );
    assert.ok(
      installerWarningEventIndex >= 0 && installerWarningEventIndex < installerCommandEventIndex,
      "Should explain the Ollama installer sudo usage before running it",
    );
    assert.ok(
      installerProgressEventIndex >= 0 && installerProgressEventIndex < installerCommandEventIndex,
      "Should warn that the Ollama installer can take a few minutes before running it",
    );
    assert.equal(
      installerCommandEvent?.stdio,
      "inherit",
      "Should stream Ollama installer output live",
    );
    assert.ok(
      payload.runCommands.some((cmd: string) => cmd.includes("ollama.com/install.sh")),
      "Should use curl installer on Linux",
    );
    assert.ok(
      !payload.runCommands.some((cmd: string) => cmd.includes("brew install")),
      "Should NOT use brew on Linux",
    );
    assert.ok(
      payload.runCommands.some((cmd: string) =>
        cmd.includes("OLLAMA_HOST=127.0.0.1:11434 ollama serve"),
      ),
      "Linux install fallback should start Ollama on loopback",
    );
    assert.ok(
      !payload.runCommands.some((cmd: string) => cmd.includes("OLLAMA_HOST=0.0.0.0:11434")),
      "Linux install path must not expose raw Ollama on all interfaces",
    );
  });

  it("fails closed when the Linux systemd loopback override cannot be applied", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-systemd-fail-"));
    const scriptPath = path.join(tmpDir, "systemd-fail-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const wait = require(${waitPath});

const menuLines = [];
const originalLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  menuLines.push(line);
  originalLog(...args);
};

function findInstallOllamaChoice() {
  const option = menuLines.find((line) => /Install Ollama \((WSL )?Linux\)/.test(line));
  const match = option && option.match(/^\s*(\d+)\)/);
  if (!match) {
    throw new Error("Could not find Linux Ollama install option in menu:\\n" + menuLines.join("\\n"));
  }
  return match[1];
}

credentials.prompt = async () => findInstallOllamaChoice();
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "ollama.service enabled";
  return "";
};
runner.runShell = (command) => {
  if (command.includes("ollama.com/install.sh")) return { status: 0 };
  if (command.includes("ollama serve")) console.error("manual-start");
  if (command.includes("install -D -m 0644")) return { status: 1 };
  return { status: 0 };
};

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;
wait.sleepSeconds = () => {};
// installOllamaSystem probes loopback at tries=1 before launching, then
// waits at tries=10 after launch. The fake curl in these tests answers 200
// to any URL, so real waitForHttp would short-circuit the manual launch.
// Differentiate by tries count.
wait.waitForHttp = (_url, tries) => (tries ?? 0) > 1;

const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim("systemd-fail-test", null);
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
        // See #4114: this scenario exercises the systemd override failure
        // path, which only runs under the system install mode.
        NEMOCLAW_OLLAMA_INSTALL_MODE: "system",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Applying an Ollama systemd override/);
    assert.match(
      result.stdout,
      /use sudo to write the drop-in, reload systemd, and restart the service/,
    );
    assert.match(result.stderr, /Failed to apply Ollama systemd loopback override/);
    assert.match(result.stderr, /Refusing to continue/);
    assert.doesNotMatch(result.stderr, /manual-start/);
  });

  it("uses install-ollama for non-interactive NEMOCLAW_PROVIDER=ollama on fresh Linux", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-noninteractive-install-ollama-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "noninteractive-install-ollama-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const platform = require(${platformPath});
const wait = require(${waitPath});
const child_process = require("child_process");

child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });

const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  const command = [cmd, ...(args || [])].join(" ");
  if (cmd === "nc" && args?.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (command.includes("ollama pull")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

let promptCalls = 0;
const updates = [];
const runCommands = [];
const runShellCalls = [];

credentials.prompt = async () => {
  promptCalls += 1;
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("ollama list")) return "qwen3:8b  abc  5 GB  now";
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
runner.run = (command) => {
  runCommands.push(typeof command === "string" ? command : command.join(" "));
};
runner.runShell = (command, opts = {}) => {
  runCommands.push(command);
  runShellCalls.push({ command, stdio: opts.stdio || null });
};
registry.updateSandbox = (_name, update) => updates.push(update);

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;
wait.sleepSeconds = () => {};
// installOllamaSystem probes loopback at tries=1 before launching, then
// waits at tries=10 after launch. The fake curl in these tests answers 200
// to any URL, so real waitForHttp would short-circuit the manual launch.
// Differentiate by tries count.
wait.waitForHttp = (_url, tries) => (tries ?? 0) > 1;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("noninteractive-install-test", null);
    originalLog(JSON.stringify({ result, promptCalls, updates, lines, runCommands, runShellCalls }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_YES: "1",
        // See #4114: assert the historical system-install path explicitly.
        // The non-interactive default without this override now routes to
        // the sudo-free user-local fallback (covered by the test below).
        NEMOCLAW_OLLAMA_INSTALL_MODE: "system",
      },
    });

    assert.equal(result.status, 0, `Process failed: ${result.stderr}`);
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(payload.promptCalls, 0);
    assert.equal(payload.result.provider, "ollama-local");
    const zstdPreflightIndex = payload.runCommands.findIndex((cmd: string) =>
      cmd.includes("apt-get install -y -qq --no-install-recommends zstd"),
    );
    const ollamaInstallerIndex = payload.runCommands.findIndex((cmd: string) =>
      cmd.includes("ollama.com/install.sh"),
    );
    assert.ok(
      zstdPreflightIndex >= 0,
      "Should preflight zstd before the non-interactive Ollama installer",
    );
    assert.ok(
      ollamaInstallerIndex > zstdPreflightIndex,
      "Should install zstd before running the non-interactive Ollama installer",
    );
    assert.ok(
      payload.runCommands.some((cmd: string) => cmd.includes("ollama.com/install.sh")),
      "Should use the Ollama installer when requested non-interactively on a fresh host",
    );
    const ollamaInstallShellCall = payload.runShellCalls.find((call: { command: string }) =>
      call.command.includes("ollama.com/install.sh"),
    );
    assert.equal(
      ollamaInstallShellCall?.stdio,
      "inherit",
      "non-interactive Ollama install should stream installer output live",
    );
    assert.ok(
      payload.runCommands.some((cmd: string) =>
        cmd.includes("OLLAMA_HOST=127.0.0.1:11434 ollama serve"),
      ),
      "non-interactive install fallback should start Ollama on loopback",
    );
    assert.ok(
      !payload.runCommands.some((cmd: string) => cmd.includes("OLLAMA_HOST=0.0.0.0:11434")),
      "non-interactive install path must not expose raw Ollama on all interfaces",
    );
  });

  it("falls back to a user-local Ollama install when non-interactive lacks passwordless sudo (#4114)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-userlocal-install-ollama-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "userlocal-install-ollama-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Fake curl + zstd binaries on PATH. The install module uses curl to
    // probe the release tarball (HEAD) and zstd to decompress; both must
    // exist on PATH for the user-local path to choose the .tar.zst asset.
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);
    fs.writeFileSync(path.join(fakeBin, "zstd"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const platform = require(${platformPath});
const child_process = require("child_process");

child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });

const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  const command = [cmd, ...(args || [])].join(" ");
  if (cmd === "nc" && args?.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (command.includes("ollama pull")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

let promptCalls = 0;
const updates = [];
const runCommands = [];
const runShellCalls = [];

credentials.prompt = async () => {
  promptCalls += 1;
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  // hostCommandExists() shells out as ["sh", "-c", 'command -v "$1"', "--", name],
  // so match on the trailing target rather than a "command -v <name>" substring.
  if (cmd.endsWith(" -- ollama")) return "";
  if (cmd.endsWith(" -- zstd")) return "/usr/bin/zstd";
  if (cmd.endsWith(" -- sudo")) return "/usr/bin/sudo";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("ollama list")) return "qwen3:8b  abc  5 GB  now";
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
const originalRunCaptureEx = runner.runCaptureEx;
runner.runCaptureEx = (command, opts) => {
  // Refuse passwordless sudo so the install path takes the #4114 fallback.
  if (Array.isArray(command) && command[0] === "sudo" && command[1] === "-n") {
    return { stdout: "", exitCode: 1, timedOut: false };
  }
  // Pretend the .tar.zst asset exists so the user-local install picks the
  // zstd path (instead of falling back to .tgz).
  if (Array.isArray(command) && command.includes("--head")) {
    return { stdout: "", exitCode: 0, timedOut: false };
  }
  // Hand every other capture (curl probes, etc.) back to the real implementation
  // so the fake-curl shim on PATH can answer the local-model probe.
  return originalRunCaptureEx(command, opts);
};
runner.run = (command) => {
  runCommands.push(typeof command === "string" ? command : command.join(" "));
};
runner.runShell = (command, opts = {}) => {
  runCommands.push(command);
  runShellCalls.push({ command, stdio: opts.stdio || null });
};
registry.updateSandbox = (_name, update) => updates.push(update);

Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(process, "getuid", { value: () => 1000 });
platform.isWsl = () => false;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("userlocal-install-test", null);
    originalLog(JSON.stringify({ result, promptCalls, updates, lines, runCommands, runShellCalls }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_YES: "1",
        // No NEMOCLAW_OLLAMA_INSTALL_MODE — auto-detect routes through
        // user-local because the stubbed `sudo -n true` returns exit 1.
      },
    });

    assert.equal(result.status, 0, `Process failed: ${result.stderr}`);
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(payload.result.provider, "ollama-local");
    assert.ok(
      !payload.runCommands.some((cmd: string) => cmd.includes("ollama.com/install.sh")),
      "User-local install must NOT run the official curl|sh installer",
    );
    assert.ok(
      payload.runCommands.some(
        (cmd: string) => cmd.includes("ollama-linux-") && cmd.includes(".tar.zst"),
      ),
      "User-local install should download the release tarball directly",
    );
    assert.ok(
      payload.runCommands.some((cmd: string) => cmd.includes("zstd -d") && cmd.includes("/.local")),
      "User-local install should extract under ${HOME}/.local without sudo",
    );
    assert.ok(
      !payload.runCommands.some((cmd: string) => cmd.includes("sudo")),
      "User-local install must not invoke sudo on any extraction or start command",
    );
    assert.ok(
      payload.runCommands.some(
        (cmd: string) => cmd.includes("nohup") && cmd.includes("/.local/bin/ollama"),
      ),
      "User-local install should launch the daemon from ${HOME}/.local/bin/ollama",
    );
    assert.ok(
      !payload.runCommands.some((cmd: string) => cmd.includes("OLLAMA_HOST=0.0.0.0:11434")),
      "User-local install path must not expose raw Ollama on all interfaces",
    );
  });

  it("upgrades an outdated host Ollama instead of reusing it under NEMOCLAW_PROVIDER=install-ollama", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-upgrade-old-ollama-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "upgrade-old-ollama-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);
    // Fake passwordless sudo so the upgrade gate doesn't short-circuit
    // before the official installer runs in this non-interactive scenario.
    fs.writeFileSync(path.join(fakeBin, "sudo"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const platform = require(${platformPath});
const wait = require(${waitPath});
const child_process = require("child_process");

child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });

const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  const command = [cmd, ...(args || [])].join(" ");
  if (cmd === "nc" && args?.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (command.includes("ollama pull")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

let promptCalls = 0;
let installerRan = false;
const updates = [];
const runCommands = [];

credentials.prompt = async () => {
  promptCalls += 1;
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  // hostCommandExists shells out as ["sh","-c",'command -v "$1"',"--",name].
  // Match the trailing argv form rather than the original "command -v ollama" string.
  if (cmd.startsWith("sh -c command -v") && cmd.endsWith(" ollama")) {
    return "/usr/local/bin/ollama";
  }
  // canRunSudoNonInteractive looks up sudo the same way; report it as
  // available so the upgrade gate doesn't short-circuit before the
  // installer runs.
  if (cmd.startsWith("sh -c command -v") && cmd.endsWith(" sudo")) {
    return "/usr/bin/sudo";
  }
  // Pre-upgrade host reports 0.6.2; once install.sh runs we flip both the
  // CLI and the /api/version daemon probe to a fresh version.
  if (cmd.includes("ollama --version")) {
    return installerRan ? "ollama version is 0.24.0" : "ollama version is 0.6.2";
  }
  if (cmd.includes("/api/version")) {
    return installerRan ? '{"version":"0.24.0"}' : '{"version":"0.6.2"}';
  }
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("ollama list")) return "qwen3:8b  abc  5 GB  now";
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
runner.run = (command) => {
  const rendered = typeof command === "string" ? command : command.join(" ");
  if (rendered.includes("ollama.com/install.sh")) installerRan = true;
  runCommands.push(rendered);
};
runner.runShell = (command) => {
  if (command.includes("ollama.com/install.sh")) installerRan = true;
  runCommands.push(command);
};
registry.updateSandbox = (_name, update) => updates.push(update);

Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;
wait.sleepSeconds = () => {};
// installOllamaSystem probes loopback at tries=1 before launching, then
// waits at tries=10 after launch. The fake curl in these tests answers 200
// to any URL, so real waitForHttp would short-circuit the manual launch.
// Differentiate by tries count.
wait.waitForHttp = (_url, tries) => (tries ?? 0) > 1;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("upgrade-old-ollama-test", null);
    originalLog(JSON.stringify({ result, promptCalls, updates, lines, runCommands }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "install-ollama",
        NEMOCLAW_YES: "1",
        NEMOCLAW_OLLAMA_INSTALL_MODE: "system",
      },
    });

    assert.equal(result.status, 0, `Process failed: ${result.stderr}`);
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(payload.promptCalls, 0);
    assert.equal(payload.result.provider, "ollama-local");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("[non-interactive] Provider: install-ollama"),
      ),
      "install-ollama should be resolved directly, not collapsed to plain ollama via the fallback",
    );
    assert.ok(
      payload.runCommands.some((cmd: string) => cmd.includes("ollama.com/install.sh")),
      "install-ollama with outdated host Ollama should run the official installer for the upgrade",
    );
  });

  it("restarts Windows-host Ollama after install when installer auto-start is not reachable", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-windows-ollama-install-restart-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "windows-ollama-install-restart-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const topologyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
    );
    const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));
    const windowsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const platform = require(${platformPath});
const topology = require(${topologyPath});
platform.isWsl = () => true;
topology.getContainerRuntime = () => "docker-desktop";

const installedPath = "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe";
const installCalls = [];
const awaitCalls = [];
const restartCalls = [];
const updates = [];
const runCommands = [];
credentials.prompt = async () => "";
credentials.ensureApiKey = async () => {};
registry.updateSandbox = (_name, update) => updates.push(update);
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe")) return "";
  if (cmd.includes("api/tags")) {
    if (restartCalls.length > 0) {
      return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
    }
    return "";
  }
  if (cmd.includes("api/show")) return JSON.stringify({ capabilities: ["completion", "tools"] });
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
runner.run = (command) => {
  runCommands.push(Array.isArray(command) ? command.join(" ") : String(command));
  return { status: 0 };
};
runner.runShell = (command) => {
  runCommands.push(command);
  return { status: 0 };
};

const local = require(${localPath});
local.resetOllamaHostCache();
local.getOllamaModelOptions = () => ["qwen3:8b"];

const windows = require(${windowsPath});
windows.installOllamaOnWindowsHost = async () => {
  installCalls.push(true);
  return { ok: true, path: installedPath };
};
windows.awaitWindowsOllamaReady = () => {
  awaitCalls.push(true);
  return false;
};
windows.setupWindowsOllamaWith0000Binding = (opts) => {
  restartCalls.push(opts || {});
  local.setResolvedOllamaHost(local.OLLAMA_HOST_DOCKER_INTERNAL);
  return true;
};
windows.switchToWindowsOllamaHost = () => {
  local.setResolvedOllamaHost(local.OLLAMA_HOST_DOCKER_INTERNAL);
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("windows-install-restart-test", null);
    originalLog(JSON.stringify({
      result,
      installCalls,
      awaitCalls,
      restartCalls,
      updates,
      lines,
      runCommands,
    }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "install-windows-ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
        NEMOCLAW_YES: "1",
      },
    });

    assert.equal(result.status, 0, `Process failed: ${result.stderr}`);
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, "qwen3:8b");
    assert.equal(payload.installCalls.length, 1);
    assert.equal(payload.awaitCalls.length, 1);
    assert.deepEqual(payload.restartCalls, [
      {
        installedPath:
          "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe",
      },
    ]);
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Using Ollama on host.docker.internal:11434"),
      ),
    );
  });

  it("shows Windows-host Ollama in the menu with a Docker Desktop requirement on native Docker WSL", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-windows-ollama-native-docker-menu-"),
    );
    const scriptPath = path.join(tmpDir, "windows-ollama-native-docker-menu-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const topologyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const topology = require(${topologyPath});

platform.isWsl = () => true;
topology.getContainerRuntime = () => "docker";
credentials.ensureApiKey = async () => {};
const messages = [];
credentials.prompt = async (message) => {
  messages.push(message);
  if (/Choose \[/.test(message)) throw new Error("STOP_AFTER_MENU");
  return "";
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("host.docker.internal:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("docker images")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe"))
    return "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    try {
      await setupNim(null, null);
    } catch (error) {
      if (!String(error && error.message).includes("STOP_AFTER_MENU")) throw error;
    }
    originalLog(JSON.stringify({ lines, messages }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "",
        NEMOCLAW_PROVIDER: "",
        NEMOCLAW_MODEL: "",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    const menuOutput = payload.lines.join("\n");

    assert.match(
      menuOutput,
      /Start Ollama on Windows host \(requires Docker Desktop WSL integration\)/,
    );
    assert.doesNotMatch(menuOutput, /Start Ollama on Windows host \(suggested\)/);
  });

  it("rejects Windows-host Ollama providers on native Docker WSL before launching Ollama", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const scenarios = [
      { provider: "start-windows-ollama", hasWindowsOllama: true },
      { provider: "install-windows-ollama", hasWindowsOllama: false },
    ];

    for (const scenario of scenarios) {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-onboard-${scenario.provider}-native-docker-`),
      );
      const scriptPath = path.join(tmpDir, `${scenario.provider}-native-docker-check.js`);
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
      const topologyPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
      );
      const windowsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
      );

      const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const topology = require(${topologyPath});
const windows = require(${windowsPath});
const hasWindowsOllama = ${JSON.stringify(scenario.hasWindowsOllama)};

platform.isWsl = () => true;
topology.getContainerRuntime = () => "docker";
credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive test");
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("host.docker.internal:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("docker images")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe")) {
    return hasWindowsOllama
      ? "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe"
      : "";
  }
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama")) return "";
  return "";
};
runner.run = () => ({ status: 0 });
runner.runShell = () => ({ status: 0 });
windows.installOllamaOnWindowsHost = async () => {
  console.error("WINDOWS_INSTALL_CALLED");
  return {
    ok: true,
    path: "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe",
  };
};
windows.setupWindowsOllamaWith0000Binding = () => {
  console.error("WINDOWS_SETUP_CALLED");
  return true;
};
windows.switchToWindowsOllamaHost = () => {
  console.error("WINDOWS_SWITCH_CALLED");
};

const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim(null, null);
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
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_PROVIDER: scenario.provider,
          NEMOCLAW_MODEL: "qwen3:8b",
          NEMOCLAW_YES: "1",
        },
      });

      assert.equal(result.status, 1, `${scenario.provider} unexpectedly passed`);
      assert.match(result.stderr, /\[non-interactive\] Aborting:/);
      assert.match(result.stderr, new RegExp(`${scenario.provider} requires Docker Desktop`));
      assert.match(result.stderr, /Choose WSL-local Ollama/);
      assert.doesNotMatch(
        result.stderr,
        /WINDOWS_INSTALL_CALLED|WINDOWS_SETUP_CALLED|WINDOWS_SWITCH_CALLED/,
      );
    }
  });

  it("rejects reachable Windows-host Ollama on native Docker WSL through generic and fallback paths", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const scenarios = ["ollama", "start-windows-ollama", "install-windows-ollama"];

    for (const provider of scenarios) {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-onboard-${provider}-reachable-native-docker-`),
      );
      const scriptPath = path.join(tmpDir, `${provider}-reachable-native-docker-check.js`);
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
      const topologyPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
      );
      const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));
      const windowsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
      );

      const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const topology = require(${topologyPath});
const local = require(${localPath});
const windows = require(${windowsPath});

platform.isWsl = () => true;
topology.getContainerRuntime = () => "docker";
credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive test");
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("docker images")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe"))
    return "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama")) return "";
  if (cmd.includes("api/tags")) return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  return "";
};
runner.run = () => ({ status: 0 });
runner.runShell = () => ({ status: 0 });
local.resetOllamaHostCache();
local.setResolvedOllamaHost(local.OLLAMA_HOST_DOCKER_INTERNAL);
local.getOllamaModelOptions = () => {
  console.error("MODEL_SELECTION_REACHED");
  return ["qwen3:8b"];
};
windows.installOllamaOnWindowsHost = async () => {
  console.error("WINDOWS_INSTALL_CALLED");
  return {
    ok: true,
    path: "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe",
  };
};
windows.setupWindowsOllamaWith0000Binding = () => {
  console.error("WINDOWS_SETUP_CALLED");
  return true;
};
windows.switchToWindowsOllamaHost = () => {
  console.error("WINDOWS_SWITCH_CALLED");
};

const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim(null, null);
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
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_PROVIDER: provider,
          NEMOCLAW_MODEL: "qwen3:8b",
          NEMOCLAW_YES: "1",
        },
      });

      assert.equal(result.status, 1, `${provider} unexpectedly passed`);
      assert.match(result.stderr, /\[non-interactive\] Aborting:/);
      assert.match(result.stderr, new RegExp(`${provider} requires Docker Desktop`));
      assert.match(result.stderr, /Choose WSL-local Ollama/);
      assert.doesNotMatch(
        result.stderr,
        /MODEL_SELECTION_REACHED|WINDOWS_INSTALL_CALLED|WINDOWS_SETUP_CALLED|WINDOWS_SWITCH_CALLED/,
      );
    }
  });

  it("uses the Windows-host start path when install-windows-ollama is requested but Ollama is already installed", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-windows-ollama-install-to-start-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "windows-ollama-install-to-start-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const topologyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
    );
    const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));
    const windowsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const topology = require(${topologyPath});
platform.isWsl = () => true;
topology.getContainerRuntime = () => "docker-desktop";

const installedPath = "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe";
const installCalls = [];
const setupCalls = [];
const runCommands = [];
credentials.prompt = async () => "";
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe")) return installedPath;
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama")) return "";
  if (cmd.includes("api/tags")) {
    if (setupCalls.length > 0) {
      return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
    }
    return "";
  }
  if (cmd.includes("api/show")) return JSON.stringify({ capabilities: ["completion", "tools"] });
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
runner.run = (command) => {
  runCommands.push(Array.isArray(command) ? command.join(" ") : String(command));
  return { status: 0 };
};
runner.runShell = (command) => {
  runCommands.push(command);
  return { status: 0 };
};

const local = require(${localPath});
local.resetOllamaHostCache();
local.getOllamaModelOptions = () => ["qwen3:8b"];

const windows = require(${windowsPath});
windows.installOllamaOnWindowsHost = async () => {
  installCalls.push(true);
  return { ok: false, path: "" };
};
windows.setupWindowsOllamaWith0000Binding = (opts) => {
  setupCalls.push(opts || {});
  local.setResolvedOllamaHost(local.OLLAMA_HOST_DOCKER_INTERNAL);
  return true;
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("windows-install-to-start-test", null);
    originalLog(JSON.stringify({ result, installCalls, setupCalls, lines, runCommands }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "install-windows-ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
        NEMOCLAW_YES: "1",
      },
    });

    assert.equal(result.status, 0, `Process failed: ${result.stderr}`);
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, "qwen3:8b");
    assert.equal(payload.installCalls.length, 0);
    // The restart/start path now forwards the verified executable path
    // recovered from Get-Command so windows.ts can launch the binary
    // directly instead of relying on the calling shell's Windows PATH
    // (#3949).
    assert.deepEqual(payload.setupCalls, [
      {
        announceStop: false,
        // The mock injects `\\\\` per separator (raw template → 4 source
        // backslashes per separator → 2 backslashes in the subprocess
        // JS string). The deepEqual right-hand side is a regular TS
        // string, so 4 backslashes per separator here equals 2 in the
        // compiled string, matching what the subprocess captured.
        installedPath:
          "C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\Ollama\\\\ollama.exe",
      },
    ]);
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Using Ollama on host.docker.internal:11434"),
      ),
    );
  });

  it("detects Windows-host Ollama via running process when not on the user PATH (#3949)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-windows-ollama-process-fallback-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "windows-ollama-process-fallback-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const topologyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
    );
    const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));
    const windowsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const topology = require(${topologyPath});
platform.isWsl = () => true;
topology.getContainerRuntime = () => "docker-desktop";

const setupCalls = [];
const installedPath = "C:/Program Files/Ollama/ollama.exe";
credentials.prompt = async () => "";
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  // The fix: Get-Command misses ollama.exe (service install, not on user
  // PATH), but Get-Process recovers both the live PID and the verified
  // executable path. Repro for #3949.
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama") && cmd.includes("Path"))
    return installedPath;
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama") && cmd.includes("Id"))
    return "7652";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-NetTCPConnection")) return "127.0.0.1";
  if (cmd.includes("api/tags")) {
    if (setupCalls.length === 0) return "";
    return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  }
  if (cmd.includes("api/show")) return JSON.stringify({ capabilities: ["completion", "tools"] });
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
runner.run = () => ({ status: 0 });
runner.runShell = () => ({ status: 0 });

const local = require(${localPath});
local.resetOllamaHostCache();
local.getOllamaModelOptions = () => ["qwen3:8b"];

const windows = require(${windowsPath});
windows.installOllamaOnWindowsHost = async () => {
  throw new Error("installOllamaOnWindowsHost called: hasWindowsOllama not detected");
};
windows.setupWindowsOllamaWith0000Binding = (opts) => {
  setupCalls.push(opts || {});
  local.setResolvedOllamaHost(local.OLLAMA_HOST_DOCKER_INTERNAL);
  return true;
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("windows-process-fallback-test", null);
    originalLog(JSON.stringify({ result, setupCalls, lines }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "start-windows-ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
        NEMOCLAW_YES: "1",
      },
    });

    assert.equal(
      result.status,
      0,
      `Process failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(payload.result.provider, "ollama-local");
    // hasWindowsOllama detected via Get-Process → winOllamaLoopbackOnly
    // observed from 127.0.0.1 listen → restart path taken with
    // announceStop:true and the recovered executable path threaded
    // through so windows.ts can target the verified binary instead of
    // the broken PATH fallback. Pre-fix behaviour was the bogus install
    // path with no setup call at all.
    assert.deepEqual(payload.setupCalls, [
      {
        announceStop: true,
        installedPath: "C:/Program Files/Ollama/ollama.exe",
      },
    ]);
  });

  it("uses a known Windows install path when a running Ollama process has no readable path", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-windows-ollama-static-path-fallback-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "windows-ollama-static-path-fallback-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const topologyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
    );
    const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));
    const windowsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin, OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE);

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const topology = require(${topologyPath});
platform.isWsl = () => true;
topology.getContainerRuntime = () => "docker-desktop";

const setupCalls = [];
const installedPath = "C:/Users/tester/AppData/Local/Programs/Ollama/ollama.exe";
credentials.prompt = async () => "";
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama") && cmd.includes("Path"))
    return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama") && cmd.includes("Id"))
    return "7652";
  if (cmd.includes("powershell.exe") && cmd.includes("Test-Path -LiteralPath"))
    return installedPath;
  if (cmd.includes("powershell.exe") && cmd.includes("Get-NetTCPConnection")) return "127.0.0.1";
  if (cmd.includes("api/tags")) {
    if (setupCalls.length === 0) return "";
    return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  }
  if (cmd.includes("api/show")) return JSON.stringify({ capabilities: ["completion", "tools"] });
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  return "";
};
runner.run = () => ({ status: 0 });
runner.runShell = () => ({ status: 0 });

const local = require(${localPath});
local.resetOllamaHostCache();
local.getOllamaModelOptions = () => ["qwen3:8b"];

const windows = require(${windowsPath});
windows.installOllamaOnWindowsHost = async () => {
  throw new Error("installOllamaOnWindowsHost called: hasWindowsOllama not detected");
};
windows.setupWindowsOllamaWith0000Binding = (opts) => {
  setupCalls.push(opts || {});
  local.setResolvedOllamaHost(local.OLLAMA_HOST_DOCKER_INTERNAL);
  return true;
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("windows-static-path-fallback-test", null);
    originalLog(JSON.stringify({ result, setupCalls, lines }));
  } finally {
    console.log = originalLog;
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "start-windows-ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
        NEMOCLAW_YES: "1",
      },
    });

    assert.equal(
      result.status,
      0,
      `Process failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    assert.equal(payload.result.provider, "ollama-local");
    assert.deepEqual(payload.setupCalls, [
      {
        announceStop: true,
        installedPath: "C:/Users/tester/AppData/Local/Programs/Ollama/ollama.exe",
      },
    ]);
  });

  it("does not satisfy start-windows-ollama with WSL-local Ollama", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-windows-ollama-no-wsl-fallback-"),
    );
    const scriptPath = path.join(tmpDir, "windows-ollama-no-wsl-fallback-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const topologyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
    );
    const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));
    const windowsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const topology = require(${topologyPath});
platform.isWsl = () => true;
topology.getContainerRuntime = () => "docker-desktop";

credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive test");
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  if (cmd.includes("host.docker.internal:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe")) return "";
  return "";
};

const local = require(${localPath});
local.resetOllamaHostCache();

const windows = require(${windowsPath});
windows.setupWindowsOllamaWith0000Binding = () => {
  console.error("WINDOWS_SETUP_CALLED");
  return false;
};
windows.switchToWindowsOllamaHost = () => {
  console.error("WINDOWS_SWITCH_CALLED");
};

const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim("windows-no-wsl-fallback-test", null);
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "start-windows-ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
        NEMOCLAW_YES: "1",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Requested provider 'start-windows-ollama' is not available/);
    assert.doesNotMatch(result.stderr, /WINDOWS_SETUP_CALLED|WINDOWS_SWITCH_CALLED/);
  });

  it("does not satisfy install-windows-ollama with non-WSL local Ollama", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-windows-ollama-no-linux-fallback-"),
    );
    const scriptPath = path.join(tmpDir, "windows-ollama-no-linux-fallback-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
    const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));
    const windowsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
platform.isWsl = () => false;

credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive test");
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  return "";
};

const local = require(${localPath});
local.resetOllamaHostCache();

const windows = require(${windowsPath});
windows.installOllamaOnWindowsHost = async () => {
  console.error("WINDOWS_INSTALL_CALLED");
  return { ok: false, path: "" };
};
windows.setupWindowsOllamaWith0000Binding = () => {
  console.error("WINDOWS_SETUP_CALLED");
  return false;
};

const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim("windows-no-linux-fallback-test", null);
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "install-windows-ollama",
        NEMOCLAW_MODEL: "qwen3:8b",
        NEMOCLAW_YES: "1",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Requested provider 'install-windows-ollama' is not available/);
    assert.doesNotMatch(result.stderr, /WINDOWS_INSTALL_CALLED|WINDOWS_SETUP_CALLED/);
  });

  it("honours NEMOCLAW_LOCAL_INFERENCE_TIMEOUT for compatible-endpoint during inference setup (#2403)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-compatible-endpoint-timeout-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const stateFile = path.join(tmpDir, "state.json");
    const scriptPath = path.join(tmpDir, "compatible-timeout-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ inferenceSetArgs: null }));

    // Fake openshell: records inference set args, stubs provider/gateway ops
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
if (args[0] === "inference" && args[1] === "set") {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.inferenceSetArgs = args.slice(2);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.exit(0);
}
// provider get: exit 1 so upsertProvider uses "create"
if (args[0] === "provider" && args[1] === "get") { process.exit(1); }
process.exit(0);
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const runner = require(${runnerPath});
// Mock runCapture before onboard.js is required so the destructured reference picks up the mock.
// Handles verifyInferenceRoute's "openshell inference get" call.
runner.runCapture = (cmd) => {
  const args = Array.isArray(cmd) ? cmd : [];
  if (args[1] === "inference" && args[2] === "get") {
    return "Gateway inference:\n  Provider: compatible-endpoint\n  Model: qwen3.6:35b\n";
  }
  return "";
};
process.env.COMPATIBLE_API_KEY = "test-key";
const { setupInference } = require(${onboardPath});
(async () => {
  await setupInference(null, "qwen3.6:35b", "compatible-endpoint", "http://lan-server:11434/v1", "COMPATIBLE_API_KEY");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_LOCAL_INFERENCE_TIMEOUT: "600",
        COMPATIBLE_API_KEY: "test-key",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    assert.ok(state.inferenceSetArgs !== null, "openshell inference set was not called");
    assert.ok(
      state.inferenceSetArgs.includes("--timeout"),
      `Expected --timeout in inference set args, got: ${JSON.stringify(state.inferenceSetArgs)}`,
    );
    assert.ok(
      state.inferenceSetArgs.includes("600"),
      `Expected 600 in inference set args, got: ${JSON.stringify(state.inferenceSetArgs)}`,
    );
  });
});
