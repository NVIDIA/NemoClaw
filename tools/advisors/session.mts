// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { createRepoConfinedReadOnlyTools } from "./repo-read-only-tools.mts";

export const DEFAULT_ADVISOR_PROVIDER = "openai";
export const DEFAULT_ADVISOR_MODEL = "openai/openai/gpt-5.5";
export const NEMOTRON_ULTRA_ADVISOR_MODEL = "nvidia/nvidia/nemotron-3-ultra";
export const ADVISOR_OPENAI_COMPATIBLE_BASE_URL = "https://inference-api.nvidia.com/v1";
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CONTEXT_TOOL_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as unknown as ToolDefinition["parameters"];

type AdvisorProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1];
type AdvisorModelConfig = NonNullable<AdvisorProviderConfig["models"]>[number];

export type RunAdvisorResult = {
  /** Assistant text from the final turn. For single-turn callers, this is the full response. */
  text: string;
  raw: string;
  turnTexts: string[];
  turnErrors: string[];
  turnCallbackErrors: string[];
  fatalError?: string;
};

export function advisorRunErrors(result: RunAdvisorResult): string[] {
  return [
    result.fatalError ? `session: ${result.fatalError}` : undefined,
    ...result.turnErrors.map((error) => `turn: ${error}`),
    ...result.turnCallbackErrors.map((error) => `artifact: ${error}`),
  ].filter((error): error is string => error !== undefined);
}

export type AdvisorContextToolContentType = "diff" | "json" | "text";

export type AdvisorContextToolResult = {
  /** Specific read-only context tool name shown to the model and in session exports. */
  toolName: string;
  /** Human-readable label for artifacts/transcripts. Defaults to toolName. */
  label?: string;
  /** Text returned when the matching context tool is called. */
  content: string;
  /** Content language/format for artifacts and fixed tool-call metadata. */
  contentType: AdvisorContextToolContentType;
  /** Make the context tool return this content as an error. Defaults to false. */
  isError?: boolean;
};

export function createAdvisorContextToolResult(
  toolName: string,
  content: string,
  contentType: AdvisorContextToolContentType,
  label?: string,
): AdvisorContextToolResult {
  return { toolName, content, contentType, label };
}

export type AdvisorPromptTurn = {
  name: string;
  prompt: string;
  /**
   * Deterministic context exposed as required, zero-argument read-only tools for this turn.
   * The runner sends the user prompt first, scopes the session to these context tools, and
   * fails the turn if the model omits any of them.
   */
  contextToolResults?: AdvisorContextToolResult[];
  /** Additional registered custom tools made available only for this turn. */
  activeToolNames?: string[];
  /** Additional tools that must finish successfully during this turn. */
  requiredToolNames?: string[];
  /** Tools that must finish before the assistant emits text. Context tools are included automatically. */
  requireToolsBeforeText?: string[];
  /** Tools that must start after all assistant text, making them the turn's final action. */
  requireTextBeforeToolNames?: string[];
};

export function createAdvisorPromptTurn({
  name,
  contextToolResults,
  prompt,
}: {
  name: string;
  contextToolResults: AdvisorContextToolResult[];
  prompt: (contextToolNames: string) => string;
}): AdvisorPromptTurn {
  const contextToolNames = contextToolResults.map(({ toolName }) => toolName).join("`, `");
  return { name, contextToolResults, prompt: prompt(contextToolNames) };
}

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
  customTools?: ToolDefinition[];
  onTurnStart?: (turn: AdvisorPromptTurn) => void;
  onTurnComplete?: (turn: AdvisorCompletedTurn) => void | Promise<void>;
};

export type AdvisorCompletedTurn = {
  index: number;
  total: number;
  name: string;
  text: string;
  status: "completed" | "failed" | "timed_out";
  error?: string;
};

export type AdvisorTurnSettlement = {
  turn: AdvisorCompletedTurn;
  didThrow: boolean;
  thrown?: unknown;
  callbackError?: string;
};

export async function settleAdvisorTurn(options: {
  index: number;
  total: number;
  name: string;
  run: () => Promise<void>;
  readText: () => string;
  readError: () => string | undefined;
  onTurnComplete?: (turn: AdvisorCompletedTurn) => void | Promise<void>;
}): Promise<AdvisorTurnSettlement> {
  let didThrow = false;
  let thrown: unknown;
  try {
    await options.run();
  } catch (error: unknown) {
    didThrow = true;
    thrown = error;
  }
  const thrownReason = didThrow
    ? normalizeProviderError(errorText(thrown)) || "unknown advisor turn failure"
    : undefined;
  const error = options.readError() || thrownReason;
  const turn: AdvisorCompletedTurn = {
    index: options.index,
    total: options.total,
    name: options.name,
    text: options.readText(),
    status:
      thrownReason && /timed out/iu.test(thrownReason)
        ? "timed_out"
        : error
          ? "failed"
          : "completed",
    error,
  };
  let callbackError: string | undefined;
  try {
    await options.onTurnComplete?.(turn);
  } catch (callbackFailure: unknown) {
    callbackError =
      normalizeProviderError(errorText(callbackFailure)) || "unknown advisor turn callback failure";
  }
  return { turn, didThrow, thrown, callbackError };
}

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
      advisorModel(
        NEMOTRON_ULTRA_ADVISOR_MODEL,
        "Nemotron 3 Ultra",
        256000,
        32768,
        false,
        ["text"],
        {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
          supportsStrictMode: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
        },
      ),
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

export type AdvisorContextToolRuntime = {
  customTools: ToolDefinition[];
  allToolNames: string[];
  toolNamesForTurn: (turn: AdvisorPromptTurn) => string[];
  activateTurn: (turn: AdvisorPromptTurn) => string[];
  deactivate: () => void;
};

/**
 * Build inert context tools up front, then bind their content to one turn at a time.
 * A shared tool name may safely carry different content in different turns because only
 * the active turn's result is visible to its executor.
 */
export function createAdvisorContextToolRuntime(
  promptTurns: AdvisorPromptTurn[],
): AdvisorContextToolRuntime {
  const resultsByTurn = new Map<AdvisorPromptTurn, Map<string, AdvisorContextToolResult>>();
  const firstResultByName = new Map<string, AdvisorContextToolResult>();

  for (const turn of promptTurns) {
    const results = new Map<string, AdvisorContextToolResult>();
    for (const result of turn.contextToolResults ?? []) {
      const toolName = sanitizeToolName(result.toolName);
      if (READ_ONLY_TOOLS.includes(toolName)) {
        throw new Error(
          `Advisor context tool ${JSON.stringify(toolName)} collides with a built-in read-only tool`,
        );
      }
      if (results.has(toolName)) {
        throw new Error(
          `Advisor turn ${JSON.stringify(turn.name)} defines duplicate context tool ${JSON.stringify(toolName)}`,
        );
      }
      const normalized = { ...result, toolName, label: result.label || result.toolName };
      results.set(toolName, normalized);
      if (!firstResultByName.has(toolName)) firstResultByName.set(toolName, normalized);
    }
    resultsByTurn.set(turn, results);
  }

  let activeResults = new Map<string, AdvisorContextToolResult>();
  const customTools = [...firstResultByName].map(([toolName, firstResult]) => {
    const tool: ToolDefinition = {
      name: toolName,
      label: firstResult.label || toolName,
      description:
        "Load deterministic read-only context for the current advisor turn. Call this zero-argument tool before analyzing or answering the turn.",
      promptSnippet: `Load required advisor context from ${toolName}`,
      parameters: CONTEXT_TOOL_PARAMETERS,
      async execute(_toolCallId, _params, signal) {
        const result = activeResults.get(toolName);
        if (!result) {
          throw new Error(`Advisor context tool ${toolName} is not active for this turn`);
        }
        if (signal?.aborted) throw new Error(`Advisor context tool ${toolName} was aborted`);
        if (result.isError === true) throw new Error(result.content);
        return {
          content: [{ type: "text" as const, text: result.content }],
          details: {
            advisorContext: true,
            contentType: result.contentType,
            label: result.label || result.toolName,
          },
        };
      },
    };
    return tool;
  });

  return {
    customTools,
    allToolNames: [...firstResultByName.keys()],
    toolNamesForTurn(turn) {
      return [...(resultsByTurn.get(turn)?.keys() ?? [])];
    },
    activateTurn(turn) {
      activeResults = resultsByTurn.get(turn) ?? new Map();
      return [...activeResults.keys()];
    },
    deactivate() {
      activeResults = new Map();
    },
  };
}

export type AdvisorTurnTools = {
  activeToolNames: string[];
  requiredToolNames: string[];
  requireToolsBeforeText: string[];
  requireTextBeforeToolNames: string[];
};

export type AdvisorTurnFlowEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; isError: boolean };

export function resolveAdvisorTurnTools(
  turn: AdvisorPromptTurn,
  contextToolNames: string[],
  availableToolNames: ReadonlySet<string>,
): AdvisorTurnTools {
  const requireToolsBeforeText = uniqueToolNames([
    ...contextToolNames,
    ...normalizedToolNames(turn.requireToolsBeforeText),
  ]);
  const requireTextBeforeToolNames = normalizedToolNames(turn.requireTextBeforeToolNames);
  const requiredToolNames = uniqueToolNames([
    ...contextToolNames,
    ...normalizedToolNames(turn.requiredToolNames),
    ...requireToolsBeforeText,
    ...requireTextBeforeToolNames,
  ]);
  const activeToolNames = uniqueToolNames([
    ...contextToolNames,
    ...normalizedToolNames(turn.activeToolNames),
    ...requiredToolNames,
  ]);
  const unknown = activeToolNames.filter((toolName) => !availableToolNames.has(toolName));
  if (unknown.length > 0) {
    throw new Error(
      `Advisor turn ${turn.name} references unregistered tool(s): ${unknown.join(", ")}`,
    );
  }
  return {
    activeToolNames,
    requiredToolNames,
    requireToolsBeforeText,
    requireTextBeforeToolNames,
  };
}

export function missingRequiredAdvisorToolNames(
  requiredToolNames: string[],
  successfulToolNames: ReadonlySet<string>,
): string[] {
  return requiredToolNames.filter((toolName) => !successfulToolNames.has(toolName));
}

function finalToolCardinalityErrors(
  turnName: string,
  events: AdvisorTurnFlowEvent[],
  toolName: string,
): string[] {
  const startCount = events.filter(
    (event) => event.type === "tool_start" && event.toolName === toolName,
  ).length;
  const endCount = events.filter(
    (event) => event.type === "tool_end" && event.toolName === toolName,
  ).length;
  const successfulEndCount = events.filter(
    (event) => event.type === "tool_end" && event.toolName === toolName && !event.isError,
  ).length;
  const errors: string[] = [];
  if (startCount !== 1) {
    errors.push(`${turnName} must call ${toolName} exactly once (observed ${startCount} starts)`);
  }
  if (endCount !== 1 || successfulEndCount !== 1) {
    errors.push(
      `${turnName} must finish ${toolName} successfully exactly once ` +
        `(observed ${successfulEndCount} successful of ${endCount} total completions)`,
    );
  }
  return errors;
}

export function advisorTurnFlowErrors(
  turnName: string,
  events: AdvisorTurnFlowEvent[],
  tools: AdvisorTurnTools,
): string[] {
  const errors: string[] = [];
  const textIndexes = events.flatMap((event, index) =>
    event.type === "text" && event.text.trim() ? [index] : [],
  );
  const firstText = textIndexes[0] ?? -1;
  const lastText = textIndexes.at(-1) ?? -1;
  const successfulEnd = (toolName: string): number =>
    events.findIndex(
      (event) => event.type === "tool_end" && event.toolName === toolName && !event.isError,
    );
  const firstStart = (toolName: string): number =>
    events.findIndex((event) => event.type === "tool_start" && event.toolName === toolName);

  for (const toolName of tools.requireToolsBeforeText) {
    const end = successfulEnd(toolName);
    if (firstText >= 0 && (end < 0 || end > firstText)) {
      errors.push(`${turnName} emitted text before ${toolName} completed`);
    }
  }
  for (const toolName of tools.requireTextBeforeToolNames) {
    errors.push(...finalToolCardinalityErrors(turnName, events, toolName));
    const start = firstStart(toolName);
    if (firstText < 0 || start < firstText)
      errors.push(`${turnName} called ${toolName} before analysis`);
    if (start >= 0 && lastText > start) errors.push(`${turnName} emitted text after ${toolName}`);
    const laterTool = events
      .slice(start + 1)
      .find(
        (event) =>
          event.type !== "text" && !tools.requireTextBeforeToolNames.includes(event.toolName),
      );
    if (start >= 0 && laterTool && laterTool.type !== "text") {
      errors.push(`${turnName} called ${laterTool.toolName} after ${toolName}`);
    }
  }
  return errors;
}

function normalizedToolNames(toolNames: string[] | undefined): string[] {
  return uniqueToolNames((toolNames ?? []).map(sanitizeToolName));
}

function uniqueToolNames(toolNames: string[]): string[] {
  return toolNames.filter((toolName, index) => toolNames.indexOf(toolName) === index);
}

export function promptWithRequiredContextTools(prompt: string, toolNames: string[]): string {
  if (toolNames.length === 0) return prompt;
  const tools = toolNames.map((name) => `\`${name}\``).join(", ");
  return `${prompt.trimEnd()}\n\nRequired context tools: ${tools}. Their results are not preloaded; call each before answering.`;
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

  const promptTurns = normalizePromptTurns(options.promptTurns);
  const contextTools = createAdvisorContextToolRuntime(promptTurns);
  const customTools = [
    ...createRepoConfinedReadOnlyTools(options.cwd),
    ...contextTools.customTools,
  ];
  const availableToolNames = new Set(READ_ONLY_TOOLS);
  for (const toolName of contextTools.allToolNames) availableToolNames.add(toolName);
  for (const tool of options.customTools ?? []) {
    const toolName = sanitizeToolName(tool.name);
    if (toolName !== tool.name) {
      throw new Error(`Advisor custom tool name is not normalized: ${JSON.stringify(tool.name)}`);
    }
    if (availableToolNames.has(toolName)) {
      throw new Error(`Advisor custom tool name is already registered: ${toolName}`);
    }
    availableToolNames.add(toolName);
    customTools.push(tool);
  }
  const turnTools = new Map(
    promptTurns.map((turn) => [
      turn,
      resolveAdvisorTurnTools(turn, contextTools.toolNamesForTurn(turn), availableToolNames),
    ]),
  );

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

  const sessionManager = SessionManager.create(
    options.cwd,
    path.join(options.configDir, "sessions"),
  );
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.configDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "medium",
    tools: [...availableToolNames],
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  const rawHeader = [
    modelFallbackMessage ? `[${options.logPrefix}] ${modelFallbackMessage}` : undefined,
    `[${options.logPrefix}] model=${model.provider}/${model.id}`,
    `[${options.logPrefix}] base_url=${model.baseUrl}`,
    `[${options.logPrefix}] tools=${[...availableToolNames].join(",")}`,
    `[${options.logPrefix}] prompt_turns=${promptTurns.length}`,
    "--- ASSISTANT TEXT ---",
  ].filter((line): line is string => Boolean(line));

  const raw = new CappedBuffer(options.maxCaptureBytes, `${rawHeader.join("\n")}\n`);
  const turnTextBuffers: CappedBuffer[] = [];
  const turnErrors: string[] = [];
  const turnCallbackErrors: string[] = [];
  let fatalError: string | undefined;
  let currentTurnText: CappedBuffer | undefined;
  let currentTurnName = "";
  let currentTurnError: string | undefined;
  let successfulToolNames = new Set<string>();
  let currentTurnFlow: AdvisorTurnFlowEvent[] = [];
  let resolveCurrentAgentEnd: (() => void) | undefined;

  const captureTurnError = (source: string, message: string | undefined): void => {
    const normalized = normalizeProviderError(message);
    if (!normalized) return;
    currentTurnError ||= normalized;
    raw.append(`\n[${options.logPrefix}] ${source}: ${normalized}\n`);
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        currentTurnFlow.push({ type: "text", text: event.assistantMessageEvent.delta });
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
    if (event.type === "agent_end") {
      resolveCurrentAgentEnd?.();
      resolveCurrentAgentEnd = undefined;
      return;
    }
    if (event.type === "message_end") {
      captureTurnError("assistant_message_error", assistantMessageError(event.message));
      return;
    }
    if (event.type === "tool_execution_start") {
      currentTurnFlow.push({ type: "tool_start", toolName: event.toolName });
      raw.append(`\n[${options.logPrefix}] tool_start ${event.toolName}\n`);
      return;
    }
    if (event.type === "tool_execution_end") {
      currentTurnFlow.push({
        type: "tool_end",
        toolName: event.toolName,
        isError: event.isError,
      });
      if (!event.isError) successfulToolNames.add(event.toolName);
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
      successfulToolNames = new Set();
      currentTurnFlow = [];
      turnTextBuffers.push(currentTurnText);
      const turnIndex = `${index + 1}/${promptTurns.length}`;
      options.onTurnStart?.(turn);
      contextTools.activateTurn(turn);
      const tools = turnTools.get(turn);
      if (!tools) throw new Error(`Advisor turn ${turn.name} is missing its tool configuration`);
      const contextToolNames = contextTools.toolNamesForTurn(turn);
      session.setActiveToolsByName([...READ_ONLY_TOOLS, ...tools.activeToolNames]);
      const agentEndPromise = new Promise<void>((resolve) => {
        resolveCurrentAgentEnd = resolve;
      });
      raw.append(`\n[${options.logPrefix}] user_turn_start ${turnIndex} ${turn.name}\n`);
      raw.append(
        `[${options.logPrefix}] required_tools ${tools.requiredToolNames.join(",") || "<none>"}\n`,
      );
      options.logProgress(`Advisor SDK turn ${turnIndex}: ${turn.name}`);
      const settlement = await settleAdvisorTurn({
        index: index + 1,
        total: promptTurns.length,
        name: turn.name,
        run: async () => {
          await Promise.race([
            session.prompt(promptWithRequiredContextTools(turn.prompt, contextToolNames)),
            timeoutPromise,
          ]);
          await Promise.race([agentEndPromise, timeoutPromise]);
          const missing = missingRequiredAdvisorToolNames(
            tools.requiredToolNames,
            successfulToolNames,
          );
          const flowErrors = advisorTurnFlowErrors(turn.name, currentTurnFlow, tools);
          if (missing.length > 0)
            flowErrors.unshift(`omitted required tool result(s): ${missing.join(", ")}`);
          if (flowErrors.length > 0) throw new Error(flowErrors.join("; "));
        },
        readText: () => currentTurnText?.toString() ?? "",
        readError: () => currentTurnError,
        onTurnComplete: options.onTurnComplete,
      });
      const turnTextBytes = Buffer.byteLength(settlement.turn.text, "utf8");
      raw.append(
        `\n[${options.logPrefix}] user_turn_end ${turnIndex} ${turn.name} status=${settlement.turn.status} textBytes=${turnTextBytes}\n`,
      );
      options.logProgress(
        `Advisor SDK turn ${turnIndex} settled: ${turn.name} status=${settlement.turn.status} textBytes=${turnTextBytes}`,
      );
      if (settlement.turn.error) {
        turnErrors.push(`${turn.name}: ${settlement.turn.error}`);
      }
      if (settlement.callbackError) {
        turnCallbackErrors.push(`${turn.name}: ${settlement.callbackError}`);
        raw.append(
          `[${options.logPrefix}] turn_artifact_error ${turn.name}: ${settlement.callbackError}\n`,
        );
        options.logProgress(
          `Could not persist advisor turn ${turn.name}: ${settlement.callbackError}`,
        );
      }
      contextTools.deactivate();
      session.setActiveToolsByName(READ_ONLY_TOOLS);
      resolveCurrentAgentEnd = undefined;
      currentTurnText = undefined;
      currentTurnName = "";
      if (settlement.didThrow) {
        throw settlement.thrown instanceof Error
          ? settlement.thrown
          : new Error(settlement.turn.error || "unknown advisor turn failure");
      }
      if (settlement.callbackError) {
        throw new Error(`turn artifact persistence failed: ${settlement.callbackError}`);
      }
    }
  } catch (error: unknown) {
    fatalError = normalizeProviderError(errorText(error)) || "unknown advisor session failure";
    raw.append(`\n[${options.logPrefix}] session_failure: ${fatalError}\n`);
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
    turnCallbackErrors,
    fatalError,
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

function errorText(error: unknown): string {
  if (error === undefined || error === null) return "";
  return error instanceof Error ? error.message : String(error);
}

function normalizePromptTurns(promptTurns: AdvisorPromptTurn[]): AdvisorPromptTurn[] {
  return promptTurns.map((turn, index) => ({
    name: sanitizeTurnName(turn.name || `turn-${index + 1}`),
    prompt: turn.prompt,
    contextToolResults: turn.contextToolResults,
    activeToolNames: normalizedToolNames(turn.activeToolNames),
    requiredToolNames: normalizedToolNames(turn.requiredToolNames),
    requireToolsBeforeText: normalizedToolNames(turn.requireToolsBeforeText),
    requireTextBeforeToolNames: normalizedToolNames(turn.requireTextBeforeToolNames),
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

function sanitizeToolName(name: string): string {
  return (
    name
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 64) || "advisor_context"
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
