// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

const runner: typeof import("../runner") = require("../runner");
const wait: typeof import("../core/wait") = require("../core/wait");
const localInference: typeof import("../inference/local") = require("../inference/local");
const runtimeContext: typeof import("../inference/ollama-runtime-context") = require("../inference/ollama-runtime-context");

let NO_OLLAMA_AUTOSTART = false;

export function setOllamaAutostartDisabled(value: boolean | undefined): void {
  NO_OLLAMA_AUTOSTART = !!value;
}

export interface StartOllamaServeOptions {
  port: number;
  /** Minimum daemon context length to request for the selected agent. */
  contextWindowFloor?: number;
  binPath?: string;
  spawnImpl?: typeof spawn;
}

/**
 * Launch `ollama serve` on loopback in its own session so it outlives onboarding.
 *
 * A shell `&` job stays in the onboarding process group and session, so a closing
 * terminal or a process-group signal stops the backend while the detached auth
 * proxy keeps running (#11984). Callers still prove readiness with an HTTP probe.
 */
export function startDetachedOllamaServe(opts: StartOllamaServeOptions): void {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const floor = runtimeContext.resolveOllamaContextWindowFloor(opts.contextWindowFloor);
  const env = runner.buildSubprocessEnv({
    OLLAMA_HOST: `127.0.0.1:${opts.port}`,
    ...(floor > runtimeContext.MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW
      ? { OLLAMA_CONTEXT_LENGTH: String(floor) }
      : {}),
  });
  const child = spawnImpl(opts.binPath ?? "ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  // A missing or unrunnable binary surfaces through the caller's readiness probe.
  child.on("error", () => {});
  child.unref();
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
  contextWindowFloor?: number;
}): OllamaStartupOutcome {
  const { ollamaReady, ollamaPort, getLocalProviderBaseUrl, isNonInteractive, contextWindowFloor } =
    args;
  if (ollamaReady) return { kind: "ready" };
  const resolvedContextFloor = runtimeContext.resolveOllamaContextWindowFloor(contextWindowFloor);
  if (isOllamaAutostartDisabled()) {
    if (resolvedContextFloor > runtimeContext.MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW) {
      console.error(
        "  Ollama is not running on localhost:" +
          `${ollamaPort} and --no-ollama-autostart is set; ` +
          `cannot verify the required ${resolvedContextFloor}-token context window.`,
      );
      if (isNonInteractive() || isOllamaProviderPinned()) process.exit(1);
      return { kind: "continue" };
    }
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
  startDetachedOllamaServe({ port: ollamaPort, contextWindowFloor });
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
