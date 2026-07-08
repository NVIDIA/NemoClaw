// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeProviderBaseUrl } from "../src/lib/core/url-utils.js";
import { resetOllamaHostCache } from "../src/lib/inference/local.js";
import {
  promptCloudModel,
  promptInputModel,
  promptRemoteModel,
} from "../src/lib/inference/model-prompts.js";
import { parseNvidiaFeaturedModels } from "../src/lib/inference/nvidia-featured-models.js";
import {
  applyOllamaRuntimeContextWindow,
  resetOllamaRuntimeContextWindowAutoState,
} from "../src/lib/inference/ollama-runtime-context.js";
import {
  validateAnthropicModel,
  validateOpenAiLikeModel,
} from "../src/lib/inference/provider-models.js";
import { resolveNonInteractiveBuildCredential } from "../src/lib/onboard/build-credential-reuse.js";
import {
  isBackToSelection,
  returningToProviderSelection,
} from "../src/lib/onboard/credential-navigation.js";
import { createInferenceSelectionValidationHelpers } from "../src/lib/onboard/inference-selection-validation.js";
import {
  type InstallOllamaLinuxOptions,
  installOllamaOnLinux,
} from "../src/lib/onboard/install-ollama-linux.js";
import { getWindowsHostOllamaDockerRequirement } from "../src/lib/onboard/local-inference-topology.js";
import {
  assertOllamaUpgradeApplied,
  resolveOllamaInstallMenuEntry,
} from "../src/lib/onboard/ollama-install-menu.js";
import { ensureOllamaLoopbackSystemdOverride } from "../src/lib/onboard/ollama-systemd.js";
import type { InferenceProviderHostState } from "../src/lib/onboard/provider-host-state.js";
import { buildInferenceProviderMenu } from "../src/lib/onboard/provider-menu.js";
import { resolveRequestedProviderSelection } from "../src/lib/onboard/provider-selection.js";
import { reportProviderSelectionFailure } from "../src/lib/onboard/provider-selection-failure.js";
import { createSetupNim, type SetupNimFlowDeps } from "../src/lib/onboard/setup-nim-flow.js";
import { createSetupNimOllamaHandlers } from "../src/lib/onboard/setup-nim-ollama.js";
import {
  createRemoteModelValidator,
  resolveCompatibleEndpointInput,
  type SetupNimSelectionState,
} from "../src/lib/onboard/setup-nim-selection.js";
import { createValidationRecoveryPromptHelpers } from "../src/lib/onboard/validation-recovery-prompt.js";
import { detectWindowsHostOllama } from "../src/lib/onboard/windows-host-ollama.js";
import { getTransportRecoveryMessage } from "../src/lib/validation-recovery.js";

import { testTimeout } from "./helpers/timeouts";
import {
  createWindowsHostOllamaRunCapture,
  requireFailedProviderResolution,
  requirePresent,
  requireSelectedProviderResolution,
  restoreProcessEnvValue,
  runNativeDockerWindowsProviderBoundary,
} from "./support/onboard-selection-test-helpers.js";

const CREDENTIAL_RETRY_PROMPT =
  "  Options: retry (re-enter key), back (change provider), exit [retry]: ";
const CREDENTIAL_RETRY_PROMPT_RE =
  /Options: retry \(re-enter key\), back \(change provider\), exit \[retry\]: /;
const OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE =
  '{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}';
const PROVIDER_SELECTION_TEST_TIMEOUT_MS = testTimeout(60_000);

const TEST_REMOTE_PROVIDER_CONFIG = {
  build: { label: "NVIDIA Endpoints", providerName: "nvidia-prod" },
  openai: { label: "OpenAI", providerName: "openai-api" },
  custom: {
    label: "Other OpenAI-compatible endpoint",
    providerName: "compatible-endpoint",
  },
  anthropic: { label: "Anthropic", providerName: "anthropic-prod" },
  anthropicCompatible: {
    label: "Other Anthropic-compatible endpoint",
    providerName: "compatible-anthropic-endpoint",
  },
  gemini: { label: "Google Gemini", providerName: "gemini-api" },
};

const TEST_SETUP_NIM_REMOTE_PROVIDER_CONFIG: SetupNimFlowDeps["remoteProviderConfig"] = {
  build: {
    ...TEST_REMOTE_PROVIDER_CONFIG.build,
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  },
  openai: {
    ...TEST_REMOTE_PROVIDER_CONFIG.openai,
    endpointUrl: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
  },
  custom: {
    ...TEST_REMOTE_PROVIDER_CONFIG.custom,
    endpointUrl: "",
    credentialEnv: "COMPATIBLE_API_KEY",
  },
  anthropic: {
    ...TEST_REMOTE_PROVIDER_CONFIG.anthropic,
    endpointUrl: "https://api.anthropic.com",
    credentialEnv: "ANTHROPIC_API_KEY",
  },
  anthropicCompatible: {
    ...TEST_REMOTE_PROVIDER_CONFIG.anthropicCompatible,
    endpointUrl: "",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
  },
  gemini: {
    ...TEST_REMOTE_PROVIDER_CONFIG.gemini,
    endpointUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    credentialEnv: "GEMINI_API_KEY",
  },
};

type WindowsRequirement = ReturnType<typeof getWindowsHostOllamaDockerRequirement>;
type ProviderMenuOverrides = Partial<Parameters<typeof buildInferenceProviderMenu>[0]>;
type SetupNimOllamaDeps = Parameters<typeof createSetupNimOllamaHandlers>[0];
type RemoteModelValidatorDeps = Parameters<typeof createRemoteModelValidator>[0];

function unexpected(name: string): never {
  throw new Error(`Unexpected ${name} call`);
}

function makeSetupNimHostState(
  overrides: Partial<InferenceProviderHostState> = {},
): InferenceProviderHostState {
  return {
    hasOllama: false,
    ollamaHost: null,
    ollamaRunning: false,
    isWindowsHostOllama: false,
    isWsl: false,
    hasWindowsOllama: false,
    winOllamaInstalledPath: "",
    winOllamaLoopbackOnly: false,
    windowsOllamaReachable: false,
    windowsHostOllamaDockerRequirement: getWindowsHostOllamaDockerRequirement(null),
    vllmRunning: false,
    vllmProfile: null,
    hasVllmImage: false,
    vllmEntries: [],
    ollamaInstallMenu: { entry: null, hasUpgradableOllama: false },
    gpuNimCapable: false,
    ...overrides,
  };
}

function makeSetupNimFlowDeps(overrides: Partial<SetupNimFlowDeps> = {}): SetupNimFlowDeps {
  return {
    remoteProviderConfig: TEST_SETUP_NIM_REMOTE_PROVIDER_CONFIG,
    experimental: false,
    ollamaPort: 11434,
    vllmPort: 8000,
    step: () => {},
    isNonInteractive: () => false,
    getNonInteractiveProvider: () => null,
    getNonInteractiveModel: () => null,
    createNvidiaFeaturedModelSession: () => ({
      select: async () => unexpected("featured model selection"),
    }),
    detectInferenceProviderHostState: () => makeSetupNimHostState(),
    getAgentInferenceProviderOptions: () => [],
    loadRoutedProfile: () => null,
    readRecordedProvider: () => null,
    readRecordedNimContainer: () => null,
    readRecordedModel: () => null,
    rejectWindowsHostOllama: () => false,
    prompt: async () => "",
    selectFromNumberedMenu: (rawChoice, defaultIndex, options) => {
      const index = Number(rawChoice || defaultIndex) - 1;
      return options[index] ?? unexpected(`provider menu choice ${rawChoice}`);
    },
    note: () => {},
    log: () => {},
    error: () => {},
    exitProcess: (code) => unexpected(`exitProcess(${code})`),
    abortNonInteractive: (message) => unexpected(`abortNonInteractive(${message})`),
    handleRemoteProviderSelection: async () => unexpected("remote provider selection"),
    handleNimLocalSelection: async () => unexpected("local NIM selection"),
    handleRunningOllamaSelection: async () => unexpected("running Ollama selection"),
    handleWindowsHostOllamaSelection: async () => unexpected("Windows Ollama selection"),
    handleInstallOllamaSelection: async () => unexpected("Ollama install selection"),
    installVllm: async () => unexpected("vLLM install"),
    handleVllmSelection: async () => unexpected("vLLM selection"),
    handleRoutedSelection: async () => unexpected("routed selection"),
    coerceAgentInferenceApi: (_agent, preferredInferenceApi) => preferredInferenceApi,
    resolveAgentInferenceApi: (_agentName, _provider, preferredInferenceApi) =>
      preferredInferenceApi,
    clearCompatibleEndpointReasoning: () => null,
    maybePromptForInferenceInputCapability: async () => {},
    ...overrides,
  };
}
function makeInstallOllamaLinuxOptions(
  overrides: Partial<InstallOllamaLinuxOptions> = {},
): InstallOllamaLinuxOptions {
  return {
    isNonInteractive: () => false,
    getEuid: () => 1000,
    isTty: () => true,
    homedir: () => "/home/test",
    arch: () => "arm64",
    canSudoNonInteractive: () => false,
    runCaptureImpl: vi.fn().mockReturnValue(""),
    runCaptureExImpl: vi
      .fn()
      .mockReturnValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    runShellImpl: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null }),
    waitForHttpImpl: vi.fn().mockReturnValue(true),
    sleepSecondsImpl: vi.fn(),
    ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("ready"),
    fileExistsImpl: vi.fn().mockReturnValue(false),
    readFileImpl: vi.fn().mockReturnValue(""),
    log: vi.fn(),
    errorLog: vi.fn(),
    ...overrides,
  };
}
function successfulRunShellResult(): ReturnType<
  NonNullable<InstallOllamaLinuxOptions["runShellImpl"]>
> {
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  };
}

const TEST_OPENAI_ENDPOINT_URL = "https://api.openai.com/v1";
const TEST_ANTHROPIC_ENDPOINT_URL = "https://api.anthropic.com";
const TEST_CUSTOM_OPENAI_CONFIG = {
  label: "Other OpenAI-compatible endpoint",
  endpointUrl: TEST_OPENAI_ENDPOINT_URL,
  helpUrl: null,
};
// Shared expected 4th arg for probeOpenAiLikeEndpoint; pinnedAddresses is what
// the injected resolveEndpointHost returns via the SSRF preflight (#6293).
const EXPECTED_CUSTOM_ENDPOINT_PROBE_OPTIONS = {
  requireResponsesToolCalling: true,
  skipResponsesProbe: false,
  probeStreaming: true,
  pinnedAddresses: ["93.184.216.34"],
};
const TEST_CUSTOM_ANTHROPIC_CONFIG = {
  label: "Other Anthropic-compatible endpoint",
  endpointUrl: TEST_ANTHROPIC_ENDPOINT_URL,
  helpUrl: null,
};
const TEST_ANTHROPIC_CONFIG = {
  label: "Anthropic",
  endpointUrl: TEST_ANTHROPIC_ENDPOINT_URL,
  helpUrl: null,
};
const TEST_NVIDIA_FEATURED_MODELS = parseNvidiaFeaturedModels(
  JSON.stringify({
    "featured-models": [
      {
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        "model-name": "Nemotron 3 Ultra 550B",
      },
      {
        model: "nemotron-3-super-120b-a12b",
        "model-name": "Nemotron 3 Super 120B",
      },
      { model: "z-ai/glm-5.1", "model-name": "GLM 5.1" },
      { model: "moonshotai/kimi-k2.6", "model-name": "Kimi K2.6" },
      { model: "minimaxai/minimax-m2.7", "model-name": "Minimax M2.7" },
    ],
  }),
);

function makeRemoteSelectionState(
  overrides: Partial<SetupNimSelectionState> = {},
): SetupNimSelectionState {
  return {
    model: "test-model",
    provider: "compatible-endpoint",
    endpointUrl: "https://proxy.example.com/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    allowToolsIncompatible: false,
    skipHostInferenceSmoke: false,
    ...overrides,
  };
}

function makeRemoteModelValidatorDeps(
  overrides: Partial<RemoteModelValidatorDeps> = {},
): RemoteModelValidatorDeps {
  return {
    OPENAI_ENDPOINT_URL: TEST_OPENAI_ENDPOINT_URL,
    ANTHROPIC_ENDPOINT_URL: TEST_ANTHROPIC_ENDPOINT_URL,
    requireValue: requirePresent,
    isBackToSelection: (_value): _value is never => false,
    validateCustomOpenAiLikeSelection: async () => ({
      ok: true as const,
      api: "openai-completions",
    }),
    validateCustomAnthropicSelection: async () => ({
      ok: true as const,
      api: "anthropic-messages",
    }),
    validateAnthropicSelectionWithRetryMessage: async () => ({
      ok: true as const,
      api: "anthropic-messages",
    }),
    validateOpenAiLikeSelection: async () => ({
      ok: true as const,
      api: "openai-completions",
    }),
    shouldRequireResponsesToolCalling: () => false,
    shouldSkipResponsesProbe: () => false,
    getProbeAuthMode: () => undefined,
    ...overrides,
  };
}

function makeInteractiveValidationRecovery() {
  return createValidationRecoveryPromptHelpers({
    isNonInteractive: () => false,
    prompt: async () => "",
    validateNvidiaApiKeyValue: () => null,
    getTransportRecoveryMessage: () => "  Validation hit a network or transport error.",
    exitOnboardFromPrompt(): never {
      throw new Error("Unexpected onboarding exit");
    },
  });
}

async function captureConsoleOutput<T>(callback: () => Promise<T>): Promise<{
  result: T;
  lines: string[];
}> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...args) => {
    lines.push(args.join(" "));
  });
  try {
    return { result: await callback(), lines };
  } finally {
    error.mockRestore();
    log.mockRestore();
  }
}

function buildProviderMenu(overrides: ProviderMenuOverrides = {}) {
  return buildInferenceProviderMenu({
    remoteProviderConfig: TEST_REMOTE_PROVIDER_CONFIG,
    agentProviderOptions: [],
    experimental: false,
    gpuNimCapable: false,
    hasOllama: false,
    ollamaRunning: false,
    ollamaHost: null,
    ollamaPort: 11434,
    isWsl: false,
    hasWindowsOllama: false,
    isWindowsHostOllama: false,
    windowsHostLabelSuffix: "",
    windowsHostInstallLabel: "Install Ollama on Windows host (recommended)",
    windowsHostStartLabel: () => "Start Ollama on Windows host (suggested)",
    windowsOllamaReachable: false,
    winOllamaLoopbackOnly: false,
    ollamaInstallEntry: null,
    vllmEntries: [],
    routedEnabled: false,
    ...overrides,
  });
}

function buildWindowsProviderMenu(
  requirement: WindowsRequirement,
  overrides: ProviderMenuOverrides = {},
) {
  return buildProviderMenu({
    isWsl: true,
    windowsHostLabelSuffix: requirement.supported ? "" : requirement.labelSuffix,
    windowsHostInstallLabel: requirement.installLabel,
    windowsHostStartLabel: requirement.startLabel,
    ...overrides,
  });
}

function resolveWindowsProvider(
  options: Array<{ key: string; label: string }>,
  requestedProvider: string,
  overrides: Partial<Parameters<typeof resolveRequestedProviderSelection>[0]> = {},
) {
  return resolveRequestedProviderSelection({
    options,
    requestedProvider,
    sandboxName: null,
    remoteProviderConfig: TEST_REMOTE_PROVIDER_CONFIG,
    isWsl: true,
    isWindowsHostOllama: false,
    windowsHostOllamaSupported: true,
    hermesProviderAvailable: false,
    readRecordedProvider: () => null,
    readRecordedNimContainer: () => null,
    readRecordedModel: () => null,
    ...overrides,
  });
}

function makeOllamaSelectionState(): SetupNimSelectionState {
  return {
    model: null,
    provider: "nvidia-prod",
    endpointUrl: null,
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    allowToolsIncompatible: false,
    skipHostInferenceSmoke: false,
  };
}

function makeSetupNimOllamaDeps(overrides: Partial<SetupNimOllamaDeps> = {}): SetupNimOllamaDeps {
  const processStub = {
    platform: "linux",
    exit(code?: number): never {
      throw new Error(`Unexpected process.exit(${String(code)})`);
    },
  } as NodeJS.Process;
  return {
    OLLAMA_PORT: 11434,
    OLLAMA_PROXY_PORT: 11435,
    process: processStub,
    isNonInteractive: () => true,
    prompt: async () => "",
    checkOllamaPortsOrWarn: () => true,
    ensureOllamaLoopbackSystemdOverride: () => "not-applicable",
    runOllamaStartupOrGate: () => ({ kind: "ready" }),
    shouldFrontOllamaWithProxy: () => false,
    startOllamaAuthProxy: () => true,
    getLocalProviderBaseUrl: () => "http://host.docker.internal:11434/v1",
    selectAndValidateOllamaModel: async () => ({
      outcome: "selected",
      model: "qwen3:8b",
      allowToolsIncompatible: false,
    }),
    printOllamaExposureWarning: () => {},
    switchToWindowsOllamaHost: () => {},
    installOllamaOnWindowsHost: async () => ({ ok: true }),
    awaitWindowsOllamaReady: () => true,
    setupWindowsOllamaWith0000Binding: () => true,
    printWindowsOllamaTimeoutDiagnostics: () => {},
    resetOllamaHostCache: () => {},
    installOllamaOnMacOS: () => ({ ok: true }),
    installOllamaOnLinux: () => ({ ok: true }),
    abortNonInteractive(message: string): never {
      throw new Error(message);
    },
    assertOllamaUpgradeApplied: () => ({ ok: true }),
    ...overrides,
  };
}

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

type ProcessCredentialBackScenario = {
  name: string;
  label: string;
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

const PROCESS_CREDENTIAL_BACK_SCENARIOS: readonly ProcessCredentialBackScenario[] = [
  {
    name: "OpenAI",
    label: "OpenAI API key",
    answers: ["2", "back", "1", ""],
    credentialEnv: "OPENAI_API_KEY",
    promptPattern: /OpenAI API key: /,
  },
  {
    name: "Anthropic",
    label: "Anthropic API key",
    answers: ["4", "back", "1", ""],
    credentialEnv: "ANTHROPIC_API_KEY",
    promptPattern: /Anthropic API key: /,
  },
  {
    name: "Anthropic exit",
    label: "Anthropic API key",
    answers: ["4", "exit"],
    credentialEnv: "ANTHROPIC_API_KEY",
    promptPattern: /Anthropic API key: /,
    expectedOutcome: "exit",
  },
  {
    name: "Google Gemini",
    label: "Google Gemini API key",
    answers: ["6", "back", "1", ""],
    credentialEnv: "GEMINI_API_KEY",
    promptPattern: /Google Gemini API key: /,
  },
  {
    name: "Other OpenAI-compatible endpoint",
    label: "Other OpenAI-compatible endpoint API key",
    answers: ["3", "https://proxy.example.com/v1", "back", "1", ""],
    credentialEnv: "COMPATIBLE_API_KEY",
    promptPattern: /Other OpenAI-compatible endpoint API key: /,
  },
  {
    name: "Other Anthropic-compatible endpoint",
    label: "Other Anthropic-compatible endpoint API key",
    answers: ["5", "https://proxy.example.com", "back", "1", ""],
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    promptPattern: /Other Anthropic-compatible endpoint API key: /,
  },
  {
    name: "Model Router",
    label: "Model Router API key",
    answers: ["back", ""],
    menuSelections: ["Model Router", "NVIDIA Endpoints"],
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    promptPattern: /Model Router API key: /,
  },
  {
    name: "Hermes Provider Nous API key",
    label: "Nous API Key",
    answers: ["back", ""],
    menuSelections: ["Hermes Provider", "Nous API Key", "NVIDIA Endpoints"],
    credentialEnv: "NOUS_API_KEY",
    promptPattern: /Nous API Key: /,
    agent: "hermes",
  },
  {
    name: "Local NIM NGC API key",
    label: "NGC API Key",
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

type CredentialBackPayload = {
  name: string;
  outcome: "completed" | "exit";
  result?: { provider?: string };
  exitCode?: number;
  messages: string[];
  prompts: Array<{ message: string; secret: boolean }>;
  lines: string[];
  saved: Array<{ key: string; value: string }>;
  menuSelectionIndex: number;
  credentialValue: string | null;
};

let credentialBackBatchResults: Map<string, CredentialBackPayload> | undefined;

function runCredentialBackScenarioBatch(): Map<string, CredentialBackPayload> {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-credential-back-batch-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "credential-back-batch.js");
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const agentDefsPath = JSON.stringify(path.join(repoRoot, "src", "lib", "agent", "defs.ts"));
  const nimPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "nim.ts"));
  const childScenarios = PROCESS_CREDENTIAL_BACK_SCENARIOS.map(
    ({ promptPattern: _promptPattern, ...scenario }) => scenario,
  );

  fs.mkdirSync(fakeBin, { recursive: true });
  writeAlwaysOkCurl(fakeBin);

  const script = String.raw`
const scenarios = ${JSON.stringify(childScenarios)};
const clearCredentialEnv = [
  "NVIDIA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY", "NOUS_API_KEY",
  "NVIDIA_INFERENCE_API_KEY", "NGC_API_KEY", "NEMOCLAW_PROVIDER_KEY",
];
const clearOnboardControlEnv = [
  "NEMOCLAW_NON_INTERACTIVE", "NEMOCLAW_PROVIDER", "NEMOCLAW_MODEL",
  "NEMOCLAW_YES", "NEMOCLAW_PREFERRED_API", "NEMOCLAW_EXPERIMENTAL",
];
let answers = [];
let menuSelections = [];
let menuSelectionIndex = 0;
let messages = [];
let prompts = [];
let saved = [];
let lines = [];

const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const nim = require(${nimPath});

function selectRecentMenuOption(patternText) {
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
    return selectRecentMenuOption(menuSelections[menuSelectionIndex++]);
  }
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => ({ kind: "credential", value: "nvapi-good" });
const originalSaveCredential = credentials.saveCredential;
credentials.saveCredential = (key, value) => {
  saved.push({ key, value });
  return originalSaveCredential(key, value);
};
runner.runCapture = () => "";

nim.isNgcLoggedIn = () => false;
nim.dockerLoginNgc = () => {
  throw new Error("NGC login should not run after back navigation");
};
nim.pullNimImage = () => {
  throw new Error("NIM image pull should not run after back navigation");
};
nim.startNimContainerByName = () => {
  throw new Error("NIM container startup should not run after back navigation");
};
nim.waitForNimHealth = () => {
  throw new Error("NIM health wait should not run after back navigation");
};

const { setupNim } = require(${onboardPath});
const { loadAgent } = require(${agentDefsPath});
const hostLog = console.log;

async function runScenario(scenario) {
  for (const key of [...clearCredentialEnv, ...clearOnboardControlEnv]) {
    delete process.env[key];
  }
  Object.assign(process.env, scenario.env || {});
  answers = [...scenario.answers];
  menuSelections = [...(scenario.menuSelections || [])];
  menuSelectionIndex = 0;
  messages = [];
  prompts = [];
  saved = [];
  lines = [];

  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  if (scenario.expectedOutcome === "exit") {
    process.exit = (code) => {
      const error = new Error("process.exit:" + code);
      error.exitCode = code;
      throw error;
    };
  }
  try {
    const agent = scenario.agent ? loadAgent(scenario.agent) : null;
    const result = await setupNim(scenario.gpu || null, null, agent);
    return {
      name: scenario.name,
      outcome: "completed",
      result,
      messages,
      prompts,
      lines,
      saved,
      menuSelectionIndex,
      credentialValue: process.env[scenario.credentialEnv] || null,
    };
  } catch (error) {
    if (scenario.expectedOutcome !== "exit" || error.exitCode === undefined) {
      throw error;
    }
    return {
      name: scenario.name,
      outcome: "exit",
      exitCode: error.exitCode,
      messages,
      prompts,
      lines,
      saved,
      menuSelectionIndex,
      credentialValue: process.env[scenario.credentialEnv] || null,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
}

(async () => {
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  hostLog(JSON.stringify(results));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;

  try {
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
      timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
    });

    assert.equal(result.status, 0, result.stderr);
    const payloads = JSON.parse(result.stdout.trim()) as CredentialBackPayload[];
    assert.equal(payloads.length, PROCESS_CREDENTIAL_BACK_SCENARIOS.length);
    return new Map(payloads.map((payload) => [payload.name, payload]));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runCredentialBackScenarioProcess(scenario: ProcessCredentialBackScenario): void {
  const payload = (credentialBackBatchResults ??= runCredentialBackScenarioBatch()).get(
    scenario.name,
  );
  assert.ok(payload, `Missing credential-back payload for ${scenario.name}`);
  assert.equal(payload.menuSelectionIndex, scenario.menuSelections?.length || 0);
  switch (scenario.expectedOutcome) {
    case "exit":
      assert.equal(payload.outcome, "exit");
      assert.equal(payload.exitCode, 1);
      assert.equal(payload.credentialValue, null);
      assert.deepEqual(payload.saved, []);
      assert.ok(payload.lines.some((line) => line.includes("Exiting onboarding.")));
      assert.ok(
        payload.prompts.some((entry) => scenario.promptPattern.test(entry.message) && entry.secret),
      );
      return;
    default:
      assert.equal(payload.outcome, "completed");
      assert.equal(payload.result?.provider, "nvidia-prod");
      assert.ok(payload.lines.some((line) => line.includes("Returning to provider selection.")));
      assert.ok(
        payload.prompts.some((entry) => scenario.promptPattern.test(entry.message) && entry.secret),
      );
      assert.ok(payload.saved.every((entry) => entry.value !== "back"));
      assert.equal(payload.credentialValue, null);
  }
}

type CredentialRetryScenario = {
  label: string;
  selectedKey: "build" | "openai" | "anthropic" | "gemini" | "custom" | "anthropicCompatible";
  state: SetupNimSelectionState;
  credentialEnv: string;
  badCredential: string;
  goodCredential: string;
  successApi: "openai-completions" | "openai-responses" | "anthropic-messages";
  probeKind: "openai" | "anthropic";
  retryAnswer?: string;
  authMode?: "query-param";
};

async function runCredentialRetryScenario(scenario: CredentialRetryScenario) {
  const previousCredential = process.env[scenario.credentialEnv];
  process.env[scenario.credentialEnv] = scenario.badCredential;
  const answers = [scenario.retryAnswer ?? "retry", scenario.goodCredential];
  const prompts: Array<{ message: string; secret: boolean }> = [];
  const probedCredentials: Array<string | null> = [];
  const prompt = async (message: string, options: { secret?: boolean } = {}) => {
    prompts.push({ message, secret: options.secret === true });
    return answers.shift() ?? "";
  };
  const recovery = createValidationRecoveryPromptHelpers({
    isNonInteractive: () => false,
    prompt,
    validateNvidiaApiKeyValue: (value, credentialEnv) =>
      credentialEnv === "NVIDIA_INFERENCE_API_KEY" && !value.startsWith("nvapi-")
        ? "  NVIDIA API key must start with nvapi-."
        : null,
    getTransportRecoveryMessage: () => "  Validation hit a network or transport error.",
    exitOnboardFromPrompt(): never {
      throw new Error("Unexpected onboarding exit");
    },
  });
  const success = {
    ok: true as const,
    api: scenario.successApi,
    label:
      scenario.successApi === "anthropic-messages"
        ? "Anthropic Messages API"
        : scenario.successApi === "openai-responses"
          ? "Responses API"
          : "Chat Completions API",
  };
  const credentialFailure = {
    ok: false as const,
    failures: [{ name: success.label, httpStatus: 403, message: "forbidden" }],
  };
  const probeOpenAiLikeEndpoint = vi.fn(
    (_endpointUrl: string, _model: string, credential: string | null | undefined) => {
      probedCredentials.push(credential ?? null);
      return credential === scenario.goodCredential ? success : credentialFailure;
    },
  );
  const probeAnthropicEndpoint = vi.fn(
    (_endpointUrl: string, _model: string, credential: string | null | undefined) => {
      probedCredentials.push(credential ?? null);
      return credential === scenario.goodCredential ? success : credentialFailure;
    },
  );
  const validation = createInferenceSelectionValidationHelpers({
    isNonInteractive: () => false,
    agentProductName: () => "OpenClaw",
    getCredential: (name) => process.env[name] ?? null,
    probeOpenAiLikeEndpoint,
    probeAnthropicEndpoint,
    promptValidationRecovery: recovery.promptValidationRecovery,
  });
  const { validateSelectedRemoteModel } = createRemoteModelValidator(
    makeRemoteModelValidatorDeps({
      validateOpenAiLikeSelection: validation.validateOpenAiLikeSelection,
      validateAnthropicSelectionWithRetryMessage:
        validation.validateAnthropicSelectionWithRetryMessage,
      validateCustomOpenAiLikeSelection: validation.validateCustomOpenAiLikeSelection,
      validateCustomAnthropicSelection: validation.validateCustomAnthropicSelection,
      getProbeAuthMode: () => scenario.authMode,
    }),
  );
  const remoteConfig = {
    label: scenario.label,
    endpointUrl: scenario.state.endpointUrl ?? "",
    helpUrl: null,
  };

  try {
    const captured = await captureConsoleOutput(async () => {
      const first = await validateSelectedRemoteModel({
        selected: { key: scenario.selectedKey },
        remoteConfig,
        state: scenario.state,
        selectedCredentialEnv: scenario.credentialEnv,
      });
      const second = await validateSelectedRemoteModel({
        selected: { key: scenario.selectedKey },
        remoteConfig,
        state: scenario.state,
        selectedCredentialEnv: scenario.credentialEnv,
      });
      return { first, second };
    });

    assert.deepEqual(captured.result, { first: "retry-model", second: "selected" });
    assert.equal(process.env[scenario.credentialEnv], scenario.goodCredential);
    assert.deepEqual(probedCredentials, [scenario.badCredential, scenario.goodCredential]);
    assert.equal(
      probeOpenAiLikeEndpoint.mock.calls.length,
      scenario.probeKind === "openai" ? 2 : 0,
    );
    assert.equal(
      probeAnthropicEndpoint.mock.calls.length,
      scenario.probeKind === "anthropic" ? 2 : 0,
    );
    assert.ok(
      captured.lines.some((line) => line.includes(`${scenario.label} authorization failed`)),
    );
    assert.ok(prompts.some(({ message }) => CREDENTIAL_RETRY_PROMPT_RE.test(message)));
    assert.ok(prompts.some(({ message }) => message.includes(`${scenario.label} API key: `)));
    assert.deepEqual(
      prompts.find(({ message }) => CREDENTIAL_RETRY_PROMPT_RE.test(message)),
      { message: CREDENTIAL_RETRY_PROMPT, secret: true },
    );
    assert.ok(prompts.every(({ secret }) => secret));
    assert.ok(
      captured.lines.every(
        (line) => !line.includes(scenario.badCredential) && !line.includes(scenario.goodCredential),
      ),
      "credential values must not appear in validation output",
    );
    return { ...captured, prompts, probedCredentials };
  } finally {
    restoreProcessEnvValue(scenario.credentialEnv, previousCredential);
  }
}

describe("onboard provider selection UX", { timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS }, () => {
  it("does not label NVIDIA Endpoints as recommended in the provider list (#6245)", () => {
    const buildOption = buildProviderMenu().options.find((option) => option.key === "build");

    assert.equal(buildOption?.label, "NVIDIA Endpoints");
    assert.doesNotMatch(buildOption?.label || "", /recommended/i);
  });

  it("filters retired Kimi K2.6 from the NVIDIA Endpoints featured model list", async () => {
    const answers = ["3"];
    const messages: string[] = [];
    const lines: string[] = [];
    const model = await promptCloudModel({
      defaultModelId: "nvidia/nemotron-3-super-120b-a12b",
      cloudModelOptions: TEST_NVIDIA_FEATURED_MODELS,
      promptFn: async (message) => {
        messages.push(message);
        return answers.shift() || "";
      },
      writeLine: (line) => lines.push(line),
    });
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
      label: "Chat Completions API",
    }));
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "nvapi-test",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: makeInteractiveValidationRecovery().promptValidationRecovery,
    });
    const state = makeRemoteSelectionState({
      model,
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateOpenAiLikeSelection: validation.validateOpenAiLikeSelection,
      }),
    );
    const validated = await captureConsoleOutput(() =>
      validateSelectedRemoteModel({
        selected: { key: "build" },
        remoteConfig: {
          label: "NVIDIA Endpoints",
          endpointUrl: "https://integrate.api.nvidia.com/v1",
          helpUrl: null,
        },
        state,
        selectedCredentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
    );

    assert.equal(model, "minimaxai/minimax-m3");
    assert.equal(validated.result, "selected");
    assert.equal(state.provider, "nvidia-prod");
    assert.equal(state.preferredInferenceApi, "openai-completions");
    assert.match(messages[0], /Choose model \[2\]/);
    assert.ok(!lines.some((line) => line.includes("Kimi K2.6")));
    assert.ok(!lines.some((line) => line.includes("GLM 5.1")));
    assert.ok(validated.lines.some((line) => line.includes("Chat Completions API available")));
    expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
      "https://integrate.api.nvidia.com/v1",
      "minimaxai/minimax-m3",
      "nvapi-test",
      expect.any(Object),
    );
  });

  it("accepts a manually entered NVIDIA Endpoints model after validating it against /models (#6245)", async () => {
    const answers = ["4", "custom/provider-model"];
    const messages: string[] = [];
    const lines: string[] = [];
    const validateNvidiaEndpointModelFn = vi.fn((model: string) => ({
      ok: model === "custom/provider-model",
    }));
    const model = await promptCloudModel({
      defaultModelId: "nvidia/nemotron-3-super-120b-a12b",
      cloudModelOptions: TEST_NVIDIA_FEATURED_MODELS,
      getCredentialFn: () => "nvapi-test",
      validateNvidiaEndpointModelFn,
      promptFn: async (message) => {
        messages.push(message);
        return answers.shift() || "";
      },
      writeLine: (line) => lines.push(line),
    });
    const state = makeRemoteSelectionState({
      model,
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateOpenAiLikeSelection: async () => ({
          ok: true,
          api: "openai-completions",
        }),
      }),
    );

    assert.equal(
      await validateSelectedRemoteModel({
        selected: { key: "build" },
        remoteConfig: {
          label: "NVIDIA Endpoints",
          endpointUrl: "https://integrate.api.nvidia.com/v1",
          helpUrl: null,
        },
        state,
        selectedCredentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
      "selected",
    );
    assert.equal(state.provider, "nvidia-prod");
    assert.equal(state.model, "custom/provider-model");
    assert.equal(state.preferredInferenceApi, "openai-completions");
    assert.match(messages[0], /Choose model \[2\]/);
    assert.match(messages[1], /NVIDIA Endpoints model id:/);
    assert.ok(lines.some((line) => line.includes("Other...")));
    expect(validateNvidiaEndpointModelFn).toHaveBeenCalledWith(
      "custom/provider-model",
      "nvapi-test",
    );
  });

  it("reprompts for a manual NVIDIA Endpoints model when /models validation rejects it (#6245)", async () => {
    const answers = ["4", "bad/model", "custom/provider-model"];
    const messages: string[] = [];
    const lines: string[] = [];
    const model = await promptCloudModel({
      defaultModelId: "nvidia/nemotron-3-super-120b-a12b",
      cloudModelOptions: TEST_NVIDIA_FEATURED_MODELS,
      getCredentialFn: () => "nvapi-test",
      validateNvidiaEndpointModelFn: (candidate) => ({
        ok: candidate === "custom/provider-model",
        message: `Model '${candidate}' is not available from NVIDIA Endpoints.`,
      }),
      promptFn: async (message) => {
        messages.push(message);
        return answers.shift() || "";
      },
      errorLine: (line) => lines.push(line),
      writeLine: (line) => lines.push(line),
    });

    assert.equal(model, "custom/provider-model");
    assert.equal(
      messages.filter((message) => /NVIDIA Endpoints model id:/.test(message)).length,
      2,
    );
    assert.ok(lines.some((line) => line.includes("is not available from NVIDIA Endpoints")));
  });

  it("shows curated Gemini models and supports Other for manual entry (#6245)", async () => {
    const answers = ["7", "gemini-custom"];
    const messages: string[] = [];
    const lines: string[] = [];
    const model = await promptRemoteModel("Google Gemini", "gemini", "gemini-2.5-flash", null, {
      promptFn: async (message) => {
        messages.push(message);
        return answers.shift() || "";
      },
      writeLine: (line) => lines.push(line),
    });
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: true,
      api: "openai-completions",
      label: "Chat Completions API",
    }));
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "gemini-secret",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: makeInteractiveValidationRecovery().promptValidationRecovery,
    });
    const state = makeRemoteSelectionState({
      model,
      provider: "gemini-api",
      endpointUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      credentialEnv: "GEMINI_API_KEY",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateOpenAiLikeSelection: validation.validateOpenAiLikeSelection,
        getProbeAuthMode: () => "query-param",
      }),
    );
    const validated = await captureConsoleOutput(() =>
      validateSelectedRemoteModel({
        selected: { key: "gemini" },
        remoteConfig: {
          label: "Google Gemini",
          endpointUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          helpUrl: null,
        },
        state,
        selectedCredentialEnv: "GEMINI_API_KEY",
      }),
    );

    assert.equal(validated.result, "selected");
    assert.equal(state.provider, "gemini-api");
    assert.equal(state.model, "gemini-custom");
    assert.equal(state.preferredInferenceApi, "openai-completions");
    assert.match(messages[0], /Choose model \[5\]/);
    assert.match(messages[1], /Google Gemini model id:/);
    assert.ok(lines.some((line) => line.includes("Google Gemini models:")));
    assert.ok(lines.some((line) => line.includes("gemini-2.5-flash")));
    assert.ok(lines.some((line) => line.includes("Other...")));
    assert.ok(validated.lines.some((line) => line.includes("Chat Completions API available")));
    expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "gemini-custom",
      "gemini-secret",
      expect.objectContaining({ authMode: "query-param" }),
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
    const previousContextWindow = process.env.NEMOCLAW_CONTEXT_WINDOW;
    let runtimeModels: Array<{ name: string; context_length: number }> = [];
    const runCapture = () => JSON.stringify({ models: runtimeModels });
    const apply = (model: string) =>
      applyOllamaRuntimeContextWindow(model, () => "127.0.0.1", {
        runCaptureImpl: runCapture,
        logger: { log: () => {}, warn: () => {} },
      });

    try {
      resetOllamaRuntimeContextWindowAutoState();
      delete process.env.NEMOCLAW_CONTEXT_WINDOW;
      runtimeModels = [{ name: "qwen3.6:35b", context_length: 262144 }];
      apply("qwen3.6:35b");
      assert.equal(process.env.NEMOCLAW_CONTEXT_WINDOW, "262144");

      runtimeModels = [{ name: "qwen2.5:7b", context_length: 32768 }];
      apply("qwen2.5:7b");
      assert.equal(process.env.NEMOCLAW_CONTEXT_WINDOW, "32768");

      runtimeModels = [];
      apply("qwen2.5:7b");
      assert.equal(process.env.NEMOCLAW_CONTEXT_WINDOW, undefined);

      resetOllamaRuntimeContextWindowAutoState();
      process.env.NEMOCLAW_CONTEXT_WINDOW = "262144";
      runtimeModels = [{ name: "qwen2.5:7b", context_length: 32768 }];
      apply("qwen2.5:7b");
      assert.equal(process.env.NEMOCLAW_CONTEXT_WINDOW, "262144");

      resetOllamaRuntimeContextWindowAutoState();
      process.env.NEMOCLAW_CONTEXT_WINDOW = "bogus";
      apply("qwen2.5:7b");
      assert.equal(process.env.NEMOCLAW_CONTEXT_WINDOW, "bogus");
    } finally {
      resetOllamaRuntimeContextWindowAutoState();
      restoreProcessEnvValue("NEMOCLAW_CONTEXT_WINDOW", previousContextWindow);
    }
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

  it("rejects unsupported non-interactive sudo mode values", () => {
    const previousMode = process.env.NEMOCLAW_NON_INTERACTIVE_SUDO_MODE;
    process.env.NEMOCLAW_NON_INTERACTIVE_SUDO_MODE = "foo";
    const exitError = new Error("process.exit:1");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw exitError;
    }) as never);
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    try {
      assert.throws(
        () =>
          ensureOllamaLoopbackSystemdOverride({
            platformImpl: () => "linux",
            hasOllamaSystemdUnitImpl: () => true,
            isNonInteractive: () => true,
          }),
        (thrown) => thrown === exitError,
      );
      assert.equal(exit.mock.calls.length, 1);
      assert.match(errors.join("\n"), /Unsupported NEMOCLAW_NON_INTERACTIVE_SUDO_MODE value: foo/);
    } finally {
      error.mockRestore();
      exit.mockRestore();
      restoreProcessEnvValue("NEMOCLAW_NON_INTERACTIVE_SUDO_MODE", previousMode);
    }
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

  it("returns to provider selection when Ollama manual entry chooses back", async () => {
    const answers = ["7", "1"];
    const messages: string[] = [];
    const lines: string[] = [];
    const stateSelections: string[] = [];
    const { handleRunningOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        selectAndValidateOllamaModel: async () => {
          stateSelections.push("ollama-model");
          lines.push("  Returning to provider selection.");
          return { outcome: "back-to-selection" };
        },
      }),
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async ({ selected }, state) => {
        assert.equal(selected.key, "build");
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeSetupNimFlowDeps({
        detectInferenceProviderHostState: () =>
          makeSetupNimHostState({
            hasOllama: true,
            ollamaHost: "127.0.0.1",
            ollamaRunning: true,
          }),
        prompt: async (message) => {
          messages.push(message);
          return answers.shift() ?? "";
        },
        handleRunningOllamaSelection,
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null);

    assert.equal(result.provider, "nvidia-prod");
    assert.ok(lines.some((line) => line.includes("Returning to provider selection.")));
    assert.deepEqual(stateSelections, ["ollama-model"]);
    assert.equal(messages.filter((message) => /Choose \[/.test(message)).length, 2);
    assert.equal(handleRemoteProviderSelection.mock.calls.length, 1);
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

  it("reprompts for an OpenAI Other model when /models validation rejects it", async () => {
    const answers = ["5", "bad-model", "gpt-5.4-mini"];
    const messages: string[] = [];
    const lines: string[] = [];
    const catalogUrls: string[] = [];
    const model = await promptRemoteModel(
      "OpenAI",
      "openai",
      "gpt-5.4",
      (candidate) =>
        validateOpenAiLikeModel("OpenAI", TEST_OPENAI_ENDPOINT_URL, candidate, "sk-test", {
          runCurlProbeImpl: (argv) => {
            catalogUrls.push(argv.at(-1) || "");
            return {
              ok: true,
              httpStatus: 200,
              curlStatus: 0,
              body: JSON.stringify({ data: [{ id: "gpt-5.4" }, { id: "gpt-5.4-mini" }] }),
              stderr: "",
              message: "",
            };
          },
        }),
      {
        promptFn: async (message) => {
          messages.push(message);
          return answers.shift() || "";
        },
        errorLine: (line) => lines.push(line),
        writeLine: (line) => lines.push(line),
      },
    );

    assert.equal(model, "gpt-5.4-mini");
    assert.equal(messages.filter((message) => /OpenAI model id:/.test(message)).length, 2);
    assert.ok(lines.some((line) => line.includes("is not available from OpenAI")));
    assert.deepEqual(catalogUrls, [
      `${TEST_OPENAI_ENDPOINT_URL}/models`,
      `${TEST_OPENAI_ENDPOINT_URL}/models`,
    ]);
  });

  it("reprompts for an Anthropic Other model when /v1/models validation rejects it", async () => {
    const answers = ["4", "claude-bad", "claude-haiku-4-5"];
    const messages: string[] = [];
    const lines: string[] = [];
    const catalogUrls: string[] = [];
    const model = await promptRemoteModel(
      "Anthropic",
      "anthropic",
      "claude-sonnet-4-6",
      (candidate) =>
        validateAnthropicModel(TEST_ANTHROPIC_ENDPOINT_URL, candidate, "anthropic-test", {
          runCurlProbeImpl: (argv) => {
            catalogUrls.push(argv.at(-1) || "");
            return {
              ok: true,
              httpStatus: 200,
              curlStatus: 0,
              body: JSON.stringify({
                data: [{ id: "claude-sonnet-4-6" }, { id: "claude-haiku-4-5" }],
              }),
              stderr: "",
              message: "",
            };
          },
        }),
      {
        promptFn: async (message) => {
          messages.push(message);
          return answers.shift() || "";
        },
        errorLine: (line) => lines.push(line),
        writeLine: (line) => lines.push(line),
      },
    );

    assert.equal(model, "claude-haiku-4-5");
    assert.equal(messages.filter((message) => /Anthropic model id:/.test(message)).length, 2);
    assert.ok(lines.some((line) => line.includes("is not available from Anthropic")));
    assert.deepEqual(catalogUrls, [
      `${TEST_ANTHROPIC_ENDPOINT_URL}/v1/models`,
      `${TEST_ANTHROPIC_ENDPOINT_URL}/v1/models`,
    ]);
  });

  it("returns to provider selection when Anthropic live validation fails interactively", async () => {
    const recovery = makeInteractiveValidationRecovery();
    const probedModels: string[] = [];
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "anthropic-test",
      probeAnthropicEndpoint: (_endpointUrl, model) => {
        probedModels.push(model);
        return model === "claude-haiku-4-5"
          ? { ok: true, api: "anthropic-messages", label: "Anthropic Messages API" }
          : {
              ok: false,
              message: "invalid model",
              failures: [
                { name: "Anthropic Messages API", httpStatus: 400, message: "invalid model" },
              ],
            };
      },
      promptValidationRecovery: recovery.promptValidationRecovery,
    });
    const state = makeRemoteSelectionState({
      model: "claude-sonnet-4-6",
      provider: "anthropic-prod",
      endpointUrl: TEST_ANTHROPIC_ENDPOINT_URL,
      credentialEnv: "ANTHROPIC_API_KEY",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateAnthropicSelectionWithRetryMessage:
          validation.validateAnthropicSelectionWithRetryMessage,
      }),
    );

    const { result, lines } = await captureConsoleOutput(async () => {
      const first = await validateSelectedRemoteModel({
        selected: { key: "anthropic" },
        remoteConfig: TEST_ANTHROPIC_CONFIG,
        state,
        selectedCredentialEnv: "ANTHROPIC_API_KEY",
      });
      state.model = "claude-haiku-4-5";
      const second = await validateSelectedRemoteModel({
        selected: { key: "anthropic" },
        remoteConfig: TEST_ANTHROPIC_CONFIG,
        state,
        selectedCredentialEnv: "ANTHROPIC_API_KEY",
      });
      return { first, second };
    });

    assert.deepEqual(result, { first: "retry-selection", second: "selected" });
    assert.equal(state.provider, "anthropic-prod");
    assert.equal(state.model, "claude-haiku-4-5");
    assert.equal(state.preferredInferenceApi, "anthropic-messages");
    assert.deepEqual(probedModels, ["claude-sonnet-4-6", "claude-haiku-4-5"]);
    assert.ok(lines.some((line) => line.includes("Anthropic endpoint validation failed")));
    assert.ok(lines.some((line) => line.includes("Please choose a provider/model again")));
  });

  it("supports Other Anthropic-compatible endpoint with live validation", async () => {
    const messages: string[] = [];
    const endpointInput = await resolveCompatibleEndpointInput({
      kind: "anthropic",
      envUrl: null,
      recoveredEndpointUrl: null,
      nonInteractive: false,
      prompt: async (message) => {
        messages.push(message);
        return "https://proxy.example.com/v1/messages?token=secret#frag";
      },
    });
    const endpointUrl = normalizeProviderBaseUrl(endpointInput, "anthropic");
    const model = await promptInputModel(
      TEST_CUSTOM_ANTHROPIC_CONFIG.label,
      "claude-sonnet-4-6",
      null,
      {
        promptFn: async (message) => {
          messages.push(message);
          return "claude-sonnet-proxy";
        },
      },
    );
    assert.equal(model, "claude-sonnet-proxy");
    const recovery = makeInteractiveValidationRecovery();
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "proxy-key",
      probeAnthropicEndpoint: () => ({
        ok: true,
        api: "anthropic-messages",
        label: "Anthropic Messages API",
      }),
      promptValidationRecovery: recovery.promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const state = makeRemoteSelectionState({
      model,
      provider: "compatible-anthropic-endpoint",
      endpointUrl,
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateCustomAnthropicSelection: validation.validateCustomAnthropicSelection,
      }),
    );

    const { result, lines } = await captureConsoleOutput(() =>
      validateSelectedRemoteModel({
        selected: { key: "anthropicCompatible" },
        remoteConfig: TEST_CUSTOM_ANTHROPIC_CONFIG,
        state,
        selectedCredentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      }),
    );

    assert.equal(result, "selected");
    assert.equal(state.provider, "compatible-anthropic-endpoint");
    assert.equal(state.model, "claude-sonnet-proxy");
    assert.equal(state.endpointUrl, "https://proxy.example.com");
    assert.equal(state.preferredInferenceApi, "anthropic-messages");
    assert.match(messages[0], /Anthropic-compatible base URL/);
    assert.match(messages[1], /Other Anthropic-compatible endpoint model/);
    assert.ok(lines.some((line) => line.includes("Anthropic Messages API available")));
  });

  it("reprompts only for model name when Other OpenAI-compatible endpoint validation fails", async () => {
    const messages: string[] = [];
    const modelAnswers = ["bad-model", "good-model"];
    const endpointInput = await resolveCompatibleEndpointInput({
      kind: "openai",
      envUrl: null,
      recoveredEndpointUrl: null,
      nonInteractive: false,
      prompt: async (message) => {
        messages.push(message);
        return "https://proxy.example.com/v1/chat/completions?token=secret#frag";
      },
    });
    const state = makeRemoteSelectionState({
      endpointUrl: normalizeProviderBaseUrl(endpointInput, "openai"),
    });
    const recovery = makeInteractiveValidationRecovery();
    const probedModels: string[] = [];
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "proxy-key",
      probeOpenAiLikeEndpoint: (_endpointUrl, model) => {
        probedModels.push(model);
        return model === "good-model"
          ? { ok: true, api: "openai-responses", label: "Responses API" }
          : {
              ok: false,
              message: "bad model",
              failures: [{ name: "Responses API", httpStatus: 400, message: "bad model" }],
            };
      },
      promptValidationRecovery: recovery.promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateCustomOpenAiLikeSelection: validation.validateCustomOpenAiLikeSelection,
      }),
    );
    const promptModel = () =>
      promptInputModel(TEST_CUSTOM_OPENAI_CONFIG.label, "custom-model", null, {
        promptFn: async (message) => {
          messages.push(message);
          return modelAnswers.shift() || "";
        },
      });

    const { result, lines } = await captureConsoleOutput(async () => {
      state.model = await promptModel();
      const first = await validateSelectedRemoteModel({
        selected: { key: "custom" },
        remoteConfig: TEST_CUSTOM_OPENAI_CONFIG,
        state,
        selectedCredentialEnv: "COMPATIBLE_API_KEY",
      });
      state.model = await promptModel();
      const second = await validateSelectedRemoteModel({
        selected: { key: "custom" },
        remoteConfig: TEST_CUSTOM_OPENAI_CONFIG,
        state,
        selectedCredentialEnv: "COMPATIBLE_API_KEY",
      });
      return { first, second };
    });

    assert.deepEqual(result, { first: "retry-model", second: "selected" });
    assert.equal(state.provider, "compatible-endpoint");
    assert.equal(state.model, "good-model");
    assert.equal(state.endpointUrl, "https://proxy.example.com/v1");
    assert.equal(state.preferredInferenceApi, "openai-completions");
    assert.deepEqual(probedModels, ["bad-model", "good-model"]);
    assert.ok(
      lines.some((line) =>
        line.includes("Other OpenAI-compatible endpoint endpoint validation failed"),
      ),
    );
    assert.ok(
      lines.some((line) =>
        line.includes("Please enter a different Other OpenAI-compatible endpoint model name."),
      ),
    );
    assert.equal(
      messages.filter((message) => /OpenAI-compatible base URL/.test(message)).length,
      1,
    );
    assert.equal(
      messages.filter((message) => /Other OpenAI-compatible endpoint model/.test(message)).length,
      2,
    );
  });

  it("forces chat completions for custom OpenAI-compatible endpoints even when /responses returns valid tool calls (#1932)", async () => {
    const previousPreferredApi = process.env.NEMOCLAW_PREFERRED_API;
    delete process.env.NEMOCLAW_PREFERRED_API;
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: true,
      api: "openai-responses",
      label: "Responses API",
    }));
    const recovery = makeInteractiveValidationRecovery();
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "ollama-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: recovery.promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const state = makeRemoteSelectionState({
      model: "my-model",
      endpointUrl: "https://ollama.public.test:11434/v1",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateCustomOpenAiLikeSelection: validation.validateCustomOpenAiLikeSelection,
      }),
    );

    try {
      const { result, lines } = await captureConsoleOutput(() =>
        validateSelectedRemoteModel({
          selected: { key: "custom" },
          remoteConfig: TEST_CUSTOM_OPENAI_CONFIG,
          state,
          selectedCredentialEnv: "COMPATIBLE_API_KEY",
        }),
      );

      assert.equal(result, "selected");
      assert.equal(state.provider, "compatible-endpoint");
      assert.equal(state.model, "my-model");
      assert.equal(state.preferredInferenceApi, "openai-completions");
      assert.ok(lines.some((line) => line.includes("Using chat completions API")));
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
        "https://ollama.public.test:11434/v1",
        "my-model",
        "ollama-key",
        EXPECTED_CUSTOM_ENDPOINT_PROBE_OPTIONS,
      );
    } finally {
      restoreProcessEnvValue("NEMOCLAW_PREFERRED_API", previousPreferredApi);
    }
  });

  it("honors NEMOCLAW_PREFERRED_API=openai-responses override for custom OpenAI-compatible endpoints (#1932)", async () => {
    const previousPreferredApi = process.env.NEMOCLAW_PREFERRED_API;
    process.env.NEMOCLAW_PREFERRED_API = "openai-responses";
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: true,
      api: "openai-responses",
      label: "Responses API",
    }));
    const recovery = makeInteractiveValidationRecovery();
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "sk-test",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: recovery.promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const state = makeRemoteSelectionState({
      model: "gpt-4o",
      endpointUrl: "https://openai-proxy.example.com/v1",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateCustomOpenAiLikeSelection: validation.validateCustomOpenAiLikeSelection,
      }),
    );

    try {
      const { result, lines } = await captureConsoleOutput(() =>
        validateSelectedRemoteModel({
          selected: { key: "custom" },
          remoteConfig: TEST_CUSTOM_OPENAI_CONFIG,
          state,
          selectedCredentialEnv: "COMPATIBLE_API_KEY",
        }),
      );

      assert.equal(result, "selected");
      assert.equal(state.provider, "compatible-endpoint");
      assert.equal(state.model, "gpt-4o");
      assert.equal(state.preferredInferenceApi, "openai-responses");
      assert.ok(
        !lines.some((line) =>
          line.includes("compatible endpoints may not support the Responses API developer role"),
        ),
      );
      expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
        "https://openai-proxy.example.com/v1",
        "gpt-4o",
        "sk-test",
        EXPECTED_CUSTOM_ENDPOINT_PROBE_OPTIONS,
      );
    } finally {
      restoreProcessEnvValue("NEMOCLAW_PREFERRED_API", previousPreferredApi);
    }
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

  it("reprompts only for model name when Other Anthropic-compatible endpoint validation fails", async () => {
    const messages: string[] = [];
    const modelAnswers = ["bad-claude", "good-claude"];
    const endpointInput = await resolveCompatibleEndpointInput({
      kind: "anthropic",
      envUrl: null,
      recoveredEndpointUrl: null,
      nonInteractive: false,
      prompt: async (message) => {
        messages.push(message);
        return "https://proxy.example.com/v1/messages?token=secret#frag";
      },
    });
    const state = makeRemoteSelectionState({
      provider: "compatible-anthropic-endpoint",
      endpointUrl: normalizeProviderBaseUrl(endpointInput, "anthropic"),
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    });
    const recovery = makeInteractiveValidationRecovery();
    const probedModels: string[] = [];
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "proxy-key",
      probeAnthropicEndpoint: (_endpointUrl, model) => {
        probedModels.push(model);
        return model === "good-claude"
          ? { ok: true, api: "anthropic-messages", label: "Anthropic Messages API" }
          : {
              ok: false,
              message: "bad model",
              failures: [{ name: "Anthropic Messages API", httpStatus: 400, message: "bad model" }],
            };
      },
      promptValidationRecovery: recovery.promptValidationRecovery,
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateCustomAnthropicSelection: validation.validateCustomAnthropicSelection,
      }),
    );
    const promptModel = () =>
      promptInputModel(TEST_CUSTOM_ANTHROPIC_CONFIG.label, "claude-proxy", null, {
        promptFn: async (message) => {
          messages.push(message);
          return modelAnswers.shift() || "";
        },
      });

    const { result, lines } = await captureConsoleOutput(async () => {
      state.model = await promptModel();
      const first = await validateSelectedRemoteModel({
        selected: { key: "anthropicCompatible" },
        remoteConfig: TEST_CUSTOM_ANTHROPIC_CONFIG,
        state,
        selectedCredentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      });
      state.model = await promptModel();
      const second = await validateSelectedRemoteModel({
        selected: { key: "anthropicCompatible" },
        remoteConfig: TEST_CUSTOM_ANTHROPIC_CONFIG,
        state,
        selectedCredentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      });
      return { first, second };
    });

    assert.deepEqual(result, { first: "retry-model", second: "selected" });
    assert.equal(state.provider, "compatible-anthropic-endpoint");
    assert.equal(state.model, "good-claude");
    assert.equal(state.endpointUrl, "https://proxy.example.com");
    assert.equal(state.preferredInferenceApi, "anthropic-messages");
    assert.deepEqual(probedModels, ["bad-claude", "good-claude"]);
    assert.ok(
      lines.some((line) =>
        line.includes("Other Anthropic-compatible endpoint endpoint validation failed"),
      ),
    );
    assert.ok(
      lines.some((line) =>
        line.includes("Please enter a different Other Anthropic-compatible endpoint model name."),
      ),
    );
    assert.equal(
      messages.filter((message) => /Anthropic-compatible base URL/.test(message)).length,
      1,
    );
    assert.equal(
      messages.filter((message) => /Other Anthropic-compatible endpoint model/.test(message))
        .length,
      2,
    );
  });

  it("lets users type back at a lower-level model prompt to return to provider selection", async () => {
    const messages: string[] = [];
    const endpointUrl = await resolveCompatibleEndpointInput({
      kind: "openai",
      envUrl: null,
      recoveredEndpointUrl: null,
      nonInteractive: false,
      prompt: async (message) => {
        messages.push(message);
        return "https://proxy.example.com/v1";
      },
    });
    const model = await promptInputModel(TEST_CUSTOM_OPENAI_CONFIG.label, "custom-model", null, {
      promptFn: async (message) => {
        messages.push(message);
        return "back";
      },
    });
    const { lines } = await captureConsoleOutput(async () => {
      assert.equal(
        returningToProviderSelection(model, (): never => {
          throw new Error("Unexpected onboarding exit");
        }),
        true,
      );
    });

    assert.equal(endpointUrl, "https://proxy.example.com/v1");
    assert.ok(isBackToSelection(model));
    assert.ok(lines.some((line) => line.includes("Returning to provider selection.")));
    assert.equal(
      messages.filter((message) => /OpenAI-compatible base URL/.test(message)).length,
      1,
    );
    assert.equal(
      messages.filter((message) => /Other OpenAI-compatible endpoint model/.test(message)).length,
      1,
    );
  });

  it("lets users type back at a secret provider credential prompt to return to provider selection", () => {
    runCredentialBackScenarioProcess(PROCESS_CREDENTIAL_BACK_SCENARIOS[0]!);
  });

  const secretCredentialBackScenarios = PROCESS_CREDENTIAL_BACK_SCENARIOS.slice(1, -1);

  for (const scenario of secretCredentialBackScenarios) {
    const action = scenario.expectedOutcome === "exit" ? "exit" : "back";
    it(`lets users type ${action} at the ${scenario.name} secret credential prompt`, () => {
      runCredentialBackScenarioProcess(scenario);
    });
  }

  it("lets users type back at the Local NIM NGC API key secret credential prompt", () => {
    runCredentialBackScenarioProcess(PROCESS_CREDENTIAL_BACK_SCENARIOS.at(-1)!);
  });

  it("lets users type back after a transport validation failure to return to provider selection", async () => {
    const messages: string[] = [];
    const recovery = createValidationRecoveryPromptHelpers({
      isNonInteractive: () => false,
      prompt: async (message) => {
        messages.push(message);
        return "back";
      },
      validateNvidiaApiKeyValue: () => null,
      getTransportRecoveryMessage,
      exitOnboardFromPrompt(): never {
        throw new Error("Unexpected onboarding exit");
      },
    });
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "sk-test",
      probeOpenAiLikeEndpoint: () => ({
        ok: false,
        failures: [
          {
            name: "Responses API",
            curlStatus: 6,
            message: "Could not resolve host: api.openai.com",
          },
        ],
      }),
      promptValidationRecovery: recovery.promptValidationRecovery,
    });
    const state = makeRemoteSelectionState({
      model: "gpt-5.4",
      provider: "openai-api",
      endpointUrl: TEST_OPENAI_ENDPOINT_URL,
      credentialEnv: "OPENAI_API_KEY",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateOpenAiLikeSelection: validation.validateOpenAiLikeSelection,
      }),
    );

    const { result, lines } = await captureConsoleOutput(() =>
      validateSelectedRemoteModel({
        selected: { key: "openai" },
        remoteConfig: {
          label: "OpenAI",
          endpointUrl: TEST_OPENAI_ENDPOINT_URL,
          helpUrl: null,
        },
        state,
        selectedCredentialEnv: "OPENAI_API_KEY",
      }),
    );

    assert.equal(result, "retry-selection");
    assert.ok(lines.some((line) => line.includes("could not resolve the provider hostname")));
    assert.ok(lines.some((line) => line.includes("Returning to provider selection.")));
    assert.equal(
      messages.filter((message) => /Type 'retry', 'back', or 'exit' \[retry\]: /.test(message))
        .length,
      1,
    );
  });

  it("returns to provider selection when endpoint validation fails interactively", async () => {
    const recovery = makeInteractiveValidationRecovery();
    const validation = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "sk-test",
      probeOpenAiLikeEndpoint: () => ({
        ok: false,
        failures: [{ name: "Responses API", httpStatus: 400, message: "bad request" }],
      }),
      promptValidationRecovery: recovery.promptValidationRecovery,
    });
    const state = makeRemoteSelectionState({
      model: "gpt-5.4",
      provider: "openai-api",
      endpointUrl: TEST_OPENAI_ENDPOINT_URL,
      credentialEnv: "OPENAI_API_KEY",
    });
    const { validateSelectedRemoteModel } = createRemoteModelValidator(
      makeRemoteModelValidatorDeps({
        validateOpenAiLikeSelection: validation.validateOpenAiLikeSelection,
      }),
    );

    const { result, lines } = await captureConsoleOutput(() =>
      validateSelectedRemoteModel({
        selected: { key: "openai" },
        remoteConfig: {
          label: "OpenAI",
          endpointUrl: TEST_OPENAI_ENDPOINT_URL,
          helpUrl: null,
        },
        state,
        selectedCredentialEnv: "OPENAI_API_KEY",
      }),
    );

    assert.equal(result, "retry-selection");
    assert.ok(lines.some((line) => line.includes("OpenAI endpoint validation failed")));
    assert.ok(lines.some((line) => line.includes("Please choose a provider/model again")));
  });

  it("fails early in non-interactive mode when explicit cloud provider key is not nvapi-", async () => {
    const previousCredential = process.env.NVIDIA_INFERENCE_API_KEY;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw Object.assign(new Error(`process.exit:${String(code)}`), { exitCode: code });
    }) as never);
    process.env.NVIDIA_INFERENCE_API_KEY = "sk-test";

    try {
      const { result, lines } = await captureConsoleOutput(async () => {
        try {
          resolveNonInteractiveBuildCredential({
            provider: "nvidia-prod",
            helpUrl: "https://build.nvidia.com/settings/api-keys",
            recoveredFromSandbox: false,
            providerExistsInGateway: () => false,
          });
          return null;
        } catch (error) {
          return error;
        }
      });

      assert.equal((result as { exitCode?: number }).exitCode, 1);
      assert.equal(exit.mock.calls.length, 1);
      assert.ok(
        lines.some((line) => line.includes("Invalid NVIDIA API key. Must start with nvapi-")),
      );
      assert.ok(
        lines.some((line) =>
          line.includes("Get a key from https://build.nvidia.com/settings/api-keys"),
        ),
      );
    } finally {
      exit.mockRestore();
      restoreProcessEnvValue("NVIDIA_INFERENCE_API_KEY", previousCredential);
    }
  });

  it("fails early in non-interactive mode with copy-paste recovery hints when no NVIDIA_INFERENCE_API_KEY is set", async () => {
    const envNames = [
      "NVIDIA_API_KEY",
      "NVIDIA_INFERENCE_API_KEY",
      "NGC_API_KEY",
      "NEMOCLAW_PROVIDER_KEY",
      "HOME",
    ] as const;
    const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-missing-build-key-"));
    for (const name of envNames) delete process.env[name];
    process.env.HOME = isolatedHome;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw Object.assign(new Error(`process.exit:${String(code)}`), { exitCode: code });
    }) as never);

    try {
      const { result, lines } = await captureConsoleOutput(async () => {
        try {
          resolveNonInteractiveBuildCredential({
            provider: "nvidia-prod",
            helpUrl: "https://build.nvidia.com/settings/api-keys",
            recoveredFromSandbox: false,
            providerExistsInGateway: () => false,
          });
          return null;
        } catch (error) {
          return error;
        }
      });

      assert.equal((result as { exitCode?: number }).exitCode, 1);
      assert.equal(exit.mock.calls.length, 1);
      assert.ok(
        lines.some((line) =>
          line.includes(
            "NVIDIA_INFERENCE_API_KEY (or NEMOCLAW_PROVIDER_KEY) is required for NVIDIA Endpoints in non-interactive mode.",
          ),
        ),
      );
      const setWithIndex = lines.findIndex((line) => line.trim() === "Set with:");
      assert.ok(setWithIndex >= 0, "expected a standalone 'Set with:' line");
      assert.equal(
        lines[setWithIndex + 1].trim(),
        "export NVIDIA_INFERENCE_API_KEY=nvapi-...",
        "expected the export command on its own line so it can be copy-pasted",
      );
      assert.ok(
        lines.some((line) =>
          line.includes("Get a key from https://build.nvidia.com/settings/api-keys"),
        ),
      );
    } finally {
      exit.mockRestore();
      for (const [name, value] of previousEnv) restoreProcessEnvValue(name, value);
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    }
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

  it("treats a pasted NVIDIA API key at the retry prompt as retry and re-prompts securely", async () => {
    const state = makeRemoteSelectionState({
      model: "nim/meta/llama-3.1-70b-instruct",
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    const { lines, prompts } = await runCredentialRetryScenario({
      label: "NVIDIA Endpoints",
      selectedKey: "build",
      state,
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      badCredential: "nvapi-bad",
      goodCredential: "nvapi-good",
      successApi: "openai-completions",
      probeKind: "openai",
      retryAnswer: "nvapi-fake-key-value",
    });

    assert.equal(state.provider, "nvidia-prod");
    assert.equal(state.preferredInferenceApi, "openai-completions");
    assert.ok(lines.some((line) => line.includes("That looks like an API key")));
    assert.ok(lines.some((line) => line.includes("Treating as 'retry'")));
    assert.ok(prompts.some(({ message }) => /NVIDIA Endpoints API key: /.test(message)));
  });

  it("lets users re-enter an OpenAI API key after authorization failure", async () => {
    const state = makeRemoteSelectionState({
      model: "gpt-5.4",
      provider: "openai-api",
      endpointUrl: TEST_OPENAI_ENDPOINT_URL,
      credentialEnv: "OPENAI_API_KEY",
    });
    const { prompts } = await runCredentialRetryScenario({
      label: "OpenAI",
      selectedKey: "openai",
      state,
      credentialEnv: "OPENAI_API_KEY",
      badCredential: "sk-bad",
      goodCredential: "sk-good",
      successApi: "openai-responses",
      probeKind: "openai",
    });

    assert.equal(state.provider, "openai-api");
    assert.equal(state.model, "gpt-5.4");
    assert.equal(state.preferredInferenceApi, "openai-responses");
    assert.ok(prompts.some(({ message }) => /OpenAI API key: /.test(message)));
  });

  it("lets users re-enter a Gemini API key after authorization failure", async () => {
    const state = makeRemoteSelectionState({
      model: "gemini-2.5-flash",
      provider: "gemini-api",
      endpointUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      credentialEnv: "GEMINI_API_KEY",
    });
    const { prompts } = await runCredentialRetryScenario({
      label: "Google Gemini",
      selectedKey: "gemini",
      state,
      credentialEnv: "GEMINI_API_KEY",
      badCredential: "gemini-bad",
      goodCredential: "gemini-good",
      successApi: "openai-completions",
      probeKind: "openai",
      authMode: "query-param",
    });

    assert.equal(state.provider, "gemini-api");
    assert.equal(state.model, "gemini-2.5-flash");
    assert.equal(state.preferredInferenceApi, "openai-completions");
    assert.ok(prompts.some(({ message }) => /Google Gemini API key: /.test(message)));
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
  // The endpoint SSRF preflight now runs unconditionally (#6293); stub the DNS
  // resolver to a public address so the fixture hostname resolves and the flow
  // reaches validation instead of being refused (mirrors credentials/runner stubs).
  require("node:dns/promises").lookup = async () => [{ address: "93.184.216.34", family: 4 }];
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

  it("offers install-ollama option on Linux when Ollama is not installed", async () => {
    const menu = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      installedOllamaVersion: null,
      platform: "linux",
      isWsl: false,
    });
    const { options } = buildProviderMenu({ ollamaInstallEntry: menu.entry });
    assert.ok(options.some(({ label }) => label.includes("Install Ollama (Linux)")));

    const events: Array<{ type: "command" | "log"; value: string; stdio?: unknown }> = [];
    const runShellImpl = vi.fn((command: string, options: { stdio?: unknown } = {}) => {
      events.push({ type: "command", value: command, stdio: options.stdio });
      return successfulRunShellResult();
    });
    const installResult = installOllamaOnLinux(
      makeInstallOllamaLinuxOptions({
        modeOverride: "system",
        runCaptureImpl: () => "",
        runShellImpl,
        ensureManagedOllamaLoopbackSystemdOverrideImpl: () => "not-applicable",
        waitForHttpImpl: (_url, tries) => (tries ?? 0) > 1,
        log: (message) => events.push({ type: "log", value: message }),
      }),
    );
    const state = makeOllamaSelectionState();
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        installOllamaOnLinux: () => installResult,
      }),
    );

    try {
      assert.equal(await handleInstallOllamaSelection(null, null, null, state, menu), "selected");
      assert.equal(state.provider, "ollama-local");

      const commands = events.filter(({ type }) => type === "command").map(({ value }) => value);
      const zstdPreflightIndex = commands.findIndex((command) =>
        command.includes("apt-get install -y -qq --no-install-recommends zstd"),
      );
      const installerIndex = commands.findIndex((command) =>
        command.includes("ollama.com/install.sh"),
      );
      assert.ok(zstdPreflightIndex >= 0);
      assert.ok(installerIndex > zstdPreflightIndex);
      const zstdWarningIndex = events.findIndex(
        ({ type, value }) =>
          type === "log" && value.includes("requires zstd for archive extraction"),
      );
      const zstdCommandIndex = events.findIndex(
        ({ type, value }) =>
          type === "command" &&
          value.includes("apt-get install -y -qq --no-install-recommends zstd"),
      );
      const installerWarningIndex = events.findIndex(
        ({ type, value }) =>
          type === "log" &&
          value.includes("creates a system user, a systemd service, and writes to /usr/local"),
      );
      const installerCommandIndex = events.findIndex(
        ({ type, value }) => type === "command" && value.includes("ollama.com/install.sh"),
      );
      assert.ok(zstdWarningIndex >= 0 && zstdWarningIndex < zstdCommandIndex);
      assert.ok(installerWarningIndex >= 0 && installerWarningIndex < installerCommandIndex);
      assert.equal(
        events.find(
          ({ type, value }) => type === "command" && value.includes("ollama.com/install.sh"),
        )?.stdio,
        "inherit",
      );
      assert.ok(commands.some((command) => command.includes("ollama.com/install.sh")));
      assert.ok(!commands.some((command) => command.includes("brew install")));
      assert.ok(
        commands.some((command) => command.includes("OLLAMA_HOST=127.0.0.1:11434 ollama serve")),
      );
      assert.ok(!commands.some((command) => command.includes("OLLAMA_HOST=0.0.0.0:11434")));
    } finally {
      resetOllamaHostCache();
    }
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

  it("uses install-ollama for non-interactive NEMOCLAW_PROVIDER=ollama on fresh Linux", async () => {
    const menu = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      installedOllamaVersion: null,
      platform: "linux",
      isWsl: false,
    });
    const runShellCalls: Array<{ command: string; stdio?: unknown }> = [];
    const runShellImpl = vi.fn((command: string, options: { stdio?: unknown } = {}) => {
      runShellCalls.push({ command, stdio: options.stdio });
      return successfulRunShellResult();
    });
    const prompt = vi.fn(async () => "");
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        isNonInteractive: () => true,
        installOllamaOnLinux: () =>
          installOllamaOnLinux(
            makeInstallOllamaLinuxOptions({
              modeOverride: "system",
              isNonInteractive: () => true,
              runCaptureImpl: () => "",
              runShellImpl,
              ensureManagedOllamaLoopbackSystemdOverrideImpl: () => "not-applicable",
              waitForHttpImpl: (_url, tries) => (tries ?? 0) > 1,
            }),
          ),
      }),
    );
    const setupNim = createSetupNim(
      makeSetupNimFlowDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => "qwen3:8b",
        prompt,
        detectInferenceProviderHostState: () => makeSetupNimHostState({ ollamaInstallMenu: menu }),
        handleInstallOllamaSelection,
      }),
    );

    try {
      const result = await setupNim(null);

      assert.equal(prompt.mock.calls.length, 0);
      assert.equal(result.provider, "ollama-local");
      const zstdPreflightIndex = runShellCalls.findIndex(({ command }) =>
        command.includes("apt-get install -y -qq --no-install-recommends zstd"),
      );
      const installerIndex = runShellCalls.findIndex(({ command }) =>
        command.includes("ollama.com/install.sh"),
      );
      assert.ok(zstdPreflightIndex >= 0);
      assert.ok(installerIndex > zstdPreflightIndex);
      assert.equal(runShellCalls[installerIndex]?.stdio, "inherit");
      assert.ok(
        runShellCalls.some(({ command }) =>
          command.includes("OLLAMA_HOST=127.0.0.1:11434 ollama serve"),
        ),
      );
      assert.ok(
        !runShellCalls.some(({ command }) => command.includes("OLLAMA_HOST=0.0.0.0:11434")),
      );
    } finally {
      resetOllamaHostCache();
    }
  });

  it("falls back to a user-local Ollama install when non-interactive lacks passwordless sudo (#4114)", async () => {
    const commands: string[] = [];
    const runShellImpl = vi.fn((command: string) => {
      commands.push(command);
      return successfulRunShellResult();
    });
    const installResult = installOllamaOnLinux(
      makeInstallOllamaLinuxOptions({
        isNonInteractive: () => true,
        isTty: () => false,
        canSudoNonInteractive: () => false,
        runCaptureImpl: (command) => (command.at(-1) === "zstd" ? "/usr/bin/zstd" : ""),
        runCaptureExImpl: () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        }),
        runShellImpl,
        waitForHttpImpl: () => true,
      }),
    );
    const state = makeOllamaSelectionState();
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        isNonInteractive: () => true,
        installOllamaOnLinux: () => installResult,
      }),
    );

    try {
      assert.equal(installResult.mode, "user-local");
      assert.equal(
        await handleInstallOllamaSelection(null, "qwen3:8b", null, state, {
          hasUpgradableOllama: false,
        }),
        "selected",
      );
      assert.equal(state.provider, "ollama-local");
      assert.ok(!commands.some((command) => command.includes("ollama.com/install.sh")));
      assert.ok(
        commands.some(
          (command) => command.includes("ollama-linux-") && command.includes(".tar.zst"),
        ),
      );
      assert.ok(
        commands.some((command) => command.includes("zstd -d") && command.includes("/.local")),
      );
      assert.ok(!commands.some((command) => command.includes("sudo")));
      assert.ok(
        commands.some(
          (command) => command.includes("nohup") && command.includes("/.local/bin/ollama"),
        ),
      );
      assert.ok(!commands.some((command) => command.includes("OLLAMA_HOST=0.0.0.0:11434")));
    } finally {
      resetOllamaHostCache();
    }
  });

  it("upgrades an outdated host Ollama instead of reusing it under NEMOCLAW_PROVIDER=install-ollama", async () => {
    const menu = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      ollamaHost: "127.0.0.1",
      hasWindowsOllama: false,
      installedOllamaVersion: "0.6.2",
      runningOllamaVersion: "0.6.2",
      platform: "linux",
      isWsl: false,
    });
    assert.equal(menu.hasUpgradableOllama, true);
    const commands: string[] = [];
    let installerRan = false;
    const runCapture = (command: readonly string[]) => {
      const rendered = command.join(" ");
      switch (true) {
        case rendered.includes("ollama --version"):
          return installerRan ? "ollama version is 0.24.0" : "ollama version is 0.6.2";
        case rendered.includes("/api/version"):
          return installerRan ? '{"version":"0.24.0"}' : '{"version":"0.6.2"}';
        case command.at(-1) === "zstd":
          return "/usr/bin/zstd";
        default:
          return "";
      }
    };
    const install = () =>
      installOllamaOnLinux(
        makeInstallOllamaLinuxOptions({
          modeOverride: "system",
          isUpgrade: true,
          isNonInteractive: () => true,
          runCaptureImpl: runCapture,
          runShellImpl: (command) => {
            installerRan ||= command.includes("ollama.com/install.sh");
            commands.push(command);
            return successfulRunShellResult();
          },
          ensureManagedOllamaLoopbackSystemdOverrideImpl: () => "not-applicable",
          waitForHttpImpl: (_url, tries) => (tries ?? 0) > 1,
        }),
      );
    const prompt = vi.fn(async () => "");
    const notes: string[] = [];
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        isNonInteractive: () => true,
        installOllamaOnLinux: install,
        assertOllamaUpgradeApplied: (selection) => {
          const outcome = assertOllamaUpgradeApplied(selection, runCapture);
          return outcome.ok
            ? { ok: true as const }
            : { ok: false as const, message: outcome.message ?? "Ollama upgrade failed." };
        },
      }),
    );
    const setupNim = createSetupNim(
      makeSetupNimFlowDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-ollama",
        getNonInteractiveModel: () => "qwen3:8b",
        prompt,
        note: (message) => notes.push(message),
        detectInferenceProviderHostState: () =>
          makeSetupNimHostState({
            hasOllama: true,
            ollamaHost: "127.0.0.1",
            ollamaRunning: true,
            ollamaInstallMenu: menu,
          }),
        handleInstallOllamaSelection,
      }),
    );

    try {
      const result = await setupNim(null);

      assert.equal(prompt.mock.calls.length, 0);
      assert.equal(result.provider, "ollama-local");
      assert.ok(notes.some((line) => line.includes("[non-interactive] Provider: install-ollama")));
      assert.ok(commands.some((command) => command.includes("ollama.com/install.sh")));
    } finally {
      resetOllamaHostCache();
    }
  });

  it("restarts Windows-host Ollama after install when installer auto-start is not reachable", async () => {
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const install = vi.fn(async () => ({ ok: true, path: installedPath }));
    const awaitReady = vi.fn(() => false);
    const setup = vi.fn<SetupNimOllamaDeps["setupWindowsOllamaWith0000Binding"]>(() => true);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
    const state = makeOllamaSelectionState();
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        installOllamaOnWindowsHost: install,
        awaitWindowsOllamaReady: awaitReady,
        setupWindowsOllamaWith0000Binding: setup,
      }),
    );

    try {
      const result = await handleWindowsHostOllamaSelection(
        null,
        "install-windows-ollama",
        "qwen3:8b",
        false,
        false,
        null,
        state,
      );

      assert.equal(result, "selected");
      assert.equal(state.provider, "ollama-local");
      assert.equal(state.model, "qwen3:8b");
      assert.equal(install.mock.calls.length, 1);
      assert.equal(awaitReady.mock.calls.length, 1);
      assert.deepEqual(
        setup.mock.calls.map(([options]) => options),
        [{ installedPath }],
      );
      assert.ok(
        lines.some((line) =>
          line.includes("Installer did not leave a reachable Ollama daemon; restarting it"),
        ),
      );
      assert.ok(lines.some((line) => line.includes("Using Ollama on host.docker.internal:11434")));
    } finally {
      log.mockRestore();
    }
  });

  it("shows Windows-host Ollama in the menu with a Docker Desktop requirement on native Docker WSL", () => {
    const requirement = getWindowsHostOllamaDockerRequirement("docker");
    const { options } = buildWindowsProviderMenu(requirement, {
      hasWindowsOllama: true,
    });
    const menuOutput = options.map((option) => option.label).join("\n");

    assert.match(
      menuOutput,
      /Start Ollama on Windows host \(requires Docker Desktop WSL integration\)/,
    );
    assert.doesNotMatch(menuOutput, /Start Ollama on Windows host \(suggested\)/);
  });

  it("rejects Windows-host Ollama providers on native Docker WSL before launching Ollama", () => {
    const scenarios = [
      { provider: "start-windows-ollama", installed: true },
      { provider: "install-windows-ollama", installed: false },
    ] as const;

    for (const scenario of scenarios) {
      const boundary = runNativeDockerWindowsProviderBoundary({
        ...scenario,
        reachable: false,
        timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
      });
      assert.equal(boundary.status, 1, `${scenario.provider} unexpectedly passed`);
      assert.match(boundary.stderr, /\[non-interactive\] Aborting:/);
      assert.match(boundary.stderr, new RegExp(scenario.provider + " requires Docker Desktop"));
      assert.match(boundary.stderr, /Choose WSL-local Ollama/);
      assert.doesNotMatch(
        boundary.stderr,
        /MODEL_SELECTION_REACHED|WINDOWS_INSTALL_CALLED|WINDOWS_SETUP_CALLED|WINDOWS_SWITCH_CALLED/,
      );
    }
  });

  it("rejects reachable Windows-host Ollama on native Docker WSL through generic and fallback paths", () => {
    const providers = ["ollama", "start-windows-ollama", "install-windows-ollama"] as const;
    for (const provider of providers) {
      const boundary = runNativeDockerWindowsProviderBoundary({
        provider,
        installed: true,
        reachable: true,
        timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
      });
      assert.equal(boundary.status, 1, `${provider} unexpectedly passed`);
      assert.match(boundary.stderr, /\[non-interactive\] Aborting:/);
      assert.match(boundary.stderr, new RegExp(provider + " requires Docker Desktop"));
      assert.match(boundary.stderr, /Choose WSL-local Ollama/);
      assert.doesNotMatch(
        boundary.stderr,
        /MODEL_SELECTION_REACHED|WINDOWS_INSTALL_CALLED|WINDOWS_SETUP_CALLED|WINDOWS_SWITCH_CALLED/,
      );
    }
  });

  it("uses the Windows-host start path when install-windows-ollama is requested but Ollama is already installed", async () => {
    const requirement = getWindowsHostOllamaDockerRequirement("docker-desktop");
    const installedPath = "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const { options } = buildWindowsProviderMenu(requirement, {
      hasWindowsOllama: true,
    });
    const resolution = resolveWindowsProvider(options, "install-windows-ollama");
    assert.equal(resolution.kind, "selected");
    const selectedResolution = requireSelectedProviderResolution(resolution);
    assert.equal(selectedResolution.selected.key, "start-windows-ollama");

    const install = vi.fn(async () => ({ ok: false, path: "" }));
    const setup = vi.fn<SetupNimOllamaDeps["setupWindowsOllamaWith0000Binding"]>(() => true);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
    const state = makeOllamaSelectionState();
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        installOllamaOnWindowsHost: install,
        setupWindowsOllamaWith0000Binding: setup,
      }),
    );

    try {
      const result = await handleWindowsHostOllamaSelection(
        null,
        selectedResolution.selected.key,
        "qwen3:8b",
        false,
        false,
        installedPath,
        state,
      );

      assert.equal(result, "selected");
      assert.equal(state.provider, "ollama-local");
      assert.equal(state.model, "qwen3:8b");
      assert.equal(install.mock.calls.length, 0);
      assert.deepEqual(
        setup.mock.calls.map(([options]) => options),
        [{ announceStop: false, installedPath }],
      );
      assert.ok(lines.some((line) => line.includes("Using Ollama on host.docker.internal:11434")));
    } finally {
      log.mockRestore();
    }
  });

  it("detects Windows-host Ollama via running process when not on the user PATH (#3949)", async () => {
    const installedPath = "C:/Program Files/Ollama/ollama.exe";
    const runCapture = createWindowsHostOllamaRunCapture([
      { contains: ["Get-Process ollama", "Path"], output: installedPath },
      { contains: ["Get-Process ollama", "Id"], output: "7652" },
      { contains: ["Get-NetTCPConnection"], output: "127.0.0.1" },
    ]);
    const detected = detectWindowsHostOllama({ isWsl: () => true, runCapture });
    assert.deepEqual(detected, {
      installed: true,
      installedPath,
      loopbackOnly: true,
    });

    const install = vi.fn(async () => ({ ok: false, path: "" }));
    const setup = vi.fn<SetupNimOllamaDeps["setupWindowsOllamaWith0000Binding"]>(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const state = makeOllamaSelectionState();
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        installOllamaOnWindowsHost: install,
        setupWindowsOllamaWith0000Binding: setup,
      }),
    );

    try {
      await handleWindowsHostOllamaSelection(
        null,
        "start-windows-ollama",
        "qwen3:8b",
        false,
        detected.loopbackOnly,
        detected.installedPath,
        state,
      );

      assert.equal(state.provider, "ollama-local");
      assert.equal(install.mock.calls.length, 0);
      assert.deepEqual(
        setup.mock.calls.map(([options]) => options),
        [{ announceStop: true, installedPath }],
      );
    } finally {
      log.mockRestore();
    }
  });

  it("uses a known Windows install path when a running Ollama process has no readable path", async () => {
    const installedPath = "C:/Users/tester/AppData/Local/Programs/Ollama/ollama.exe";
    const runCapture = createWindowsHostOllamaRunCapture([
      { contains: ["Test-Path -LiteralPath"], output: installedPath },
      { contains: ["Get-Process ollama", "Id"], output: "7652" },
      { contains: ["Get-NetTCPConnection"], output: "127.0.0.1" },
    ]);
    const detected = detectWindowsHostOllama({ isWsl: () => true, runCapture });
    assert.deepEqual(detected, {
      installed: true,
      installedPath,
      loopbackOnly: true,
    });

    const install = vi.fn(async () => ({ ok: false, path: "" }));
    const setup = vi.fn<SetupNimOllamaDeps["setupWindowsOllamaWith0000Binding"]>(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const state = makeOllamaSelectionState();
    const { handleWindowsHostOllamaSelection } = createSetupNimOllamaHandlers(
      makeSetupNimOllamaDeps({
        installOllamaOnWindowsHost: install,
        setupWindowsOllamaWith0000Binding: setup,
      }),
    );

    try {
      await handleWindowsHostOllamaSelection(
        null,
        "start-windows-ollama",
        "qwen3:8b",
        false,
        detected.loopbackOnly,
        detected.installedPath,
        state,
      );

      assert.equal(state.provider, "ollama-local");
      assert.equal(install.mock.calls.length, 0);
      assert.deepEqual(
        setup.mock.calls.map(([options]) => options),
        [{ announceStop: true, installedPath }],
      );
    } finally {
      log.mockRestore();
    }
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
  await setupInference(null, "qwen3.6:35b", "compatible-endpoint", "http://public-server.example:11434/v1", "COMPATIBLE_API_KEY", null, [], { preferredInferenceApi: "openai-completions", endpointPinnedAddresses: ["93.184.216.34"] });
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
