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

// Provider keys that route the wizard into an Ollama-using branch — keep in
// sync with the Ollama entries in providers.ts validProviders. Each of these
// re-selects an Ollama path on every selection-loop iteration, so a
// runner-crash inside selectAndValidateOllamaModel must exit (rather than
// return to selection) to avoid looping. (#4365)
const OLLAMA_PINNED_PROVIDER_KEYS = new Set([
  "ollama",
  "install-ollama",
  "install-windows-ollama",
  "start-windows-ollama",
]);

/**
 * True when NEMOCLAW_PROVIDER pins onboarding to any Ollama-using branch.
 * Mirrors the normalization that getNonInteractiveProvider uses (trim +
 * lowercase) so casing/whitespace variants like `OLLAMA` or ` ollama `
 * still trigger the pinned-provider escape paths. (#4365)
 */
export function isOllamaProviderPinned(): boolean {
  const normalized = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  return OLLAMA_PINNED_PROVIDER_KEYS.has(normalized);
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
    const providerPinned = isOllamaProviderPinned();
    if (isNonInteractive() || providerPinned) {
      if (providerPinned) {
        console.error(
          "  NEMOCLAW_PROVIDER pins onboarding to Ollama but Ollama is unreachable; refusing to loop on provider selection.",
        );
      }
      process.exit(1);
    }
    // Surface a non-Ollama steer so the user does not pick Local Ollama again
    // and hit the same timeout (issue #4365 loop).
    console.error(
      "  Pick a non-Ollama provider in the next menu — re-selecting Local Ollama would hit the same timeout.",
    );
    return { kind: "continue" };
  }
  return { kind: "ready" };
}
