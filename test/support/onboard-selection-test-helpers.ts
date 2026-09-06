// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

import type { ProviderOption } from "../../src/lib/onboard/provider-key-fallback.js";
import type {
  ProviderSelectionFailure,
  ProviderSelectionResolution,
  ProviderSelectionSuccess,
} from "../../src/lib/onboard/provider-selection.js";
import type { DetectWindowsHostOllamaDeps } from "../../src/lib/onboard/windows-host-ollama.js";
import {
  createHostProcessWorkspace,
  trailingJsonPayload,
} from "../helpers/host-process-harness.js";
import { onboardChildRuntimeSource } from "../helpers/onboard-child-runtime.js";

const PROVIDER_CREDENTIAL_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "COMPATIBLE_API_KEY",
  "GEMINI_API_KEY",
  "NGC_API_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "NOUS_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
]);

export type OllamaPullScenario = {
  answers: readonly string[];
  environment?: NodeJS.ProcessEnv;
  listAfter: { attempts: number } | { model: string } | "first-pull";
};

export type OllamaPullScenarioResult = {
  payload: {
    result: { provider: string; model: string };
    messages: string[];
    lines: string[];
    listAttempts: number;
  };
  pulls: string;
};

export function runOllamaPullScenario(
  scenario: OllamaPullScenario,
  curlResponse: string,
): OllamaPullScenarioResult {
  const repoRoot = path.join(import.meta.dirname, "..", "..");
  const workspace = createHostProcessWorkspace("nemoclaw-onboard-ollama-pull-");
  const pullLog = workspace.path("pulls.log");
  const curlResponsePath = workspace.path("curl-response.json");
  fs.writeFileSync(curlResponsePath, curlResponse);
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const listResult =
    scenario.listAfter === "first-pull"
      ? `fs.existsSync(pullLog) ? "qwen3.5:9b" : ""`
      : "attempts" in scenario.listAfter
        ? `fs.existsSync(pullLog) && ++listAttempts >= ${scenario.listAfter.attempts} ? "qwen3.5:9b" : ""`
        : `fs.existsSync(pullLog) && fs.readFileSync(pullLog, "utf8").includes(${JSON.stringify(scenario.listAfter.model)}) ? ${JSON.stringify(scenario.listAfter.model)} : ""`;

  workspace.writeExecutable(
    "curl",
    `#!/usr/bin/env bash
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
if [ "$has_config" -eq 0 ] && [[ "$url" == *:11435/* ]]; then status="401"; fi
if [ -n "$outfile" ]; then cat ${JSON.stringify(curlResponsePath)} > "$outfile"; fi
printf '%s' "$status"
`,
  );
  workspace.writeExecutable(
    "ollama",
    `#!/usr/bin/env bash
if [ "$1" = "pull" ]; then echo "$2" >> ${JSON.stringify(pullLog)}; exit 0; fi
exit 0
`,
  );

  const source = String.raw`
const fs = require("fs");
${onboardChildRuntimeSource}
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const { messages } = installPromptQueue(credentials, ${JSON.stringify(scenario.answers)});
const pullLog = ${JSON.stringify(pullLog)};
let listAttempts = 0;
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  const ollamaMetadata = supportedOllamaHostMetadataOutput(cmd); if (ollamaMetadata) return ollamaMetadata;
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [] });
  if (cmd.includes("ollama list")) return ${listResult};
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};
const { setupNim } = require(${onboardPath});
reportChildScenario(async () => {
  const result = await setupNim(null);
  return { result, messages, listAttempts };
});
`;

  try {
    const result = workspace.runNodeSource(source, {
      cwd: repoRoot,
      env: workspace.environment(scenario.environment),
    });
    if (result.status !== 0) throw new Error(`Ollama pull scenario failed: ${result.stderr}`);
    return {
      payload: trailingJsonPayload<OllamaPullScenarioResult["payload"]>(result.stdout),
      pulls: fs.existsSync(pullLog) ? fs.readFileSync(pullLog, "utf8").trim() : "",
    };
  } finally {
    workspace.remove();
  }
}

export function requirePresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function restoreProcessEnvValue(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

export function requireSelectedProviderResolution<T extends ProviderOption>(
  resolution: ProviderSelectionResolution<T>,
): ProviderSelectionSuccess<T> {
  if (resolution.kind !== "selected") throw new Error("Expected provider selection");
  return resolution;
}

export function requireFailedProviderResolution<T extends ProviderOption>(
  resolution: ProviderSelectionResolution<T>,
): ProviderSelectionFailure {
  if (resolution.kind !== "failure") throw new Error("Expected provider selection failure");
  return resolution;
}

function createIsolatedOnboardEnv(tmpDir: string, provider: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NEMOCLAW_") || PROVIDER_CREDENTIAL_ENV_KEYS.has(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: tmpDir,
    PATH: `${tmpDir}${path.delimiter}${env.PATH ?? ""}`,
    NEMOCLAW_MODEL: "qwen3:8b",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_OLLAMA_INSTALL_MODE: "user",
    NEMOCLAW_PROVIDER: provider,
    NEMOCLAW_YES: "1",
  };
}

export function runNativeDockerWindowsProviderBoundary(options: {
  provider: "ollama" | "start-windows-ollama" | "install-windows-ollama";
  installed: boolean;
  reachable: boolean;
  timeoutMs: number;
}): SpawnSyncReturns<string> {
  const repoRoot = path.join(import.meta.dirname, "..", "..");
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-onboard-native-docker-windows-provider-"),
  );
  const scriptPath = path.join(tmpDir, "provider-boundary-check.js");
  const zstdPath = path.join(tmpDir, "zstd");
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));
  const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));
  const topologyPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "local-inference-topology.ts"),
  );
  const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));
  const windowsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "inference", "ollama", "windows.ts"),
  );
  const scenario = JSON.stringify({ installed: options.installed, reachable: options.reachable });

  const script = String.raw`
const scenario = ${scenario};
const runner = require(${runnerPath});
const platform = require(${platformPath});
const wait = require(${waitPath});

platform.isWsl = () => true;
wait.waitForHttp = () => {
  console.error("OLLAMA_READINESS_PROBED");
  return true;
};
wait.sleepSeconds = () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : String(command);
  if (cmd.includes("command -v ollama")) return "";
  if (Array.isArray(command) && command.at(-1) === "zstd") return "zstd";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("docker images")) return "";
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Command ollama.exe")) {
    return scenario.installed
      ? "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe"
      : "";
  }
  if (cmd.includes("powershell.exe") && cmd.includes("Get-Process ollama")) return "";
  if (scenario.reachable && cmd.includes("api/tags")) {
    return JSON.stringify({ models: [{ name: "qwen3:8b" }] });
  }
  return "";
};
runner.run = () => ({ status: 0 });
runner.runShell = () => ({ status: 0 });

const credentials = require(${credentialsPath});
const topology = require(${topologyPath});
const local = require(${localPath});
const windows = require(${windowsPath});

topology.getContainerRuntime = () => "docker";
credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive test");
};
credentials.ensureApiKey = async () => {};
local.resetOllamaHostCache();
if (scenario.reachable) local.setResolvedOllamaHost(local.OLLAMA_HOST_DOCKER_INTERNAL);
local.getOllamaModelOptions = () => {
  console.error("MODEL_SELECTION_REACHED");
  return ["qwen3:8b"];
};
windows.installOllamaOnWindowsHost = async () => {
  console.error("WINDOWS_INSTALL_CALLED");
  return { ok: true, path: "C:\\Users\\tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe" };
};
windows.setupWindowsOllamaLoopbackBinding = () => {
  console.error("WINDOWS_SETUP_CALLED");
  return true;
};
const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim(null, null);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  try {
    fs.writeFileSync(zstdPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(scriptPath, script);
    return spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: createIsolatedOnboardEnv(tmpDir, options.provider),
      timeout: options.timeoutMs,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

type CommandResponse = {
  contains: readonly string[];
  output: string;
};

export function createWindowsHostOllamaRunCapture(
  responses: readonly CommandResponse[],
): DetectWindowsHostOllamaDeps["runCapture"] {
  return vi.fn<DetectWindowsHostOllamaDeps["runCapture"]>((command) => {
    const rendered = Array.isArray(command) ? command.join(" ") : String(command);
    return (
      responses.find(({ contains }) => contains.every((part) => rendered.includes(part)))?.output ??
      ""
    );
  });
}
