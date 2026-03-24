// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 7 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ROOT, SCRIPTS, run, runCapture, shellQuote } = require("./runner");
const {
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  validateOllamaModel,
  validateLocalProvider,
} = require("./local-inference");
const {
  CLOUD_MODEL_OPTIONS,
  DEFAULT_CLOUD_MODEL,
  getProviderSelectionConfig,
} = require("./inference-config");
const {
  inferContainerRuntime,
  isUnsupportedMacosRuntime,
  shouldPatchCoredns,
} = require("./platform");
const { resolveOpenshell } = require("./resolve-openshell");
const { prompt, ensureApiKey, getCredential, saveCredential } = require("./credentials");
const registry = require("./registry");
const nim = require("./nim");
const policies = require("./policies");
const { checkPortAvailable } = require("./preflight");
const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const USE_COLOR = !process.env.NO_COLOR && !!process.stdout.isTTY;
const DIM = USE_COLOR ? "\x1b[2m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";
let OPENSHELL_BIN = null;
const GATEWAY_NAME = "nemoclaw";

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const OPENAI_ENDPOINT_URL = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT_URL = "https://api.anthropic.com";
const GEMINI_ENDPOINT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

const REMOTE_PROVIDER_CONFIG = {
  build: {
    label: "NVIDIA Endpoints",
    providerName: "nvidia-prod",
    providerType: "nvidia",
    credentialEnv: "NVIDIA_API_KEY",
    endpointUrl: BUILD_ENDPOINT_URL,
    helpUrl: "https://build.nvidia.com/settings/api-keys",
    modelMode: "catalog",
    defaultModel: DEFAULT_CLOUD_MODEL,
  },
  openai: {
    label: "OpenAI",
    providerName: "openai-api",
    providerType: "openai",
    credentialEnv: "OPENAI_API_KEY",
    endpointUrl: OPENAI_ENDPOINT_URL,
    helpUrl: "https://platform.openai.com/api-keys",
    modelMode: "curated",
    defaultModel: "gpt-5.4",
    skipVerify: true,
  },
  anthropic: {
    label: "Anthropic",
    providerName: "anthropic-prod",
    providerType: "anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    endpointUrl: ANTHROPIC_ENDPOINT_URL,
    helpUrl: "https://console.anthropic.com/settings/keys",
    modelMode: "curated",
    defaultModel: "claude-sonnet-4-6",
  },
  anthropicCompatible: {
    label: "Other Anthropic-compatible endpoint",
    providerName: "compatible-anthropic-endpoint",
    providerType: "anthropic",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
  },
  gemini: {
    label: "Google Gemini",
    providerName: "gemini-api",
    providerType: "openai",
    credentialEnv: "GEMINI_API_KEY",
    endpointUrl: GEMINI_ENDPOINT_URL,
    helpUrl: "https://aistudio.google.com/app/apikey",
    modelMode: "curated",
    defaultModel: "gemini-2.5-flash",
    skipVerify: true,
  },
  custom: {
    label: "Other OpenAI-compatible endpoint",
    providerName: "compatible-endpoint",
    providerType: "openai",
    credentialEnv: "COMPATIBLE_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
    skipVerify: true,
  },
};

const REMOTE_MODEL_OPTIONS = {
  openai: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4-pro-2026-03-05",
  ],
  anthropic: [
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-6",
  ],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
};

// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;

function isNonInteractive() {
  return NON_INTERACTIVE;
}

function note(message) {
  console.log(`${DIM}${message}${RESET}`);
}

// Prompt wrapper: returns env var value or default in non-interactive mode,
// otherwise prompts the user interactively.
async function promptOrDefault(question, envVar, defaultValue) {
  if (isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    const result = val || defaultValue;
    note(`  [non-interactive] ${question.trim()} → ${result}`);
    return result;
  }
  return prompt(question);
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Check if a sandbox is in Ready state from `openshell sandbox list` output.
 * Strips ANSI codes and exact-matches the sandbox name in the first column.
 */
function isSandboxReady(output, sandboxName) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  return clean.split("\n").some((l) => {
    const cols = l.trim().split(/\s+/);
    return cols[0] === sandboxName && cols.includes("Ready") && !cols.includes("NotReady");
  });
}

/**
 * Determine whether stale NemoClaw gateway output indicates a previous
 * session that should be cleaned up before the port preflight check.
 * @param {string} gwInfoOutput - Raw output from `openshell gateway info -g nemoclaw`.
 * @returns {boolean}
 */
function hasStaleGateway(gwInfoOutput) {
  return typeof gwInfoOutput === "string" && gwInfoOutput.length > 0 && gwInfoOutput.includes(GATEWAY_NAME);
}

function streamSandboxCreate(command, env = process.env) {
  const child = spawn("bash", ["-lc", command], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [];
  let pending = "";
  let lastPrintedLine = "";
  let sawProgress = false;
  let settled = false;

  function shouldShowLine(line) {
    return (
      /^  Building image /.test(line) ||
      /^  Context: /.test(line) ||
      /^  Gateway: /.test(line) ||
      /^Successfully built /.test(line) ||
      /^Successfully tagged /.test(line) ||
      /^  Built image /.test(line) ||
      /^  Pushing image /.test(line) ||
      /^\s*\[progress\]/.test(line) ||
      /^  Image .*available in the gateway/.test(line) ||
      /^Created sandbox: /.test(line) ||
      /^✓ /.test(line)
    );
  }

  function flushLine(rawLine) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    if (shouldShowLine(line) && line !== lastPrintedLine) {
      console.log(line);
      lastPrintedLine = line;
      sawProgress = true;
    }
  }

  function onChunk(chunk) {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop();
    parts.forEach(flushLine);
  }

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  return new Promise((resolve) => {
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (pending) flushLine(pending);
      const detail = error && error.code
        ? `spawn failed: ${error.message} (${error.code})`
        : `spawn failed: ${error.message}`;
      lines.push(detail);
      resolve({ status: 1, output: lines.join("\n"), sawProgress: false });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (pending) flushLine(pending);
      resolve({ status: code ?? 1, output: lines.join("\n"), sawProgress });
    });
  });
}

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function getInstalledOpenshellVersion(versionOutput = null) {
  const output = String(versionOutput ?? runCapture("openshell -V", { ignoreError: true })).trim();
  const match = output.match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (!match) return null;
  return match[1];
}

function getStableGatewayImageRef(versionOutput = null) {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}

function getOpenshellBinary() {
  if (OPENSHELL_BIN) return OPENSHELL_BIN;
  const resolved = resolveOpenshell();
  if (!resolved) {
    console.error("  openshell CLI not found.");
    console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
    process.exit(1);
  }
  OPENSHELL_BIN = resolved;
  return OPENSHELL_BIN;
}

function openshellShellCommand(args) {
  return [shellQuote(getOpenshellBinary()), ...args.map((arg) => shellQuote(arg))].join(" ");
}

function runOpenshell(args, opts = {}) {
  return run(openshellShellCommand(args), opts);
}

function runCaptureOpenshell(args, opts = {}) {
  return runCapture(openshellShellCommand(args), opts);
}

function formatEnvAssignment(name, value) {
  return `${name}=${value}`;
}

function getCurlTimingArgs() {
  return ["--connect-timeout 5", "--max-time 20"];
}

function buildProviderArgs(action, name, type, credentialEnv, baseUrl) {
  const args =
    action === "create"
      ? ["provider", "create", "--name", name, "--type", type, "--credential", credentialEnv]
      : ["provider", "update", name, "--credential", credentialEnv];
  if (baseUrl && type === "openai") {
    args.push("--config", `OPENAI_BASE_URL=${baseUrl}`);
  } else if (baseUrl && type === "anthropic") {
    args.push("--config", `ANTHROPIC_BASE_URL=${baseUrl}`);
  }
  return args;
}

function upsertProvider(name, type, credentialEnv, baseUrl, env = {}) {
  const createArgs = buildProviderArgs("create", name, type, credentialEnv, baseUrl);
  const createResult = runOpenshell(createArgs, { ignoreError: true, env });
  if (createResult.status === 0) return;

  const updateArgs = buildProviderArgs("update", name, type, credentialEnv, baseUrl);
  const updateResult = runOpenshell(updateArgs, { ignoreError: true, env });
  if (updateResult.status !== 0) {
    console.error(`  Failed to create or update provider '${name}'.`);
    process.exit(updateResult.status || createResult.status || 1);
  }
}

function verifyInferenceRoute(provider, model) {
  const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
  if (!output || /Gateway inference:\s*[\r\n]+\s*Not configured/i.test(output)) {
    console.error("  OpenShell inference route was not configured.");
    process.exit(1);
  }
}

function sandboxExistsInGateway(sandboxName) {
  const output = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  return Boolean(output);
}

function pruneStaleSandboxEntry(sandboxName) {
  const existing = registry.getSandbox(sandboxName);
  const liveExists = sandboxExistsInGateway(sandboxName);
  if (existing && !liveExists) {
    registry.removeSandbox(sandboxName);
  }
  return liveExists;
}

function pythonLiteralJson(value) {
  return JSON.stringify(JSON.stringify(value));
}

function buildSandboxConfigSyncScript(selectionConfig) {
  // openclaw.json is immutable (root:root 444, Landlock read-only) — never
  // write to it at runtime.  Model routing is handled by the host-side
  // gateway (`openshell inference set` in Step 5), not from inside the
  // sandbox.  We only write the NemoClaw selection config (~/.nemoclaw/).
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
exit
`.trim();
}

function writeSandboxConfigSyncFile(script, tmpDir = os.tmpdir(), now = Date.now()) {
  const scriptFile = path.join(tmpDir, `nemoclaw-sync-${now}.sh`);
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
  return scriptFile;
}

function encodeDockerJsonArg(value) {
  return Buffer.from(JSON.stringify(value || {}), "utf8").toString("base64");
}

function getSandboxInferenceConfig(model, provider = null, preferredInferenceApi = null) {
  let providerKey = "inference";
  let primaryModelRef = model;
  let inferenceBaseUrl = "https://inference.local/v1";
  let inferenceApi = preferredInferenceApi || "openai-completions";
  let inferenceCompat = null;

  switch (provider) {
    case "openai-api":
      providerKey = "openai";
      primaryModelRef = `openai/${model}`;
      break;
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      providerKey = "anthropic";
      primaryModelRef = `anthropic/${model}`;
      inferenceBaseUrl = "https://inference.local";
      inferenceApi = "anthropic-messages";
      break;
    case "gemini-api":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "compatible-endpoint":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "nvidia-prod":
    case "nvidia-nim":
    default:
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      break;
  }

  return { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat };
}

function patchStagedDockerfile(dockerfilePath, model, chatUiUrl, buildId = String(Date.now()), provider = null, preferredInferenceApi = null) {
  const {
    providerKey,
    primaryModelRef,
    inferenceBaseUrl,
    inferenceApi,
    inferenceCompat,
  } = getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  let dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_MODEL=.*$/m,
    `ARG NEMOCLAW_MODEL=${model}`
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PROVIDER_KEY=.*$/m,
    `ARG NEMOCLAW_PROVIDER_KEY=${providerKey}`
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PRIMARY_MODEL_REF=.*$/m,
    `ARG NEMOCLAW_PRIMARY_MODEL_REF=${primaryModelRef}`
  );
  dockerfile = dockerfile.replace(
    /^ARG CHAT_UI_URL=.*$/m,
    `ARG CHAT_UI_URL=${chatUiUrl}`
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_BASE_URL=.*$/m,
    `ARG NEMOCLAW_INFERENCE_BASE_URL=${inferenceBaseUrl}`
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_API=.*$/m,
    `ARG NEMOCLAW_INFERENCE_API=${inferenceApi}`
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_COMPAT_B64=.*$/m,
    `ARG NEMOCLAW_INFERENCE_COMPAT_B64=${encodeDockerJsonArg(inferenceCompat)}`
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_BUILD_ID=.*$/m,
    `ARG NEMOCLAW_BUILD_ID=${buildId}`
  );
  fs.writeFileSync(dockerfilePath, dockerfile);
}

function summarizeProbeError(body, status) {
  if (!body) return `HTTP ${status} with no response body`;
  try {
    const parsed = JSON.parse(body);
    const message =
      parsed?.error?.message ||
      parsed?.error?.details ||
      parsed?.message ||
      parsed?.detail ||
      parsed?.details;
    if (message) return `HTTP ${status}: ${String(message)}`;
  } catch {}
  const compact = String(body).replace(/\s+/g, " ").trim();
  return `HTTP ${status}: ${compact.slice(0, 200)}`;
}

function probeOpenAiLikeEndpoint(endpointUrl, model, apiKey) {
  const probes = [
    {
      name: "Responses API",
      api: "openai-responses",
      url: `${String(endpointUrl).replace(/\/+$/, "")}/responses`,
      body: JSON.stringify({
        model,
        input: "Reply with exactly: OK",
      }),
    },
    {
      name: "Chat Completions API",
      api: "openai-completions",
      url: `${String(endpointUrl).replace(/\/+$/, "")}/chat/completions`,
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: "Reply with exactly: OK" },
        ],
      }),
    },
  ];

  const failures = [];
  for (const probe of probes) {
    const bodyFile = path.join(os.tmpdir(), `nemoclaw-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      const cmd = [
        "curl -sS",
        ...getCurlTimingArgs(),
        `-o ${shellQuote(bodyFile)}`,
        "-w '%{http_code}'",
        "-H 'Content-Type: application/json'",
        ...(apiKey ? ['-H "Authorization: Bearer $NEMOCLAW_PROBE_API_KEY"'] : []),
        `-d ${shellQuote(probe.body)}`,
        shellQuote(probe.url),
      ].join(" ");
      const result = spawnSync("bash", ["-c", cmd], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_PROBE_API_KEY: apiKey,
        },
      });
      const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
      const status = Number(String(result.stdout || "").trim());
      if (result.status === 0 && status >= 200 && status < 300) {
        return { ok: true, api: probe.api, label: probe.name };
      }
      failures.push({
        name: probe.name,
        httpStatus: Number.isFinite(status) ? status : 0,
        curlStatus: result.status || 0,
        message: summarizeProbeError(body, status || result.status || 0),
      });
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
  }

  return {
    ok: false,
    message: failures.map((failure) => `${failure.name}: ${failure.message}`).join(" | "),
    failures,
  };
}

function probeAnthropicEndpoint(endpointUrl, model, apiKey) {
  const bodyFile = path.join(os.tmpdir(), `nemoclaw-anthropic-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const cmd = [
      "curl -sS",
      ...getCurlTimingArgs(),
      `-o ${shellQuote(bodyFile)}`,
      "-w '%{http_code}'",
      '-H "x-api-key: $NEMOCLAW_PROBE_API_KEY"',
      "-H 'anthropic-version: 2023-06-01'",
      "-H 'content-type: application/json'",
      `-d ${shellQuote(JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      }))}`,
      shellQuote(`${String(endpointUrl).replace(/\/+$/, "")}/v1/messages`),
    ].join(" ");
    const result = spawnSync("bash", ["-c", cmd], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_PROBE_API_KEY: apiKey,
      },
    });
    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    const status = Number(String(result.stdout || "").trim());
    if (result.status === 0 && status >= 200 && status < 300) {
      return { ok: true, api: "anthropic-messages", label: "Anthropic Messages API" };
    }
    return {
      ok: false,
      message: summarizeProbeError(body, status || result.status || 0),
      failures: [
        {
          name: "Anthropic Messages API",
          httpStatus: Number.isFinite(status) ? status : 0,
          curlStatus: result.status || 0,
        },
      ],
    };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

function shouldRetryProviderSelection(probe) {
  const failures = Array.isArray(probe?.failures) ? probe.failures : [];
  if (failures.length === 0) return true;
  return failures.some((failure) => {
    if ((failure.curlStatus || 0) !== 0) return true;
    return [0, 401, 403, 404].includes(failure.httpStatus || 0);
  });
}

async function validateOpenAiLikeSelection(
  label,
  endpointUrl,
  model,
  credentialEnv = null,
  retryMessage = "Please choose a provider/model again."
) {
  const apiKey = credentialEnv ? getCredential(credentialEnv) : "";
  const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (isNonInteractive()) {
      process.exit(1);
    }
    console.log(`  ${retryMessage}`);
    console.log("");
    return null;
  }
  console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
  return probe.api;
}

async function validateAnthropicSelection(label, endpointUrl, model, credentialEnv) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (isNonInteractive()) {
      process.exit(1);
    }
    console.log("  Please choose a provider/model again.");
    console.log("");
    return null;
  }
  console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
  return probe.api;
}

async function validateAnthropicSelectionWithRetryMessage(
  label,
  endpointUrl,
  model,
  credentialEnv,
  retryMessage = "Please choose a provider/model again."
) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
  if (!probe.ok) {
    console.error(`  ${label} endpoint validation failed.`);
    console.error(`  ${probe.message}`);
    if (isNonInteractive()) {
      process.exit(1);
    }
    console.log(`  ${retryMessage}`);
    console.log("");
    return null;
  }
  console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
  return probe.api;
}

async function validateCustomOpenAiLikeSelection(label, endpointUrl, model, credentialEnv) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey);
  if (probe.ok) {
    console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }
  console.error(`  ${label} endpoint validation failed.`);
  console.error(`  ${probe.message}`);
  if (isNonInteractive()) {
    process.exit(1);
  }
  if (shouldRetryProviderSelection(probe)) {
    console.log("  Please choose a provider/model again.");
    console.log("");
    return { ok: false, retry: "selection" };
  }
  console.log(`  Please enter a different ${label} model name.`);
  console.log("");
  return { ok: false, retry: "model" };
}

async function validateCustomAnthropicSelection(label, endpointUrl, model, credentialEnv) {
  const apiKey = getCredential(credentialEnv);
  const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
  if (probe.ok) {
    console.log(`  ${probe.label} available — OpenClaw will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }
  console.error(`  ${label} endpoint validation failed.`);
  console.error(`  ${probe.message}`);
  if (isNonInteractive()) {
    process.exit(1);
  }
  if (shouldRetryProviderSelection(probe)) {
    console.log("  Please choose a provider/model again.");
    console.log("");
    return { ok: false, retry: "selection" };
  }
  console.log(`  Please enter a different ${label} model name.`);
  console.log("");
  return { ok: false, retry: "model" };
}

function fetchNvidiaEndpointModels(apiKey) {
  const bodyFile = path.join(os.tmpdir(), `nemoclaw-nvidia-models-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const cmd = [
      "curl -sS",
      ...getCurlTimingArgs(),
      `-o ${shellQuote(bodyFile)}`,
      "-w '%{http_code}'",
      "-H 'Content-Type: application/json'",
      '-H "Authorization: Bearer $NEMOCLAW_PROBE_API_KEY"',
      shellQuote(`${BUILD_ENDPOINT_URL}/models`),
    ].join(" ");
    const result = spawnSync("bash", ["-c", cmd], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_PROBE_API_KEY: apiKey,
      },
    });
    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    const status = Number(String(result.stdout || "").trim());
    if (result.status !== 0 || !(status >= 200 && status < 300)) {
      return { ok: false, message: summarizeProbeError(body, status || result.status || 0) };
    }
    const parsed = JSON.parse(body);
    const ids = Array.isArray(parsed?.data)
      ? parsed.data.map((item) => item && item.id).filter(Boolean)
      : [];
    return { ok: true, ids };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

function validateNvidiaEndpointModel(model, apiKey) {
  const available = fetchNvidiaEndpointModels(apiKey);
  if (!available.ok) {
    return {
      ok: false,
      message: `Could not validate model against ${BUILD_ENDPOINT_URL}/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `Model '${model}' is not available from NVIDIA Endpoints. Checked ${BUILD_ENDPOINT_URL}/models.`,
  };
}

function fetchOpenAiLikeModels(endpointUrl, apiKey) {
  const bodyFile = path.join(os.tmpdir(), `nemoclaw-openai-models-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const cmd = [
      "curl -sS",
      ...getCurlTimingArgs(),
      `-o ${shellQuote(bodyFile)}`,
      "-w '%{http_code}'",
      ...(apiKey ? ['-H "Authorization: Bearer $NEMOCLAW_PROBE_API_KEY"'] : []),
      shellQuote(`${String(endpointUrl).replace(/\/+$/, "")}/models`),
    ].join(" ");
    const result = spawnSync("bash", ["-c", cmd], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_PROBE_API_KEY: apiKey,
      },
    });
    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    const status = Number(String(result.stdout || "").trim());
    if (result.status !== 0 || !(status >= 200 && status < 300)) {
      return { ok: false, status, message: summarizeProbeError(body, status || result.status || 0) };
    }
    const parsed = JSON.parse(body);
    const ids = Array.isArray(parsed?.data)
      ? parsed.data.map((item) => item && item.id).filter(Boolean)
      : [];
    return { ok: true, ids };
  } catch (error) {
    return { ok: false, status: 0, message: error.message || String(error) };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

function fetchAnthropicModels(endpointUrl, apiKey) {
  const bodyFile = path.join(os.tmpdir(), `nemoclaw-anthropic-models-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const cmd = [
      "curl -sS",
      ...getCurlTimingArgs(),
      `-o ${shellQuote(bodyFile)}`,
      "-w '%{http_code}'",
      '-H "x-api-key: $NEMOCLAW_PROBE_API_KEY"',
      "-H 'anthropic-version: 2023-06-01'",
      shellQuote(`${String(endpointUrl).replace(/\/+$/, "")}/v1/models`),
    ].join(" ");
    const result = spawnSync("bash", ["-c", cmd], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_PROBE_API_KEY: apiKey,
      },
    });
    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    const status = Number(String(result.stdout || "").trim());
    if (result.status !== 0 || !(status >= 200 && status < 300)) {
      return { ok: false, status, message: summarizeProbeError(body, status || result.status || 0) };
    }
    const parsed = JSON.parse(body);
    const ids = Array.isArray(parsed?.data)
      ? parsed.data.map((item) => item && (item.id || item.name)).filter(Boolean)
      : [];
    return { ok: true, ids };
  } catch (error) {
    return { ok: false, status: 0, message: error.message || String(error) };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

function validateAnthropicModel(endpointUrl, model, apiKey) {
  const available = fetchAnthropicModels(endpointUrl, apiKey);
  if (!available.ok) {
    if (available.status === 404 || available.status === 405) {
      return { ok: true, validated: false };
    }
    return {
      ok: false,
      message: `Could not validate model against ${String(endpointUrl).replace(/\/+$/, "")}/v1/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    message: `Model '${model}' is not available from Anthropic. Checked ${String(endpointUrl).replace(/\/+$/, "")}/v1/models.`,
  };
}

function validateOpenAiLikeModel(label, endpointUrl, model, apiKey) {
  const available = fetchOpenAiLikeModels(endpointUrl, apiKey);
  if (!available.ok) {
    if (available.status === 404 || available.status === 405) {
      return { ok: true, validated: false };
    }
    return {
      ok: false,
      message: `Could not validate model against ${String(endpointUrl).replace(/\/+$/, "")}/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    message: `Model '${model}' is not available from ${label}. Checked ${String(endpointUrl).replace(/\/+$/, "")}/models.`,
  };
}

async function promptManualModelId(promptLabel, errorLabel, validator = null) {
  while (true) {
    const manual = await prompt(promptLabel);
    const trimmed = manual.trim();
    if (!trimmed || !isSafeModelId(trimmed)) {
      console.error(`  Invalid ${errorLabel} model id.`);
      continue;
    }
    if (validator) {
      const validation = validator(trimmed);
      if (!validation.ok) {
        console.error(`  ${validation.message}`);
        continue;
      }
    }
    return trimmed;
  }
}

async function promptCloudModel() {
  console.log("");
  console.log("  Cloud models:");
  CLOUD_MODEL_OPTIONS.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option.label} (${option.id})`);
  });
  console.log(`    ${CLOUD_MODEL_OPTIONS.length + 1}) Other...`);
  console.log("");

  const choice = await prompt("  Choose model [1]: ");
  const index = parseInt(choice || "1", 10) - 1;
  if (index >= 0 && index < CLOUD_MODEL_OPTIONS.length) {
    return CLOUD_MODEL_OPTIONS[index].id;
  }

  return promptManualModelId(
    "  NVIDIA Endpoints model id: ",
    "NVIDIA Endpoints",
    (model) => validateNvidiaEndpointModel(model, getCredential("NVIDIA_API_KEY"))
  );
}

async function promptRemoteModel(label, providerKey, defaultModel, validator = null) {
  const options = REMOTE_MODEL_OPTIONS[providerKey] || [];
  const defaultIndex = Math.max(0, options.indexOf(defaultModel));

  console.log("");
  console.log(`  ${label} models:`);
  options.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option}`);
  });
  console.log(`    ${options.length + 1}) Other...`);
  console.log("");

  const choice = await prompt(`  Choose model [${defaultIndex + 1}]: `);
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  if (index >= 0 && index < options.length) {
    return options[index];
  }

  return promptManualModelId(`  ${label} model id: `, label, validator);
}

async function promptInputModel(label, defaultModel, validator = null) {
  while (true) {
    const value = await prompt(`  ${label} model [${defaultModel}]: `);
    const trimmed = (value || defaultModel).trim();
    if (!trimmed || !isSafeModelId(trimmed)) {
      console.error(`  Invalid ${label} model id.`);
      continue;
    }
    if (validator) {
      const validation = validator(trimmed);
      if (!validation.ok) {
        console.error(`  ${validation.message}`);
        continue;
      }
    }
    return trimmed;
  }
}

async function promptOllamaModel(gpu = null) {
  const installed = getOllamaModelOptions(runCapture);
  const options = installed.length > 0 ? installed : getBootstrapOllamaModelOptions(gpu);
  const defaultModel = getDefaultOllamaModel(runCapture, gpu);
  const defaultIndex = Math.max(0, options.indexOf(defaultModel));

  console.log("");
  console.log(installed.length > 0 ? "  Ollama models:" : "  Ollama starter models:");
  options.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option}`);
  });
  console.log(`    ${options.length + 1}) Other...`);
  if (installed.length === 0) {
    console.log("");
    console.log("  No local Ollama models are installed yet. Choose one to pull and load now.");
  }
  console.log("");

  const choice = await prompt(`  Choose model [${defaultIndex + 1}]: `);
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  if (index >= 0 && index < options.length) {
    return options[index];
  }
  return promptManualModelId("  Ollama model id: ", "Ollama");
}

function pullOllamaModel(model) {
  const result = spawnSync("bash", ["-c", `ollama pull ${shellQuote(model)}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env },
  });
  return result.status === 0;
}

function prepareOllamaModel(model, installedModels = []) {
  const alreadyInstalled = installedModels.includes(model);
  if (!alreadyInstalled) {
    console.log(`  Pulling Ollama model: ${model}`);
    if (!pullOllamaModel(model)) {
      return {
        ok: false,
        message:
          `Failed to pull Ollama model '${model}'. ` +
          "Check the model name and that Ollama can access the registry, then try another model.",
      };
    }
  }

  console.log(`  Loading Ollama model: ${model}`);
  run(getOllamaWarmupCommand(model), { ignoreError: true });
  return validateOllamaModel(model, runCapture);
}

function isDockerRunning() {
  try {
    runCapture("docker info", { ignoreError: false });
    return true;
  } catch {
    return false;
  }
}

function getContainerRuntime() {
  const info = runCapture("docker info 2>/dev/null", { ignoreError: true });
  return inferContainerRuntime(info);
}

function isOpenshellInstalled() {
  return resolveOpenshell() !== null;
}

function getFutureShellPathHint(binDir, pathValue = process.env.PATH || "") {
  if (String(pathValue).split(path.delimiter).includes(binDir)) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}

function installOpenshell() {
  const result = spawnSync("bash", [path.join(SCRIPTS, "install-openshell.sh")], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) {
      console.error(output);
    }
    return { installed: false, localBin: null, futureShellPathHint: null };
  }
  const localBin = process.env.XDG_BIN_HOME || path.join(process.env.HOME || "", ".local", "bin");
  const openshellPath = path.join(localBin, "openshell");
  const futureShellPathHint = fs.existsSync(openshellPath)
    ? getFutureShellPathHint(localBin, process.env.PATH)
    : null;
  if (fs.existsSync(openshellPath) && futureShellPathHint) {
    process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH}`;
  }
  return {
    installed: isOpenshellInstalled(),
    localBin,
    futureShellPathHint,
  };
  OPENSHELL_BIN = resolveOpenshell();
  return {
    installed: OPENSHELL_BIN !== null,
    localBin,
    futureShellPathHint,
  };
}

function sleep(seconds) {
  require("child_process").spawnSync("sleep", [String(seconds)]);
}

async function ensureNamedCredential(envName, label, helpUrl = null) {
  let key = getCredential(envName);
  if (key) {
    process.env[envName] = key;
    return key;
  }

  if (helpUrl) {
    console.log("");
    console.log(`  Get your ${label} from: ${helpUrl}`);
    console.log("");
  }

  key = await prompt(`  ${label}: `, { secret: true });
  if (!key) {
    console.error(`  ${label} is required.`);
    process.exit(1);
  }

  saveCredential(envName, key);
  process.env[envName] = key;
  console.log("");
  console.log(`  Key saved to ~/.nemoclaw/credentials.json (mode 600)`);
  console.log("");
  return key;
}

function waitForSandboxReady(sandboxName, attempts = 10, delaySeconds = 2) {
  for (let i = 0; i < attempts; i += 1) {
    const exists = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
    if (exists) return true;
    sleep(delaySeconds);
  }
  return false;
}

function parsePolicyPresetEnv(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSafeModelId(value) {
  return /^[A-Za-z0-9._:/-]+$/.test(value);
}

function getNonInteractiveProvider() {
  const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  if (!providerKey) return null;
  const aliases = {
    cloud: "build",
    nim: "nim-local",
    vllm: "vllm",
    anthropiccompatible: "anthropicCompatible",
  };
  const normalized = aliases[providerKey] || providerKey;
  const validProviders = new Set(["build", "openai", "anthropic", "anthropicCompatible", "gemini", "ollama", "custom", "nim-local", "vllm"]);
  if (!validProviders.has(normalized)) {
    console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    console.error("  Valid values: build, openai, anthropic, anthropicCompatible, gemini, ollama, custom, nim-local, vllm");
    process.exit(1);
  }

  return normalized;
}

function getNonInteractiveModel(providerKey) {
  const model = (process.env.NEMOCLAW_MODEL || "").trim();
  if (!model) return null;
  if (!isSafeModelId(model)) {
    console.error(`  Invalid NEMOCLAW_MODEL for provider '${providerKey}': ${model}`);
    console.error("  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.");
    process.exit(1);
  }
  return model;
}

// ── Step 1: Preflight ────────────────────────────────────────────

async function preflight() {
  step(1, 7, "Preflight checks");

  // Docker
  if (!isDockerRunning()) {
    console.error("  Docker is not running. Please start Docker and try again.");
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

  const runtime = getContainerRuntime();
  if (isUnsupportedMacosRuntime(runtime)) {
    console.error("  Podman on macOS is not supported by NemoClaw at this time.");
    console.error("  OpenShell currently depends on Docker host-gateway behavior that Podman on macOS does not provide.");
    console.error("  Use Colima or Docker Desktop on macOS instead.");
    process.exit(1);
  }
  if (runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${runtime}`);
  }

  // OpenShell CLI
  let openshellInstall = { localBin: null, futureShellPathHint: null };
  if (!isOpenshellInstalled()) {
    console.log("  openshell CLI not found. Installing...");
    openshellInstall = installOpenshell();
    if (!openshellInstall.installed) {
      console.error("  Failed to install openshell CLI.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
  }
  console.log(`  ✓ openshell CLI: ${runCaptureOpenshell(["--version"], { ignoreError: true }) || "unknown"}`);
  if (openshellInstall.futureShellPathHint) {
    console.log(`  Note: openshell was installed to ${openshellInstall.localBin} for this onboarding run.`);
    console.log(`  Future shells may still need: ${openshellInstall.futureShellPathHint}`);
    console.log("  Add that export to your shell profile, or open a new terminal before running openshell directly.");
  }

  // Clean up stale NemoClaw session before checking ports.
  // A previous onboard run may have left the gateway container and port
  // forward running.  If a NemoClaw-owned gateway is still present, tear
  // it down so the port check below doesn't fail on our own leftovers.
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], { ignoreError: true });
  if (hasStaleGateway(gwInfo)) {
    console.log("  Cleaning up previous NemoClaw session...");
    runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
    runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], { ignoreError: true });
    console.log("  ✓ Previous session cleaned up");
  }

  // Required ports — gateway (8080) and dashboard (18789)
  const requiredPorts = [
    { port: 8080, label: "OpenShell gateway" },
    { port: 18789, label: "NemoClaw dashboard" },
  ];
  for (const { port, label } of requiredPorts) {
    const portCheck = await checkPortAvailable(port);
    if (!portCheck.ok) {
      console.error("");
      console.error(`  !! Port ${port} is not available.`);
      console.error(`     ${label} needs this port.`);
      console.error("");
      if (portCheck.process && portCheck.process !== "unknown") {
        console.error(`     Blocked by: ${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`);
        console.error("");
        console.error("     To fix, stop the conflicting process:");
        console.error("");
        if (portCheck.pid) {
          console.error(`       sudo kill ${portCheck.pid}`);
        } else {
          console.error(`       lsof -i :${port} -sTCP:LISTEN -P -n`);
        }
        console.error("       # or, if it's a systemd service:");
        console.error("       systemctl --user stop openclaw-gateway.service");
      } else {
        console.error(`     Could not identify the process using port ${port}.`);
        console.error(`     Run: lsof -i :${port} -sTCP:LISTEN`);
      }
      console.error("");
      console.error(`     Detail: ${portCheck.reason}`);
      process.exit(1);
    }
    console.log(`  ✓ Port ${port} available (${label})`);
  }

  // GPU
  const gpu = nim.detectGpu();
  if (gpu && gpu.type === "nvidia") {
    console.log(`  ✓ NVIDIA GPU detected: ${gpu.count} GPU(s), ${gpu.totalMemoryMB} MB VRAM`);
  } else if (gpu && gpu.type === "apple") {
    console.log(`  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`);
    console.log("  ⓘ NIM requires NVIDIA GPU — will use cloud inference");
  } else {
    console.log("  ⓘ No GPU detected — will use cloud inference");
  }

  return gpu;
}

// ── Step 2: Gateway ──────────────────────────────────────────────

async function startGateway(gpu) {
  step(3, 7, "Starting OpenShell gateway");

  // Destroy old gateway
  runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], { ignoreError: true });

  const gwArgs = ["--name", GATEWAY_NAME];
  // Do NOT pass --gpu here. On DGX Spark (and most GPU hosts), inference is
  // routed through a host-side provider (Ollama, vLLM, or cloud API) — the
  // sandbox itself does not need direct GPU access. Passing --gpu causes
  // FailedPrecondition errors when the gateway's k3s device plugin cannot
  // allocate GPUs. See: https://build.nvidia.com/spark/nemoclaw/instructions
  const gatewayEnv = {};
  const openshellVersion = getInstalledOpenshellVersion();
  const stableGatewayImage = openshellVersion
    ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
    : null;
  if (stableGatewayImage && openshellVersion) {
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
    gatewayEnv.IMAGE_TAG = openshellVersion;
    console.log(`  Using pinned OpenShell gateway image: ${stableGatewayImage}`);
  }

  runOpenshell(["gateway", "start", ...gwArgs], { ignoreError: false, env: gatewayEnv });

  // Verify health
  for (let i = 0; i < 5; i++) {
    const status = runCaptureOpenshell(["status"], { ignoreError: true });
    if (status.includes("Connected")) {
      console.log("  ✓ Gateway is healthy");
      break;
    }
    if (i === 4) {
      console.error("  Gateway failed to start. Run: openshell gateway info");
      process.exit(1);
    }
    sleep(2);
  }

  // CoreDNS fix — always run. k3s-inside-Docker has broken DNS on all platforms.
  const runtime = getContainerRuntime();
  if (shouldPatchCoredns(runtime)) {
    console.log("  Patching CoreDNS for Colima...");
    run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" ${GATEWAY_NAME} 2>&1 || true`, { ignoreError: true });
  }
  // Give DNS a moment to propagate
  sleep(5);
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
}

// ── Step 3: Sandbox ──────────────────────────────────────────────

async function createSandbox(gpu, model, provider, preferredInferenceApi = null) {
  step(5, 7, "Creating sandbox");

  const nameAnswer = await promptOrDefault(
    "  Sandbox name (lowercase, numbers, hyphens) [my-assistant]: ",
    "NEMOCLAW_SANDBOX_NAME", "my-assistant"
  );
  const sandboxName = (nameAnswer || "my-assistant").trim().toLowerCase();

  // Validate: RFC 1123 subdomain — lowercase alphanumeric and hyphens,
  // must start and end with alphanumeric (required by Kubernetes/OpenShell)
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName)) {
    console.error(`  Invalid sandbox name: '${sandboxName}'`);
    console.error("  Names must be lowercase, contain only letters, numbers, and hyphens,");
    console.error("  and must start and end with a letter or number.");
    process.exit(1);
  }

  // Reconcile local registry state with the live OpenShell gateway state.
  const liveExists = pruneStaleSandboxEntry(sandboxName);

  if (liveExists) {
    if (isNonInteractive()) {
      if (process.env.NEMOCLAW_RECREATE_SANDBOX !== "1") {
        console.error(`  Sandbox '${sandboxName}' already exists.`);
        console.error("  Set NEMOCLAW_RECREATE_SANDBOX=1 to recreate it in non-interactive mode.");
        process.exit(1);
      }
      note(`  [non-interactive] Sandbox '${sandboxName}' exists — recreating`);
    } else {
      const recreate = await prompt(`  Sandbox '${sandboxName}' already exists. Recreate? [y/N]: `);
      if (recreate.toLowerCase() !== "y") {
        console.log("  Keeping existing sandbox.");
        return sandboxName;
      }
    }
    // Destroy old sandbox
    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  // Stage build context
  const { mkdtempSync } = require("fs");
  const os = require("os");
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.copyFileSync(path.join(ROOT, "Dockerfile"), stagedDockerfile);
  run(`cp -r "${path.join(ROOT, "nemoclaw")}" "${buildCtx}/nemoclaw"`);
  run(`cp -r "${path.join(ROOT, "nemoclaw-blueprint")}" "${buildCtx}/nemoclaw-blueprint"`);
  run(`cp -r "${path.join(ROOT, "scripts")}" "${buildCtx}/scripts"`);
  run(`rm -rf "${buildCtx}/nemoclaw/node_modules"`, { ignoreError: true });

  // Create sandbox (use -- echo to avoid dropping into interactive shell)
  // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
  const basePolicyPath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const createArgs = [
    "--from", `${buildCtx}/Dockerfile`,
    "--name", sandboxName,
    "--policy", basePolicyPath,
  ];
  // --gpu is intentionally omitted. See comment in startGateway().

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  const chatUiUrl = process.env.CHAT_UI_URL || "http://127.0.0.1:18789";
  patchStagedDockerfile(stagedDockerfile, model, chatUiUrl, String(Date.now()), provider, preferredInferenceApi);
  // Only pass non-sensitive env vars to the sandbox. NVIDIA_API_KEY is NOT
  // needed inside the sandbox — inference is proxied through the OpenShell
  // gateway which injects the stored credential server-side. The gateway
  // also strips any Authorization headers sent by the sandbox client.
  // See: crates/openshell-sandbox/src/proxy.rs (header stripping),
  //      crates/openshell-router/src/backend.rs (server-side auth injection).
  const envArgs = [formatEnvAssignment("CHAT_UI_URL", chatUiUrl)];
  const sandboxEnv = { ...process.env };
  delete sandboxEnv.NVIDIA_API_KEY;
  const discordToken = getCredential("DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN;
  if (discordToken) {
    sandboxEnv.DISCORD_BOT_TOKEN = discordToken;
  }
  const slackToken = getCredential("SLACK_BOT_TOKEN") || process.env.SLACK_BOT_TOKEN;
  if (slackToken) {
    sandboxEnv.SLACK_BOT_TOKEN = slackToken;
  }

  // Run without piping through awk — the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  const createCommand = `${openshellShellCommand([
    "sandbox",
    "create",
    ...createArgs,
    "--",
    "env",
    ...envArgs,
    "nemoclaw-start",
  ])} 2>&1`;
  const createResult = await streamSandboxCreate(createCommand, sandboxEnv);

  // Clean up build context regardless of outcome
  run(`rm -rf "${buildCtx}"`, { ignoreError: true });

  if (createResult.status !== 0) {
    console.error("");
    console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
    if (createResult.output) {
      console.error("");
      console.error(createResult.output);
    }
    console.error("  Try:  openshell sandbox list        # check gateway state");
    console.error("  Try:  nemoclaw onboard              # retry from scratch");
    process.exit(createResult.status || 1);
  }

  // Wait for sandbox to reach Ready state in k3s before registering.
  // On WSL2 + Docker Desktop the pod can take longer to initialize;
  // without this gate, NemoClaw registers a phantom sandbox that
  // causes "sandbox not found" on every subsequent connect/status call.
  console.log("  Waiting for sandbox to become ready...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) {
      ready = true;
      break;
    }
    require("child_process").spawnSync("sleep", ["2"]);
  }

  if (!ready) {
    // Clean up the orphaned sandbox so the next onboard retry with the same
    // name doesn't fail on "sandbox already exists".
    const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    console.error("");
    console.error(`  Sandbox '${sandboxName}' was created but did not become ready within 60s.`);
    if (delResult.status === 0) {
      console.error("  The orphaned sandbox has been removed — you can safely retry.");
    } else {
      console.error(`  Could not remove the orphaned sandbox. Manual cleanup:`);
      console.error(`    openshell sandbox delete "${sandboxName}"`);
    }
    console.error("  Retry: nemoclaw onboard");
    process.exit(1);
  }

  // Release any stale forward on port 18789 before claiming it for the new sandbox.
  // A previous onboard run may have left the port forwarded to a different sandbox,
  // which would silently prevent the new sandbox's dashboard from being reachable.
  runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
  // Forward dashboard port to the new sandbox
  runOpenshell(["forward", "start", "--background", "18789", sandboxName], { ignoreError: true });

  // Register only after confirmed ready — prevents phantom entries
  registry.registerSandbox({
    name: sandboxName,
    gpuEnabled: !!gpu,
  });

  console.log(`  ✓ Sandbox '${sandboxName}' created`);
  return sandboxName;
}

// ── Step 4: NIM ──────────────────────────────────────────────────

async function setupNim(gpu) {
  step(2, 7, "Configuring inference (NIM)");

  let model = null;
  let provider = REMOTE_PROVIDER_CONFIG.build.providerName;
  let nimContainer = null;
  let endpointUrl = REMOTE_PROVIDER_CONFIG.build.endpointUrl;
  let credentialEnv = REMOTE_PROVIDER_CONFIG.build.credentialEnv;
  let preferredInferenceApi = null;

  // Detect local inference options
  const hasOllama = !!runCapture("command -v ollama", { ignoreError: true });
  const ollamaRunning = !!runCapture("curl -sf http://localhost:11434/api/tags 2>/dev/null", { ignoreError: true });
  const vllmRunning = !!runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", { ignoreError: true });
  const requestedProvider = isNonInteractive() ? getNonInteractiveProvider() : null;
  const requestedModel = isNonInteractive() ? getNonInteractiveModel(requestedProvider || "build") : null;
  const options = [];
  options.push({
    key: "build",
    label:
      "NVIDIA Endpoints" +
      (!ollamaRunning && !(EXPERIMENTAL && vllmRunning) ? " (recommended)" : ""),
  });
  options.push({ key: "openai", label: "OpenAI" });
  options.push({ key: "custom", label: "Other OpenAI-compatible endpoint" });
  options.push({ key: "anthropic", label: "Anthropic" });
  options.push({ key: "anthropicCompatible", label: "Other Anthropic-compatible endpoint" });
  options.push({ key: "gemini", label: "Google Gemini" });
  if (hasOllama || ollamaRunning) {
    options.push({
      key: "ollama",
      label:
        `Local Ollama (localhost:11434)${ollamaRunning ? " — running" : ""}` +
        (ollamaRunning ? " (suggested)" : ""),
    });
  }
  if (EXPERIMENTAL && gpu && gpu.nimCapable) {
    options.push({ key: "nim-local", label: "Local NVIDIA NIM [experimental]" });
  }
  if (EXPERIMENTAL && vllmRunning) {
    options.push({
      key: "vllm",
      label: "Local vLLM [experimental] — running",
    });
  }

  // On macOS without Ollama, offer to install it
  if (!hasOllama && process.platform === "darwin") {
    options.push({ key: "install-ollama", label: "Install Ollama (macOS)" });
  }

  if (options.length > 1) {
    selectionLoop:
    while (true) {
    let selected;

    if (isNonInteractive()) {
      const providerKey = requestedProvider || "build";
      selected = options.find((o) => o.key === providerKey);
      if (!selected) {
        console.error(`  Requested provider '${providerKey}' is not available in this environment.`);
        process.exit(1);
      }
      note(`  [non-interactive] Provider: ${selected.key}`);
    } else {
      const suggestions = [];
      if (vllmRunning) suggestions.push("vLLM");
      if (ollamaRunning) suggestions.push("Ollama");
      if (suggestions.length > 0) {
        console.log(`  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`);
        console.log("  Select one explicitly to use it. Press Enter to keep NVIDIA Endpoints.");
        console.log("");
      }

      console.log("");
      console.log("  Inference options:");
      options.forEach((o, i) => {
        console.log(`    ${i + 1}) ${o.label}`);
      });
      console.log("");

      const defaultIdx = options.findIndex((o) => o.key === "build") + 1;
      const choice = await prompt(`  Choose [${defaultIdx}]: `);
      const idx = parseInt(choice || String(defaultIdx), 10) - 1;
      selected = options[idx] || options[defaultIdx - 1];
    }

    if (REMOTE_PROVIDER_CONFIG[selected.key]) {
      const remoteConfig = REMOTE_PROVIDER_CONFIG[selected.key];
      provider = remoteConfig.providerName;
      credentialEnv = remoteConfig.credentialEnv;
      endpointUrl = remoteConfig.endpointUrl;
      preferredInferenceApi = null;

      if (selected.key === "custom") {
        endpointUrl = isNonInteractive()
          ? (process.env.NEMOCLAW_ENDPOINT_URL || "").trim()
          : await prompt("  OpenAI-compatible base URL (e.g., https://openrouter.ai/api/v1): ");
        if (!endpointUrl) {
          console.error("  Endpoint URL is required for Other OpenAI-compatible endpoint.");
          process.exit(1);
        }
      } else if (selected.key === "anthropicCompatible") {
        endpointUrl = isNonInteractive()
          ? (process.env.NEMOCLAW_ENDPOINT_URL || "").trim()
          : await prompt("  Anthropic-compatible base URL (e.g., https://proxy.example.com): ");
        if (!endpointUrl) {
          console.error("  Endpoint URL is required for Other Anthropic-compatible endpoint.");
          process.exit(1);
        }
      }

      if (selected.key === "build") {
        if (isNonInteractive()) {
          if (!process.env.NVIDIA_API_KEY) {
            console.error("  NVIDIA_API_KEY is required for NVIDIA Endpoints in non-interactive mode.");
            process.exit(1);
          }
        } else {
          await ensureApiKey();
        }
        model = requestedModel || (isNonInteractive() ? DEFAULT_CLOUD_MODEL : await promptCloudModel()) || DEFAULT_CLOUD_MODEL;
      } else {
        if (isNonInteractive()) {
          if (!process.env[credentialEnv]) {
            console.error(`  ${credentialEnv} is required for ${remoteConfig.label} in non-interactive mode.`);
            process.exit(1);
          }
        } else {
          await ensureNamedCredential(credentialEnv, remoteConfig.label + " API key", remoteConfig.helpUrl);
        }
        const defaultModel = requestedModel || remoteConfig.defaultModel;
        let modelValidator = null;
        if (selected.key === "openai" || selected.key === "gemini") {
          modelValidator = (candidate) =>
            validateOpenAiLikeModel(remoteConfig.label, endpointUrl, candidate, getCredential(credentialEnv));
        } else if (selected.key === "anthropic") {
          modelValidator = (candidate) =>
            validateAnthropicModel(endpointUrl || ANTHROPIC_ENDPOINT_URL, candidate, getCredential(credentialEnv));
        }
        while (true) {
          if (isNonInteractive()) {
            model = defaultModel;
          } else if (remoteConfig.modelMode === "curated") {
            model = await promptRemoteModel(remoteConfig.label, selected.key, defaultModel, modelValidator);
          } else {
            model = await promptInputModel(remoteConfig.label, defaultModel, modelValidator);
          }

          if (selected.key === "custom") {
            const validation = await validateCustomOpenAiLikeSelection(
              remoteConfig.label,
              endpointUrl,
              model,
              credentialEnv
            );
            if (validation.ok) {
              preferredInferenceApi = validation.api;
              break;
            }
            if (validation.retry === "selection") {
              continue selectionLoop;
            }
          } else if (selected.key === "anthropicCompatible") {
            const validation = await validateCustomAnthropicSelection(
              remoteConfig.label,
              endpointUrl || ANTHROPIC_ENDPOINT_URL,
              model,
              credentialEnv
            );
            if (validation.ok) {
              preferredInferenceApi = validation.api;
              break;
            }
            if (validation.retry === "selection") {
              continue selectionLoop;
            }
          } else {
            const retryMessage = "Please choose a provider/model again.";
            if (selected.key === "anthropic") {
              preferredInferenceApi = await validateAnthropicSelectionWithRetryMessage(
                remoteConfig.label,
                endpointUrl || ANTHROPIC_ENDPOINT_URL,
                model,
                credentialEnv,
                retryMessage
              );
            } else {
              preferredInferenceApi = await validateOpenAiLikeSelection(
                remoteConfig.label,
                endpointUrl,
                model,
                credentialEnv,
                retryMessage
              );
            }
            if (preferredInferenceApi) {
              break;
            }
            continue selectionLoop;
          }
        }
      }

      if (selected.key === "build") {
        preferredInferenceApi = await validateOpenAiLikeSelection(
          remoteConfig.label,
          endpointUrl,
          model,
          credentialEnv
        );
        if (!preferredInferenceApi) {
          continue selectionLoop;
        }
      }

      console.log(`  Using ${remoteConfig.label} with model: ${model}`);
      break;
    } else if (selected.key === "nim-local") {
      // List models that fit GPU VRAM
      const models = nim.listModels().filter((m) => m.minGpuMemoryMB <= gpu.totalMemoryMB);
      if (models.length === 0) {
        console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
      } else {
        let sel;
        if (isNonInteractive()) {
          if (requestedModel) {
            sel = models.find((m) => m.name === requestedModel);
            if (!sel) {
              console.error(`  Unsupported NEMOCLAW_MODEL for NIM: ${requestedModel}`);
              process.exit(1);
            }
          } else {
            sel = models[0];
          }
          note(`  [non-interactive] NIM model: ${sel.name}`);
        } else {
          console.log("");
          console.log("  Models that fit your GPU:");
          models.forEach((m, i) => {
            console.log(`    ${i + 1}) ${m.name} (min ${m.minGpuMemoryMB} MB)`);
          });
          console.log("");

          const modelChoice = await prompt(`  Choose model [1]: `);
          const midx = parseInt(modelChoice || "1", 10) - 1;
          sel = models[midx] || models[0];
        }
        model = sel.name;

        console.log(`  Pulling NIM image for ${model}...`);
        nim.pullNimImage(model);

        console.log("  Starting NIM container...");
        nimContainer = nim.startNimContainerByName(nim.containerName(GATEWAY_NAME), model);

        console.log("  Waiting for NIM to become healthy...");
        if (!nim.waitForNimHealth()) {
          console.error("  NIM failed to start. Falling back to cloud API.");
          model = null;
          nimContainer = null;
        } else {
          provider = "vllm-local";
          credentialEnv = "OPENAI_API_KEY";
          endpointUrl = getLocalProviderBaseUrl(provider);
          preferredInferenceApi = await validateOpenAiLikeSelection(
            "Local NVIDIA NIM",
            endpointUrl,
            model,
            credentialEnv
          );
          if (!preferredInferenceApi) {
            continue selectionLoop;
          }
        }
      }
      break;
    } else if (selected.key === "ollama") {
      if (!ollamaRunning) {
        console.log("  Starting Ollama...");
        run("OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &", { ignoreError: true });
        sleep(2);
      }
      console.log("  ✓ Using Ollama on localhost:11434");
      provider = "ollama-local";
      credentialEnv = "OPENAI_API_KEY";
      endpointUrl = getLocalProviderBaseUrl(provider);
      while (true) {
        const installedModels = getOllamaModelOptions(runCapture);
        if (isNonInteractive()) {
          model = requestedModel || getDefaultOllamaModel(runCapture, gpu);
        } else {
          model = await promptOllamaModel(gpu);
        }
        const probe = prepareOllamaModel(model, installedModels);
        if (!probe.ok) {
          console.error(`  ${probe.message}`);
          if (isNonInteractive()) {
            process.exit(1);
          }
          console.log("  Choose a different Ollama model or select Other.");
          console.log("");
          continue;
        }
        preferredInferenceApi = await validateOpenAiLikeSelection(
          "Local Ollama",
          getLocalProviderValidationBaseUrl(provider),
          model,
          null,
          "Choose a different Ollama model or select Other."
        );
        if (!preferredInferenceApi) {
          continue;
        }
        break;
      }
      break;
    } else if (selected.key === "install-ollama") {
      console.log("  Installing Ollama via Homebrew...");
      run("brew install ollama", { ignoreError: true });
      console.log("  Starting Ollama...");
      run("OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &", { ignoreError: true });
        sleep(2);
      console.log("  ✓ Using Ollama on localhost:11434");
      provider = "ollama-local";
      credentialEnv = "OPENAI_API_KEY";
      endpointUrl = getLocalProviderBaseUrl(provider);
      while (true) {
        const installedModels = getOllamaModelOptions(runCapture);
        if (isNonInteractive()) {
          model = requestedModel || getDefaultOllamaModel(runCapture, gpu);
        } else {
          model = await promptOllamaModel(gpu);
        }
        const probe = prepareOllamaModel(model, installedModels);
        if (!probe.ok) {
          console.error(`  ${probe.message}`);
          if (isNonInteractive()) {
            process.exit(1);
          }
          console.log("  Choose a different Ollama model or select Other.");
          console.log("");
          continue;
        }
        preferredInferenceApi = await validateOpenAiLikeSelection(
          "Local Ollama",
          getLocalProviderValidationBaseUrl(provider),
          model,
          null,
          "Choose a different Ollama model or select Other."
        );
        if (!preferredInferenceApi) {
          continue;
        }
        break;
      }
      break;
    } else if (selected.key === "vllm") {
      console.log("  ✓ Using existing vLLM on localhost:8000");
      provider = "vllm-local";
      credentialEnv = "OPENAI_API_KEY";
      endpointUrl = getLocalProviderBaseUrl(provider);
      // Query vLLM for the actual model ID
      const vllmModelsRaw = runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", { ignoreError: true });
      try {
        const vllmModels = JSON.parse(vllmModelsRaw);
        if (vllmModels.data && vllmModels.data.length > 0) {
          model = vllmModels.data[0].id;
          if (!isSafeModelId(model)) {
            console.error(`  Detected model ID contains invalid characters: ${model}`);
            process.exit(1);
          }
          console.log(`  Detected model: ${model}`);
        } else {
          console.error("  Could not detect model from vLLM. Please specify manually.");
          process.exit(1);
        }
      } catch {
        console.error("  Could not query vLLM models endpoint. Is vLLM running on localhost:8000?");
        process.exit(1);
      }
      preferredInferenceApi = await validateOpenAiLikeSelection(
        "Local vLLM",
        getLocalProviderValidationBaseUrl(provider),
        model,
        credentialEnv
      );
      if (!preferredInferenceApi) {
        continue selectionLoop;
      }
      break;
    }
  }
  }

  return { model, provider, endpointUrl, credentialEnv, preferredInferenceApi, nimContainer };
}

// ── Step 5: Inference provider ───────────────────────────────────

async function setupInference(sandboxName, model, provider, endpointUrl = null, credentialEnv = null) {
  step(4, 7, "Setting up inference provider");
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

  if (provider === "nvidia-prod" || provider === "nvidia-nim" || provider === "openai-api" || provider === "anthropic-prod" || provider === "compatible-anthropic-endpoint" || provider === "gemini-api" || provider === "compatible-endpoint") {
    const config = provider === "nvidia-nim"
      ? REMOTE_PROVIDER_CONFIG.build
      : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider);
    const resolvedCredentialEnv = credentialEnv || (config && config.credentialEnv);
    const resolvedEndpointUrl = endpointUrl || (config && config.endpointUrl);
    const env = resolvedCredentialEnv ? { [resolvedCredentialEnv]: process.env[resolvedCredentialEnv] } : {};
    upsertProvider(provider, config.providerType, resolvedCredentialEnv, resolvedEndpointUrl, env);
    const args = ["inference", "set"];
    if (config.skipVerify) {
      args.push("--no-verify");
    }
    args.push("--provider", provider, "--model", model);
    runOpenshell(args);
  } else if (provider === "vllm-local") {
    const validation = validateLocalProvider(provider, runCapture);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    upsertProvider("vllm-local", "openai", "OPENAI_API_KEY", baseUrl, {
      OPENAI_API_KEY: "dummy",
    });
    runOpenshell(["inference", "set", "--no-verify", "--provider", "vllm-local", "--model", model]);
  } else if (provider === "ollama-local") {
    const validation = validateLocalProvider(provider, runCapture);
    if (!validation.ok) {
      console.error(`  ${validation.message}`);
      console.error("  On macOS, local inference also depends on OpenShell host routing support.");
      process.exit(1);
    }
    const baseUrl = getLocalProviderBaseUrl(provider);
    upsertProvider("ollama-local", "openai", "OPENAI_API_KEY", baseUrl, {
      OPENAI_API_KEY: "ollama",
    });
    runOpenshell(["inference", "set", "--no-verify", "--provider", "ollama-local", "--model", model]);
    console.log(`  Priming Ollama model: ${model}`);
    run(getOllamaWarmupCommand(model), { ignoreError: true });
    const probe = validateOllamaModel(model, runCapture);
    if (!probe.ok) {
      console.error(`  ${probe.message}`);
      process.exit(1);
    }
  }

  verifyInferenceRoute(provider, model);
  registry.updateSandbox(sandboxName, { model, provider });
  console.log(`  ✓ Inference route set: ${provider} / ${model}`);
}

// ── Step 6: OpenClaw ─────────────────────────────────────────────

async function setupOpenclaw(sandboxName, model, provider) {
  step(6, 7, "Setting up OpenClaw inside sandbox");

  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    const scriptFile = writeSandboxConfigSyncFile(script);
    try {
      run(
        `${openshellShellCommand(["sandbox", "connect", sandboxName])} < ${shellQuote(scriptFile)}`,
        { stdio: ["ignore", "ignore", "inherit"] }
      );
    } finally {
      fs.unlinkSync(scriptFile);
    }
  }

  console.log("  ✓ OpenClaw gateway launched inside sandbox");
}

// ── Step 7: Policy presets ───────────────────────────────────────

async function setupPolicies(sandboxName) {
  step(7, 7, "Policy presets");

  const suggestions = ["pypi", "npm"];

  // Auto-detect based on env tokens
  if (getCredential("TELEGRAM_BOT_TOKEN")) {
    suggestions.push("telegram");
    console.log("  Auto-detected: TELEGRAM_BOT_TOKEN → suggesting telegram preset");
  }
  if (getCredential("SLACK_BOT_TOKEN") || process.env.SLACK_BOT_TOKEN) {
    suggestions.push("slack");
    console.log("  Auto-detected: SLACK_BOT_TOKEN → suggesting slack preset");
  }
  if (getCredential("DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN) {
    suggestions.push("discord");
    console.log("  Auto-detected: DISCORD_BOT_TOKEN → suggesting discord preset");
  }

  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  if (isNonInteractive()) {
    const policyMode = (process.env.NEMOCLAW_POLICY_MODE || "suggested").trim().toLowerCase();
    let selectedPresets = suggestions;

    if (policyMode === "skip" || policyMode === "none" || policyMode === "no") {
      note("  [non-interactive] Skipping policy presets.");
      return;
    }

    if (policyMode === "custom" || policyMode === "list") {
      selectedPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (selectedPresets.length === 0) {
        console.error("  NEMOCLAW_POLICY_PRESETS is required when NEMOCLAW_POLICY_MODE=custom.");
        process.exit(1);
      }
    } else if (policyMode === "suggested" || policyMode === "default" || policyMode === "auto") {
      const envPresets = parsePolicyPresetEnv(process.env.NEMOCLAW_POLICY_PRESETS);
      if (envPresets.length > 0) {
        selectedPresets = envPresets;
      }
    } else {
      console.error(`  Unsupported NEMOCLAW_POLICY_MODE: ${policyMode}`);
      console.error("  Valid values: suggested, custom, skip");
      process.exit(1);
    }

    const knownPresets = new Set(allPresets.map((p) => p.name));
    const invalidPresets = selectedPresets.filter((name) => !knownPresets.has(name));
    if (invalidPresets.length > 0) {
      console.error(`  Unknown policy preset(s): ${invalidPresets.join(", ")}`);
      process.exit(1);
    }

    if (!waitForSandboxReady(sandboxName)) {
      console.error(`  Sandbox '${sandboxName}' was not ready for policy application.`);
      process.exit(1);
    }
    note(`  [non-interactive] Applying policy presets: ${selectedPresets.join(", ")}`);
    for (const name of selectedPresets) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          policies.applyPreset(sandboxName, name);
          break;
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          if (message.includes("Unimplemented")) {
            console.error("  OpenShell policy updates are not supported by this gateway build.");
            console.error("  This is a known issue tracked in NemoClaw #536.");
            throw err;
          }
          if (!message.includes("sandbox not found") || attempt === 2) {
            throw err;
          }
          sleep(2);
        }
      }
    }
  } else {
    console.log("");
    console.log("  Available policy presets:");
    allPresets.forEach((p) => {
      const marker = applied.includes(p.name) ? "●" : "○";
      const suggested = suggestions.includes(p.name) ? " (suggested)" : "";
      console.log(`    ${marker} ${p.name} — ${p.description}${suggested}`);
    });
    console.log("");

    const answer = await prompt(`  Apply suggested presets (${suggestions.join(", ")})? [Y/n/list]: `);

    if (answer.toLowerCase() === "n") {
      console.log("  Skipping policy presets.");
      return;
    }

    if (answer.toLowerCase() === "list") {
      // Let user pick
      const picks = await prompt("  Enter preset names (comma-separated): ");
      const selected = picks.split(",").map((s) => s.trim()).filter(Boolean);
      for (const name of selected) {
        try {
          policies.applyPreset(sandboxName, name);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          if (message.includes("Unimplemented")) {
            console.error("  OpenShell policy updates are not supported by this gateway build.");
            console.error("  This is a known issue tracked in NemoClaw #536.");
          }
          throw err;
        }
      }
    } else {
      // Apply suggested
      for (const name of suggestions) {
        try {
          policies.applyPreset(sandboxName, name);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          if (message.includes("Unimplemented")) {
            console.error("  OpenShell policy updates are not supported by this gateway build.");
            console.error("  This is a known issue tracked in NemoClaw #536.");
          }
          throw err;
        }
      }
    }
  }

  console.log("  ✓ Policies applied");
}

// ── Dashboard ────────────────────────────────────────────────────

function printDashboard(sandboxName, model, provider, nimContainer = null) {
  const nimStat = nimContainer ? nim.nimStatusByName(nimContainer) : nim.nimStatus(sandboxName);
  const nimLabel = nimStat.running ? "running" : "not running";

  let providerLabel = provider;
  if (provider === "nvidia-prod" || provider === "nvidia-nim") providerLabel = "NVIDIA Endpoints";
  else if (provider === "openai-api") providerLabel = "OpenAI";
  else if (provider === "anthropic-prod") providerLabel = "Anthropic";
  else if (provider === "compatible-anthropic-endpoint") providerLabel = "Other Anthropic-compatible endpoint";
  else if (provider === "gemini-api") providerLabel = "Google Gemini";
  else if (provider === "compatible-endpoint") providerLabel = "Other OpenAI-compatible endpoint";
  else if (provider === "vllm-local") providerLabel = "Local vLLM";
  else if (provider === "ollama-local") providerLabel = "Local Ollama";

  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  // console.log(`  Dashboard    http://localhost:18789/`);
  console.log(`  Sandbox      ${sandboxName} (Landlock + seccomp + netns)`);
  console.log(`  Model        ${model} (${providerLabel})`);
  console.log(`  NIM          ${nimLabel}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Next:`);
  console.log(`  Run:         nemoclaw ${sandboxName} connect`);
  console.log(`  Status:      nemoclaw ${sandboxName} status`);
  console.log(`  Logs:        nemoclaw ${sandboxName} logs --follow`);
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────

async function onboard(opts = {}) {
  NON_INTERACTIVE = opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  delete process.env.OPENSHELL_GATEWAY;

  console.log("");
  console.log("  NemoClaw Onboarding");
  if (isNonInteractive()) note("  (non-interactive mode)");
  console.log("  ===================");

  const gpu = await preflight();
  const { model, provider, endpointUrl, credentialEnv, preferredInferenceApi, nimContainer } = await setupNim(gpu);
  process.env.NEMOCLAW_OPENSHELL_BIN = getOpenshellBinary();
  await startGateway(gpu);
  await setupInference(GATEWAY_NAME, model, provider, endpointUrl, credentialEnv);
  // The key is now stored in openshell's provider config. Clear it from our
  // process environment so new child processes don't inherit it. Note: this
  // does NOT clear /proc/pid/environ (kernel snapshot is immutable after exec),
  // but it prevents run()'s { ...process.env } from propagating the key.
  delete process.env.NVIDIA_API_KEY;
  const sandboxName = await createSandbox(gpu, model, provider, preferredInferenceApi);
  if (nimContainer) {
    registry.updateSandbox(sandboxName, { nimContainer });
  }
  await setupOpenclaw(sandboxName, model, provider);
  await setupPolicies(sandboxName);
  printDashboard(sandboxName, model, provider, nimContainer);
}

module.exports = {
  buildSandboxConfigSyncScript,
  getFutureShellPathHint,
  createSandbox,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
  hasStaleGateway,
  isSandboxReady,
  onboard,
  pruneStaleSandboxEntry,
  runCaptureOpenshell,
  setupInference,
  setupNim,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
};
