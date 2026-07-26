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
    NEMOCLAW_MODEL: "qwen3:8b",
    NEMOCLAW_NON_INTERACTIVE: "1",
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
  const scenario = JSON.stringify({ installed: options.installed, reachable: options.reachable });

  const script = String.raw`
const scenario = ${scenario};
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
  const cmd = Array.isArray(command) ? command.join(" ") : String(command);
  if (cmd.includes("command -v ollama")) return "";
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

  try {
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
