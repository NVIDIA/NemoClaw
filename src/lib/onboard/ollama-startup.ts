// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const runner: typeof import("../runner") = require("../runner");
const wait: typeof import("../core/wait") = require("../core/wait");
const localInference: typeof import("../inference/local") = require("../inference/local");

let NO_OLLAMA_AUTOSTART = false;

export function setOllamaAutostartDisabled(value: boolean | undefined): void {
  NO_OLLAMA_AUTOSTART = !!value;
}

export function isOllamaAutostartDisabled(): boolean {
  return NO_OLLAMA_AUTOSTART || process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART === "1";
}

export type OllamaFallbackResult = {
  provider: "ollama-local";
  credentialEnv: null;
  endpointUrl: string;
  model: string;
  preferredInferenceApi: "openai-completions";
};

export type OllamaStartupOutcome =
  | { kind: "ready" }
  | { kind: "continue" }
  | { kind: "fallback"; result: OllamaFallbackResult };

export function runOllamaStartupOrGate(args: {
  ollamaReady: boolean;
  ollamaPort: number;
  getLocalProviderBaseUrl: (provider: "ollama-local") => string | null;
  isNonInteractive: () => boolean;
}): OllamaStartupOutcome {
  const { ollamaReady, ollamaPort, getLocalProviderBaseUrl, isNonInteractive } = args;
  if (ollamaReady) return { kind: "ready" };
  if (isOllamaAutostartDisabled()) {
    console.log(
      "  ⚠ Ollama is not running on localhost:" +
        `${ollamaPort} and --no-ollama-autostart is set; ` +
        "skipping auto-start and falling back to the default model.",
    );
    const endpointUrl = getLocalProviderBaseUrl("ollama-local");
    if (!endpointUrl) {
      console.error("  Local Ollama base URL could not be determined.");
      process.exit(1);
    }
    return {
      kind: "fallback",
      result: {
        provider: "ollama-local",
        credentialEnv: null,
        endpointUrl,
        model: localInference.DEFAULT_OLLAMA_MODEL,
        preferredInferenceApi: "openai-completions",
      },
    };
  }
  console.log("  Starting Ollama...");
  runner.runShell(`OLLAMA_HOST=127.0.0.1:${ollamaPort} ollama serve > /dev/null 2>&1 &`, {
    ignoreError: true,
  });
  if (!wait.waitForHttp(`http://127.0.0.1:${ollamaPort}/`, 10)) {
    console.error(`  Ollama did not become ready on :${ollamaPort} within timeout.`);
    const providerPinned = process.env.NEMOCLAW_PROVIDER === "ollama";
    if (isNonInteractive() || providerPinned) {
      if (providerPinned) {
        console.error(
          "  NEMOCLAW_PROVIDER=ollama is pinned but Ollama is unreachable; refusing to loop on provider selection.",
        );
      }
      process.exit(1);
    }
    return { kind: "continue" };
  }
  return { kind: "ready" };
}
