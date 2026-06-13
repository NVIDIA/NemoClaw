// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_ADVISOR_PROVIDER = "openai";
export const DEFAULT_ADVISOR_MODEL = "openai/openai/gpt-5.5";
export const ADVISOR_OPENAI_COMPATIBLE_BASE_URL = "https://inference-api.nvidia.com/v1";
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type AdvisorProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1];
type AdvisorModelConfig = NonNullable<AdvisorProviderConfig["models"]>[number];

export type RunAdvisorResult = {
  /** Assistant text from the final turn. For single-turn callers, this is the full response. */
  text: string;
  raw: string;
  turnTexts: string[];
  turnErrors: string[];
};

export type AdvisorPromptTurn = {
  name: string;
  prompt: string;
};

export type RunReadOnlyAdvisorOptions = {
  cwd: string;
  promptTurns: AdvisorPromptTurn[];
  systemPrompt: string;
  configDir: string;
  htmlExportPath: string;
  timeoutMs: number;
  heartbeatMs: number;
  maxCaptureBytes: number;
  provider?: string;
  modelId?: string;
  credentialEnv: string;
  logPrefix: string;
  logProgress: (message: string) => void;
};

export function openAiAdvisorProviderConfig(credentialEnv: string): AdvisorProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: ADVISOR_OPENAI_COMPATIBLE_BASE_URL,
    models: [
      advisorModel(DEFAULT_ADVISOR_MODEL, "GPT-5.5", 256000, 32768, false, ["text", "image"], {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
        supportsStrictMode: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      }),
    ],
    ["api" + "Key"]: credentialEnv,
  } as AdvisorProviderConfig;
}

export function advisorModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  reasoning: boolean,
  input: ("text" | "image")[],
  compat?: AdvisorModelConfig["compat"],
): AdvisorModelConfig {
  return { id, name, reasoning, input, cost: ZERO_COST, contextWindow, maxTokens, compat };
}

export async function runReadOnlyAdvisor(
  options: RunReadOnlyAdvisorOptions,
): Promise<RunAdvisorResult> {
  fs.mkdirSync(options.configDir, { recursive: true });
  const provider = options.provider || DEFAULT_ADVISOR_PROVIDER;
  const modelId = options.modelId || DEFAULT_ADVISOR_MODEL;
  const { authStorage, modelRegistry } = prepareAdvisorConfig(provider, options.credentialEnv);
  const model = modelRegistry.find(provider, modelId);
  if (!model || !modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `Could not configure advisor model ${provider}/${modelId}; set ${options.credentialEnv}`,
    );
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.configDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.configDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "medium",
    tools: READ_ONLY_TOOLS,
    resourceLoader,
    sessionManager: SessionManager.create(options.cwd, path.join(options.configDir, "sessions")),
    settingsManager,
  });

  const promptTurns = normalizePromptTurns(options.promptTurns);
  const rawHeader = [
    modelFallbackMessage ? `[${options.logPrefix}] ${modelFallbackMessage}` : undefined,
    `[${options.logPrefix}] model=${model.provider}/${model.id}`,
    `[${options.logPrefix}] base_url=${model.baseUrl}`,
    `[${options.logPrefix}] tools=${READ_ONLY_TOOLS.join(",")}`,
    `[${options.logPrefix}] prompt_turns=${promptTurns.length}`,
    "--- ASSISTANT TEXT ---",
  ].filter((line): line is string => Boolean(line));

  const raw = new CappedBuffer(options.maxCaptureBytes, `${rawHeader.join("\n")}\n`);
  const turnTextBuffers: CappedBuffer[] = [];
  const turnErrors: string[] = [];
  let currentTurnText: CappedBuffer | undefined;
  let currentTurnName = "";
  let currentTurnError: string | undefined;

  const captureTurnError = (source: string, message: string | undefined): void => {
    const normalized = normalizeProviderError(message);
    if (!normalized) return;
    currentTurnError ||= normalized;
    raw.append(`\n[${options.logPrefix}] ${source}: ${normalized}\n`);
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        currentTurnText?.append(event.assistantMessageEvent.delta);
        raw.append(event.assistantMessageEvent.delta);
        return;
      }
      if (event.assistantMessageEvent.type === "error") {
        captureTurnError(
          "assistant_stream_error",
          event.assistantMessageEvent.error.errorMessage || event.assistantMessageEvent.reason,
        );
        return;
      }
      return;
    }
    if (event.type === "message_end") {
      captureTurnError("assistant_message_error", assistantMessageError(event.message));
      return;
    }
    if (event.type === "tool_execution_start") {
      raw.append(`\n[${options.logPrefix}] tool_start ${event.toolName}\n`);
      return;
    }
    if (event.type === "tool_execution_end") {
      raw.append(
        `[${options.logPrefix}] tool_end ${event.toolName} ${event.isError ? "error" : "ok"}\n`,
      );
      return;
    }
    if (event.type === "auto_retry_start") {
      raw.append(
        `[${options.logPrefix}] retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}\n`,
      );
    }
  });

  const startedAt = Date.now();
  const heartbeat = setInterval(
    () => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const turnSuffix = currentTurnName ? ` current_turn=${currentTurnName}` : "";
      options.logProgress(
        `Advisor SDK still running: elapsed=${elapsedSeconds}s timeout=${Math.round(options.timeoutMs / 1000)}s${turnSuffix}`,
      );
    },
    Math.max(options.heartbeatMs, 1000),
  );
  heartbeat.unref?.();

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      options.logProgress(`Advisor SDK exceeded timeoutMs=${options.timeoutMs}; aborting session`);
      void session.abort();
      reject(new Error(`timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    timeout.unref?.();
  });

  try {
    for (const [index, turn] of promptTurns.entries()) {
      currentTurnName = turn.name;
      currentTurnText = new CappedBuffer(options.maxCaptureBytes);
      currentTurnError = undefined;
      turnTextBuffers.push(currentTurnText);
      const turnIndex = `${index + 1}/${promptTurns.length}`;
      raw.append(`\n[${options.logPrefix}] user_turn_start ${turnIndex} ${turn.name}\n`);
      options.logProgress(`Advisor SDK turn ${turnIndex}: ${turn.name}`);
      await Promise.race([session.prompt(turn.prompt), timeoutPromise]);
      const turnTextBytes = Buffer.byteLength(currentTurnText.toString(), "utf8");
      raw.append(
        `\n[${options.logPrefix}] user_turn_end ${turnIndex} ${turn.name} textBytes=${turnTextBytes}\n`,
      );
      if (currentTurnError) {
        turnErrors.push(`${turn.name}: ${currentTurnError}`);
      }
      currentTurnText = undefined;
      currentTurnName = "";
    }
  } finally {
    unsubscribe();
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
    try {
      const exportedPath = await session.exportToHtml(options.htmlExportPath);
      raw.append(`\n[${options.logPrefix}] exported_session_html=${exportedPath}\n`);
      options.logProgress(`Exported advisor session HTML: ${exportedPath}`);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      raw.append(`\n[${options.logPrefix}] failed_to_export_session_html=${reason}\n`);
      options.logProgress(`Failed to export advisor session HTML: ${reason}`);
    }
    session.dispose();
  }

  const truncationNotes: string[] = [];
  const droppedAssistantBytes = turnTextBuffers.reduce(
    (total, buffer) => total + buffer.droppedBytes,
    0,
  );
  if (droppedAssistantBytes > 0) {
    truncationNotes.push(`<assistant text truncated; dropped ${droppedAssistantBytes} byte(s)>`);
  }
  if (raw.droppedBytes > 0)
    truncationNotes.push(`<raw output truncated; dropped ${raw.droppedBytes} byte(s)>`);
  if (truncationNotes.length > 0) raw.appendFooter(`\n${truncationNotes.join("\n")}\n`);

  const turnTexts = turnTextBuffers.map((buffer) => buffer.toString());
  return {
    text: turnTexts.at(-1) || "",
    raw: raw.toStringWithTrailingNewline(),
    turnTexts,
    turnErrors,
  };
}

function assistantMessageError(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (record.role !== "assistant") return undefined;
  if (record.stopReason !== "error" && record.stopReason !== "aborted") return undefined;
  return typeof record.errorMessage === "string" && record.errorMessage.trim()
    ? record.errorMessage
    : String(record.stopReason);
}

function normalizeProviderError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const normalized = message.trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

function normalizePromptTurns(promptTurns: AdvisorPromptTurn[]): AdvisorPromptTurn[] {
  return promptTurns.map((turn, index) => ({
    name: sanitizeTurnName(turn.name || `turn-${index + 1}`),
    prompt: turn.prompt,
  }));
}

function sanitizeTurnName(name: string): string {
  return (
    name
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9._-]/g, "")
      .slice(0, 80) || "turn"
  );
}

export class CappedBuffer {
  private readonly maxBytes: number;
  private value: string;
  public droppedBytes = 0;

  constructor(maxBytes: number, initialValue = "") {
    this.maxBytes = maxBytes;
    this.value = initialValue;
    this.trimToMaxBytes();
  }

  append(chunk: string): void {
    this.value += chunk;
    this.trimToMaxBytes();
  }

  appendFooter(footer: string): void {
    const footerBytes = Buffer.byteLength(footer, "utf8");
    if (footerBytes >= this.maxBytes) {
      this.value = trimHeadToBytes(footer, this.maxBytes);
      return;
    }
    this.trimToMaxBytes(this.maxBytes - footerBytes);
    this.value += footer;
  }

  toString(): string {
    return this.value;
  }

  toStringWithTrailingNewline(): string {
    return this.value.endsWith("\n") ? this.value : `${this.value}\n`;
  }

  private trimToMaxBytes(maxBytes = this.maxBytes): void {
    if (Buffer.byteLength(this.value, "utf8") <= maxBytes) return;
    const trimmed = trimHeadToBytes(this.value, maxBytes);
    this.droppedBytes += Buffer.byteLength(
      this.value.slice(0, this.value.length - trimmed.length),
      "utf8",
    );
    this.value = trimmed;
  }
}

function prepareAdvisorConfig(
  provider: string,
  credentialEnv: string,
): { authStorage: AuthStorage; modelRegistry: ModelRegistry } {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const credential = process.env[credentialEnv]?.trim();
  if (credential) {
    authStorage.setRuntimeApiKey(provider, credential);
    modelRegistry.registerProvider(provider, openAiAdvisorProviderConfig(credentialEnv));
  }
  return { authStorage, modelRegistry };
}

function trimHeadToBytes(value: string, maxBytes: number): string {
  let removeChars = Math.min(
    value.length,
    Math.max(1, Buffer.byteLength(value, "utf8") - maxBytes),
  );
  while (
    removeChars < value.length &&
    Buffer.byteLength(value.slice(removeChars), "utf8") > maxBytes
  ) {
    removeChars += 1;
  }
  return value.slice(removeChars);
}
