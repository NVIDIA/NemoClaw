// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

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
  /** Deterministic context exposed as required zero-argument tools for this turn. */
  contextToolResults?: AdvisorContextToolResult[];
  /** Additional registered custom tools made available only for this turn. */
  activeToolNames?: string[];
  /** Additional tools that must finish successfully during this turn. */
  requiredToolNames?: string[];
  /** Tools that must finish before the assistant emits text. Context tools are included. */
  requireToolsBeforeText?: string[];
  /** Fail the turn when it completes without non-whitespace assistant analysis. */
  requireAssistantText?: boolean;
  /**
   * Atomic tool that must produce exactly one successful terminal commit.
   * Failed, non-mutating attempts may precede that commit; nothing may follow it.
   */
  atomicTerminalToolName?: string;
  /** Opt into one tool-only continuation when the atomic terminal commit is absent. */
  atomicTerminalRepairPrompt?: string;
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

export type AdvisorTurnTools = {
  activeToolNames: string[];
  requiredToolNames: string[];
  requireToolsBeforeText: string[];
  requireAssistantText: boolean;
  atomicTerminalToolName?: string;
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
  const atomicTerminalToolName = normalizedToolNames(
    turn.atomicTerminalToolName ? [turn.atomicTerminalToolName] : undefined,
  )[0];
  const requiredToolNames = uniqueToolNames([
    ...contextToolNames,
    ...normalizedToolNames(turn.requiredToolNames),
    ...requireToolsBeforeText,
    ...(atomicTerminalToolName ? [atomicTerminalToolName] : []),
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
  if (
    atomicTerminalToolName &&
    (contextToolNames.length > 0 ||
      requireToolsBeforeText.length > 0 ||
      turn.requireAssistantText === true ||
      activeToolNames.length !== 1 ||
      activeToolNames[0] !== atomicTerminalToolName ||
      requiredToolNames.length !== 1 ||
      requiredToolNames[0] !== atomicTerminalToolName)
  ) {
    throw new Error(
      `Advisor turn ${turn.name} atomic terminal tool must be the turn's only active and required tool, with no context or assistant-text requirement`,
    );
  }
  return {
    activeToolNames,
    requiredToolNames,
    requireToolsBeforeText,
    requireAssistantText: turn.requireAssistantText === true,
    atomicTerminalToolName,
  };
}

export function missingRequiredAdvisorToolNames(
  requiredToolNames: string[],
  successfulToolNames: ReadonlySet<string>,
): string[] {
  return requiredToolNames.filter((toolName) => !successfulToolNames.has(toolName));
}

function terminalToolEventCounts(events: AdvisorTurnFlowEvent[], toolName: string) {
  const starts = events.filter(
    (event) => event.type === "tool_start" && event.toolName === toolName,
  ).length;
  const completions = events.filter(
    (event): event is Extract<AdvisorTurnFlowEvent, { type: "tool_end" }> =>
      event.type === "tool_end" && event.toolName === toolName,
  );
  return {
    starts,
    completions: completions.length,
    successfulCompletions: completions.filter((event) => !event.isError).length,
    failedCompletions: completions.filter((event) => event.isError).length,
  };
}

function unexpectedAtomicToolEvent(events: AdvisorTurnFlowEvent[], toolName: string) {
  return events.find((event) =>
    event.type === "text" ? Boolean(event.text.trim()) : event.toolName !== toolName,
  );
}

function atomicTerminalToolErrors(
  turnName: string,
  events: AdvisorTurnFlowEvent[],
  toolName: string,
): string[] {
  const counts = terminalToolEventCounts(events, toolName);
  const errors: string[] = [];
  if (counts.starts !== counts.completions) {
    errors.push(
      `${turnName} must settle every ${toolName} attempt ` +
        `(observed ${counts.starts} starts and ${counts.completions} completions)`,
    );
  }
  if (counts.successfulCompletions !== 1) {
    errors.push(
      `${turnName} must commit ${toolName} successfully exactly once ` +
        `(observed ${counts.successfulCompletions} successful and ${counts.failedCompletions} failed completions)`,
    );
  }
  const unexpected = unexpectedAtomicToolEvent(events, toolName);
  if (unexpected?.type === "text") {
    errors.push(`${turnName} emitted prose during atomic ${toolName} commit`);
  } else if (unexpected) {
    errors.push(`${turnName} called unexpected tool ${unexpected.toolName} during atomic commit`);
  }
  const successIndex = events.findIndex(
    (event) => event.type === "tool_end" && event.toolName === toolName && !event.isError,
  );
  if (successIndex >= 0 && events.slice(successIndex + 1).length > 0) {
    errors.push(`${turnName} emitted activity after successful ${toolName}`);
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
  const successfulEnd = (toolName: string): number =>
    events.findIndex(
      (event) => event.type === "tool_end" && event.toolName === toolName && !event.isError,
    );

  if (tools.requireAssistantText && firstText < 0) {
    errors.push(`${turnName} omitted required analysis`);
  }
  for (const toolName of tools.requireToolsBeforeText) {
    const end = successfulEnd(toolName);
    if (firstText >= 0 && (end < 0 || end > firstText)) {
      errors.push(`${turnName} emitted text before ${toolName} completed`);
    }
  }
  if (tools.atomicTerminalToolName) {
    errors.push(...atomicTerminalToolErrors(turnName, events, tools.atomicTerminalToolName));
  }
  return errors;
}

export function repairableAtomicTerminalToolName(
  turn: AdvisorPromptTurn,
  events: AdvisorTurnFlowEvent[],
  tools: AdvisorTurnTools,
  successfulToolNames: ReadonlySet<string>,
  turnError: string | undefined,
): string | undefined {
  if (!turn.atomicTerminalRepairPrompt?.trim() || turnError) return undefined;
  const toolName = tools.atomicTerminalToolName;
  if (!toolName || successfulToolNames.has(toolName)) return undefined;
  if (unexpectedAtomicToolEvent(events, toolName)) return undefined;
  const counts = terminalToolEventCounts(events, toolName);
  if (counts.starts !== counts.completions) return undefined;
  if (counts.successfulCompletions > 0) return undefined;
  if (counts.completions !== counts.failedCompletions) return undefined;
  return toolName;
}

export function atomicTerminalRepairPrompt(turn: AdvisorPromptTurn, toolName: string): string {
  return `${turn.atomicTerminalRepairPrompt?.trim()}\n\nCall \`${toolName}\` now. Emit no prose before or after the tool call.`;
}

export function atomicTerminalRepairErrors(
  turnName: string,
  events: AdvisorTurnFlowEvent[],
  toolName: string,
): string[] {
  const repairName = `${turnName} atomic-terminal repair`;
  return atomicTerminalToolErrors(repairName, events, toolName);
}

export function normalizedToolNames(toolNames: string[] | undefined): string[] {
  return uniqueToolNames((toolNames ?? []).map(sanitizeToolName));
}

function uniqueToolNames(toolNames: string[]): string[] {
  return toolNames.filter((toolName, index) => toolNames.indexOf(toolName) === index);
}

export function sanitizeToolName(name: string): string {
  return (
    name
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 64) || "advisor_context"
  );
}

export function promptWithRequiredContextTools(prompt: string, toolNames: string[]): string {
  if (toolNames.length === 0) return prompt;
  const tools = toolNames.map((name) => `\`${name}\``).join(", ");
  return `${prompt.trimEnd()}\n\nRequired context tools: ${tools}. Their results are not preloaded; call each before answering.`;
}
