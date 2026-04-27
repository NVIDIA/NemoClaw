// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CREDENTIAL_RETRY_PROMPT =
  "  Options: retry (re-enter key), back (change provider), exit [retry]: ";
const CREDENTIAL_RETRY_PROMPT_RE =
  /Options: retry \(re-enter key\), back \(change provider\), exit \[retry\]: /;

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
    *) url="$1"; shift ;;
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
    *) url="$1"; shift ;;
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

describe("onboard provider selection UX", () => {
  it("prompts explicitly instead of silently auto-selecting detected Ollama", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-selection-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "selection-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
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
    assert.match(payload.messages[1], /Choose model \[1\]/);
    assert.ok(
      payload.lines.some((line: string) => line.includes("Detected local inference option")),
    );
    assert.ok(payload.lines.some((line: string) => line.includes("Cloud models:")));
    assert.ok(
      payload.lines.some((line: string) => line.includes("Chat Completions API available")),
    );
  });

  it("does not label NVIDIA Endpoints as recommended in the provider list", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-no-recommended-label-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "no-recommended-label-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
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

  it("accepts a manually entered NVIDIA Endpoints model after validating it against /models", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-build-model-selection-"),
    );
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-model-selection-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/models$'; then
  body='{"data":[{"id":"moonshotai/kimi-k2.5"},{"id":"custom/provider-model"}]}'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["1", "7", "custom/provider-model"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_API_KEY = "nvapi-test"; };
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
    assert.match(payload.messages[1], /Choose model \[1\]/);
    assert.match(payload.messages[2], /NVIDIA Endpoints model id:/);
    assert.ok(payload.lines.some((line: string) => line.includes("Other...")));
  });

  it("reprompts for a manual NVIDIA Endpoints model when /models validation rejects it", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-build-model-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-model-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/v1/models$'; then
  body='{"data":[{"id":"moonshotai/kimi-k2.5"},{"id":"z-ai/glm-5.1"}]}'
fi
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["1", "7", "bad/model", "z-ai/glm-5.1"];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_API_KEY = "nvapi-test"; };
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
    assert.equal(payload.result.model, "z-ai/glm-5.1");
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"resp_123"}'
status="200"
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) url="$1"; shift ;;
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
    originalLog(JSON.stringify({ result, messages, lines, commands }));
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
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
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
  });

  it("returns to provider selection when Ollama manual entry chooses back", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"resp_123"}'
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

const answers = ["7", "2", "back", "1", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_API_KEY = "nvapi-good"; };
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const pullLog = path.join(tmpDir, "pulls.log");

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"resp_123"}'
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
    assert.equal(payload.result.model, "qwen2.5:7b");
    assert.ok(payload.lines.some((line: string) => line.includes("Ollama starter models:")));
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("No local Ollama models are installed yet"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("Pulling Ollama model: qwen2.5:7b")),
    );
    assert.equal(fs.readFileSync(pullLog, "utf8").trim(), "qwen2.5:7b");
  });

  it("reprompts inside the Ollama model flow when a pull fails", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const pullLog = path.join(tmpDir, "pulls.log");

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"resp_123"}'
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
    fs.writeFileSync(
      path.join(fakeBin, "ollama"),
      `#!/usr/bin/env bash
if [ "$1" = "pull" ]; then
  echo "$2" >> ${JSON.stringify(pullLog)}
  if [ "$2" = "qwen2.5:7b" ]; then
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

const answers = ["7", "1", "2", "llama3.2:3b"];
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
        line.includes("Failed to pull Ollama model 'qwen2.5:7b'"),
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
    assert.equal(fs.readFileSync(pullLog, "utf8").trim(), "qwen2.5:7b\nllama3.2:3b");
  });

  it("reprompts for an OpenAI Other model when /models validation rejects it", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-model-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "openai-model-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"resp_123"}'
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

const answers = ["3", "https://proxy.example.com/v1", "back", "1", ""];
const messages = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => { process.env.NVIDIA_API_KEY = "nvapi-good"; };
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

  it("lets users type back after a transport validation failure to return to provider selection", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-transport-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "transport-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
outfile=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) url="$1"; shift ;;
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
credentials.ensureApiKey = async () => { process.env.NVIDIA_API_KEY = "nvapi-good"; };
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
credentials.ensureApiKey = async () => { process.env.NVIDIA_API_KEY = "nvapi-good"; };
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

  it("fails early in non-interactive mode when NVIDIA_API_KEY is not an nvapi- key", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-build-noninteractive-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-noninteractive-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });

    const script = String.raw`
const fs = require("fs");
const path = require("path");
const Module = require("module");
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

const onboardFile = ${onboardPath};
const source = fs.readFileSync(onboardFile, "utf-8");
const injected = source + "\nmodule.exports.__setNonInteractive = (value) => { NON_INTERACTIVE = value; };";
const onboardModule = new Module(onboardFile, module);
onboardModule.filename = onboardFile;
onboardModule.paths = Module._nodeModulePaths(path.dirname(onboardFile));
onboardModule._compile(injected, onboardFile);

const { setupNim, __setNonInteractive } = onboardModule.exports;

(async () => {
  process.env.NVIDIA_API_KEY = "sk-test";
  __setNonInteractive(true);
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

  it("lets users re-enter an NVIDIA API key after authorization failure without restarting selection", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-build-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "build-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
  process.env.NVIDIA_API_KEY = "nvapi-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, prompts, lines, key: process.env.NVIDIA_API_KEY }));
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
      payload.messages.filter((message: string) => /Choose model \[1\]/.test(message)).length,
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
  process.env.NVIDIA_API_KEY = "nvapi-bad";
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines, key: process.env.NVIDIA_API_KEY }));
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
      payload.messages.filter((message: string) => /Choose model \[1\]/.test(message)).length,
      1,
    );
  });

  it("lets users re-enter an OpenAI API key after authorization failure", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "openai-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const nimPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "nim.js"));

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
    *) url="$1"; shift ;;
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "registry.js"));

    // Fake curl binary that returns a successful response — needed because
    // runCurlProbe and validateOllamaModel spawn real curl via child_process.
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
status="200"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$outfile" ]; then
  printf '%s' "$body" > "$outfile"
  printf '%s' "$status"
else
  printf '%s' "$body"
fi
`,
      { mode: 0o755 },
    );

    // Simulate: no Ollama installed, no Ollama running, no vLLM — only cloud + install-ollama should appear.
    // User picks install-ollama (option 7). The install command is mocked to succeed.
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});

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

credentials.prompt = async (message) => {
  promptCalls += 1;
  messages.push(message);
  // Select option 7 (install-ollama) on first prompt, default on model prompt
  if (promptCalls === 1) return "7";
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
  runCommands.push(typeof command === "string" ? command : command.join(" "));
};
registry.updateSandbox = (_name, update) => updates.push(update);

// Force platform to linux for this test
Object.defineProperty(process, 'platform', { value: 'linux' });

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("install-test", null);
    originalLog(JSON.stringify({ result, promptCalls, messages, updates, lines, runCommands }));
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

    assert.equal(result.status, 0, `Process failed: ${result.stderr}`);
    assert.notEqual(result.stdout.trim(), "", result.stderr);
    const payload = JSON.parse(result.stdout.trim());

    // Should have shown the "Install Ollama (Linux)" option
    assert.ok(
      payload.lines.some((line: string) => line.includes("Install Ollama (Linux)")),
      "Should show Install Ollama option on Linux",
    );

    // Should have selected ollama-local provider after install
    assert.equal(payload.result.provider, "ollama-local");

    // Should have run the curl installer (not brew)
    assert.ok(
      payload.runCommands.some((cmd: string) => cmd.includes("ollama.com/install.sh")),
      "Should use curl installer on Linux",
    );
    assert.ok(
      !payload.runCommands.some((cmd: string) => cmd.includes("brew install")),
      "Should NOT use brew on Linux",
    );
  });
});
