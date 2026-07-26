// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ollama runtime context-window helpers.
 *
 * Keep this module focused on data coming from Ollama's `/api/ps` runtime
 * boundary. Onboarding should call the narrow wrappers in `local.ts` instead
 * of re-implementing parsing or process-env state handling.
 */

import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import { OLLAMA_PORT } from "../core/ports";
import { runCapture } from "../runner";

export type OllamaRuntimeRunCaptureFn = (
  cmd: readonly string[],
  opts?: { ignoreError?: boolean },
) => string;

export interface OllamaRuntimeModelStatus {
  probed: boolean;
  loaded: boolean;
  cpuOnly: boolean;
  contextLength?: number;
  contextLengthWarning?: string;
  processor?: string;
  sizeVram?: number;
}

export interface ApplyOllamaRuntimeContextWindowOptions {
  env?: NodeJS.ProcessEnv;
  /** Minimum usable context window for the selected agent. */
  contextWindowFloor?: number;
  logger?: Pick<Console, "log" | "warn">;
  runCaptureImpl?: OllamaRuntimeRunCaptureFn;
}

export type ApplyOllamaRuntimeContextWindowResult = { ok: true } | { ok: false; message: string };

// Four million tokens is intentionally above today's practical local-model
// context windows while still rejecting obviously broken daemon responses.
export const MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW = 4_194_304;

// Floor for auto-adopted runtime context windows. Ollama's stock daemon serves
// `num_ctx=4096` until OLLAMA_CONTEXT_LENGTH is set host-side, which cannot fit
// an agent base prompt + tool catalogue (~7.4 k tokens) plus a single user turn.
// OpenClaw preserves the legacy prompt-budgeting fallback at this floor. Agents
// with a higher floor must prove that the loaded daemon actually provides it.
export const MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW = 16_384;

/**
 * Hermes-specific Ollama floor.
 *
 * Keep this consumer-specific so OpenClaw's Local Ollama defaults stay
 * unchanged while Hermes rejects model context windows below 64,000 tokens.
 */
export const MIN_HERMES_OLLAMA_CONTEXT_WINDOW = 64_000;

function normalizeOllamaModelName(value: unknown): string {
  return String(value || "").trim();
}

export function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  const raw = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function hasExplicitContextWindow(value: unknown): boolean {
  return String(value ?? "").trim() !== "";
}

/** Resolve the minimum Ollama context window required by an agent name. */
export function getOllamaContextWindowFloorForAgent(agentName: string | null | undefined): number {
  return String(agentName ?? "")
    .trim()
    .toLowerCase() === "hermes"
    ? MIN_HERMES_OLLAMA_CONTEXT_WINDOW
    : MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW;
}

/** Normalize an optional agent floor, never returning less than the OpenClaw floor. */
export function resolveOllamaContextWindowFloor(value: unknown): number {
  const parsed = parsePositiveInteger(value);
  return parsed && parsed > MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW
    ? parsed
    : MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW;
}

/**
 * Parse Ollama `/api/ps` `context_length` defensively.
 *
 * Source boundary: `context_length` is produced by the user-managed Ollama
 * daemon outside this repository. NemoClaw can validate before consuming it,
 * but this PR cannot make every installed daemon report a value or enforce a
 * stricter schema at the producer.
 *
 * Tolerated invalid states: older daemons omitting the field, empty values,
 * non-integer/malformed values, non-positive values, unsafe integers, and
 * values above NemoClaw's auto-detect ceiling. Missing values are a silent
 * compatibility no-op; malformed or implausible values return a warning and
 * fall back to the existing NEMOCLAW_CONTEXT_WINDOW/default path.
 *
 * Regression coverage lives in `ollama-runtime-context.test.ts` for omitted,
 * malformed, non-positive, valid string/number, and over-ceiling responses.
 * Remove this fallback once NemoClaw requires an Ollama daemon contract that
 * always reports a validated positive integer `context_length` for loaded
 * models.
 */
export function parseOllamaRuntimeContextLength(value: unknown): {
  contextLength?: number;
  warning?: string;
} {
  if (value === undefined || value === null || String(value).trim() === "") {
    return {};
  }
  const parsed = parsePositiveInteger(value);
  if (!parsed) {
    return {
      warning: `Ollama /api/ps returned a non-positive or malformed context_length (${String(value)}); ignoring it.`,
    };
  }
  if (parsed > MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW) {
    return {
      warning:
        `Ollama /api/ps returned context_length=${parsed}, above NemoClaw's ` +
        `auto-detect ceiling (${MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW}); ignoring it.`,
    };
  }
  return { contextLength: parsed };
}

export function probeOllamaRuntimeModelStatus(
  model: string,
  getOllamaHost: () => string,
  runCaptureImpl?: OllamaRuntimeRunCaptureFn,
): OllamaRuntimeModelStatus {
  const capture = runCaptureImpl ?? runCapture;
  const host = getOllamaHost();
  const output = capture(
    [
      "curl",
      ...buildValidatedCurlCommandArgs([
        "-sf",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        `http://${host}:${OLLAMA_PORT}/api/ps`,
      ]),
    ],
    { ignoreError: true },
  );
  if (!output) return { probed: false, loaded: false, cpuOnly: false };

  try {
    const parsed = JSON.parse(String(output || ""));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const target = normalizeOllamaModelName(model);
    const loaded = models.find((entry: { name?: unknown; model?: unknown }) => {
      return (
        normalizeOllamaModelName(entry?.name) === target ||
        normalizeOllamaModelName(entry?.model) === target
      );
    });
    if (!loaded) return { probed: true, loaded: false, cpuOnly: false };

    const rawSizeVram = Number((loaded as { size_vram?: unknown }).size_vram);
    const hasSizeVram = Number.isFinite(rawSizeVram);
    const contextLengthResult = parseOllamaRuntimeContextLength(
      (loaded as { context_length?: unknown }).context_length,
    );
    const processor = normalizeOllamaModelName((loaded as { processor?: unknown }).processor);
    const mentionsGpu = /\bGPU\b/i.test(processor);
    const processorCpuOnly = /\bCPU\b/i.test(processor) && !mentionsGpu;
    const sizeVramCpuOnly = hasSizeVram && rawSizeVram === 0 && !mentionsGpu;

    return {
      probed: true,
      loaded: true,
      cpuOnly: processorCpuOnly || sizeVramCpuOnly,
      ...(contextLengthResult.contextLength
        ? { contextLength: contextLengthResult.contextLength }
        : {}),
      ...(contextLengthResult.warning ? { contextLengthWarning: contextLengthResult.warning } : {}),
      ...(processor ? { processor } : {}),
      ...(hasSizeVram ? { sizeVram: rawSizeVram } : {}),
    };
  } catch {
    return { probed: true, loaded: false, cpuOnly: false };
  }
}

export function resolveOllamaRuntimeContextWindow(
  model: string,
  currentContextWindow: string | null | undefined,
  getOllamaHost: () => string,
  runCaptureImpl?: OllamaRuntimeRunCaptureFn,
): number | null {
  if (hasExplicitContextWindow(currentContextWindow)) return null;
  const runtimeStatus = probeOllamaRuntimeModelStatus(model, getOllamaHost, runCaptureImpl);
  return runtimeStatus.loaded ? (runtimeStatus.contextLength ?? null) : null;
}

let autoDetectedOllamaContextWindow: string | null = null;

export function resetOllamaRuntimeContextWindowAutoState(): void {
  autoDetectedOllamaContextWindow = null;
}

/**
 * Adopt the loaded Ollama model's runtime context length. Agent floors above
 * the legacy minimum are strict: the loaded daemon must report at least the
 * required length even when `NEMOCLAW_CONTEXT_WINDOW` is explicitly set.
 */
export function applyOllamaRuntimeContextWindow(
  selectedModel: string,
  getOllamaHost: () => string,
  options: ApplyOllamaRuntimeContextWindowOptions = {},
): ApplyOllamaRuntimeContextWindowResult {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const contextWindowFloor = resolveOllamaContextWindowFloor(options.contextWindowFloor);
  const strictRuntimeFloor = contextWindowFloor > MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW;
  const currentContextWindow = env.NEMOCLAW_CONTEXT_WINDOW;
  const currentIsPreviousAuto =
    !!currentContextWindow &&
    !!autoDetectedOllamaContextWindow &&
    currentContextWindow === autoDetectedOllamaContextWindow;
  const userContextWindow = currentIsPreviousAuto ? null : currentContextWindow;

  if (!strictRuntimeFloor && hasExplicitContextWindow(userContextWindow)) {
    logger.log(`  ℹ Keeping configured context window: ${userContextWindow} tokens`);
    return { ok: true };
  }

  const runtimeStatus = probeOllamaRuntimeModelStatus(
    selectedModel,
    getOllamaHost,
    options.runCaptureImpl,
  );
  if (runtimeStatus.contextLengthWarning) {
    logger.warn(`  ⚠ ${runtimeStatus.contextLengthWarning}`);
  }

  if (strictRuntimeFloor) {
    const configuredContextWindow = hasExplicitContextWindow(userContextWindow)
      ? parsePositiveInteger(userContextWindow)
      : null;
    const requiredContextWindow = Math.max(
      contextWindowFloor,
      configuredContextWindow ?? contextWindowFloor,
    );
    const clearPreviousAuto = () => {
      if (!currentIsPreviousAuto) return;
      delete env.NEMOCLAW_CONTEXT_WINDOW;
      autoDetectedOllamaContextWindow = null;
    };
    const remediation =
      `Configure or restart the host Ollama daemon with OLLAMA_CONTEXT_LENGTH=${requiredContextWindow}, ` +
      "then rerun onboarding.";

    if (hasExplicitContextWindow(userContextWindow) && !configuredContextWindow) {
      clearPreviousAuto();
      return {
        ok: false,
        message:
          `NEMOCLAW_CONTEXT_WINDOW must be a positive integer at least ${contextWindowFloor} ` +
          `for this agent. ${remediation}`,
      };
    }
    if (configuredContextWindow !== null && configuredContextWindow < contextWindowFloor) {
      clearPreviousAuto();
      return {
        ok: false,
        message:
          `NEMOCLAW_CONTEXT_WINDOW=${configuredContextWindow} is below this agent's required ` +
          `${contextWindowFloor}-token floor. ${remediation}`,
      };
    }
    if (!runtimeStatus.loaded || !runtimeStatus.contextLength) {
      clearPreviousAuto();
      return {
        ok: false,
        message:
          `Ollama did not report a valid runtime context_length for loaded model ` +
          `'${selectedModel}', so NemoClaw cannot verify the required ${requiredContextWindow}-token ` +
          `window. ${remediation}`,
      };
    }
    if (runtimeStatus.contextLength < requiredContextWindow) {
      clearPreviousAuto();
      return {
        ok: false,
        message:
          `Ollama reports context_length=${runtimeStatus.contextLength} for loaded model ` +
          `'${selectedModel}', below the required ${requiredContextWindow}-token window. ` +
          remediation,
      };
    }
    if (hasExplicitContextWindow(userContextWindow)) {
      logger.log(`  ℹ Keeping configured context window: ${userContextWindow} tokens`);
      return { ok: true };
    }
  }

  if (runtimeStatus.loaded && runtimeStatus.contextLength) {
    const detected = runtimeStatus.contextLength;
    const adopted = Math.max(detected, contextWindowFloor);
    const value = String(adopted);
    env.NEMOCLAW_CONTEXT_WINDOW = value;
    autoDetectedOllamaContextWindow = value;
    if (adopted > detected) {
      logger.log(
        `  ✓ Raising Ollama runtime context window to ${adopted} tokens ` +
          `(daemon reported ${detected}, below the ${contextWindowFloor}-token agent floor). ` +
          `Set OLLAMA_CONTEXT_LENGTH host-side to raise the daemon default and silence this autoset.`,
      );
    } else {
      logger.log(`  ✓ Using Ollama runtime context length: ${value} tokens`);
    }
    return { ok: true };
  }

  if (currentIsPreviousAuto) {
    delete env.NEMOCLAW_CONTEXT_WINDOW;
    autoDetectedOllamaContextWindow = null;
  }
  return { ok: true };
}
