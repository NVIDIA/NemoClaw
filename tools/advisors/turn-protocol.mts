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
  /** Ordinary read-tool paths that must finish successfully before assistant text. */
  requiredReadPaths?: string[];
  /** Seed those read calls and results into Pi history before the first model request. */
  seedRequiredReads?: boolean;
  /** Fail the turn when it completes without non-whitespace assistant analysis. */
  requireAssistantText?: boolean;
  /**
   * Atomic tool that must produce one successful terminal commit.
   * Failed, non-mutating attempts may precede that commit; nothing may follow it.
   */
  atomicTerminalToolName?: string;
  /** Opt into one tool-only continuation when the atomic terminal commit is absent. */
  atomicTerminalRepairPrompt?: string;
  /**
   * Terminal submit tool that may follow context, reads, prose, and other active draft tools.
   * The turn permits one success, or one failed attempt followed by one success when repair is enabled.
   * Nothing may follow a success.
   */
  terminalSubmitToolName?: string;
  /** Opt into one repair in the same SDK turn or one continuation after a settled failure. */
  terminalSubmitRepairPrompt?: string;
  /** Tools available during the terminal-submit repair continuation. */
  terminalSubmitRepairToolNames?: string[];
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
  requiredReadPaths?: string[];
  requireAssistantText: boolean;
  atomicTerminalToolName?: string;
  terminalSubmitToolName?: string;
  terminalSubmitRepairToolNames?: string[];
};

export type AdvisorTurnFlowEvent =
  | { type: "text"; text: string }
  | {
      type: "read";
      path: string;
      offset: number;
      endOffset: number | null;
      fileSize: number;
      reachesEnd: boolean;
    }
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
  const terminalSubmitToolName = normalizedToolNames(
    turn.terminalSubmitToolName ? [turn.terminalSubmitToolName] : undefined,
  )[0];
  const terminalSubmitRepairToolNames = normalizedToolNames(turn.terminalSubmitRepairToolNames);
  const requiredToolNames = uniqueToolNames([
    ...contextToolNames,
    ...normalizedToolNames(turn.requiredToolNames),
    ...requireToolsBeforeText,
    ...(atomicTerminalToolName ? [atomicTerminalToolName] : []),
    ...(terminalSubmitToolName ? [terminalSubmitToolName] : []),
  ]);
  const activeToolNames = uniqueToolNames([
    ...contextToolNames,
    ...normalizedToolNames(turn.activeToolNames),
    ...requiredToolNames,
  ]);
  const unknown = uniqueToolNames([...activeToolNames, ...terminalSubmitRepairToolNames]).filter(
    (toolName) => !availableToolNames.has(toolName),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Advisor turn ${turn.name} references unregistered tool(s): ${unknown.join(", ")}`,
    );
  }
  if (atomicTerminalToolName && terminalSubmitToolName) {
    throw new Error(
      `Advisor turn ${turn.name} cannot combine atomic terminal and preparatory terminal submit tools`,
    );
  }
  if (terminalSubmitRepairToolNames.length > 0 && !terminalSubmitToolName) {
    throw new Error(
      `Advisor turn ${turn.name} terminal submit repair tools require a terminal submit tool`,
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
    requiredReadPaths: [...new Set(turn.requiredReadPaths ?? [])],
    requireAssistantText: turn.requireAssistantText === true,
    atomicTerminalToolName,
    terminalSubmitToolName,
    terminalSubmitRepairToolNames,
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

function terminalSubmitAttemptSequence(events: AdvisorTurnFlowEvent[], toolName: string) {
  const outcomes: Array<"failed" | "successful"> = [];
  let active = false;
  let malformed = false;
  for (const event of events) {
    if (event.type === "tool_start" && event.toolName === toolName) {
      if (active) malformed = true;
      active = true;
      continue;
    }
    if (event.type === "tool_end" && event.toolName === toolName) {
      if (!active) malformed = true;
      active = false;
      outcomes.push(event.isError ? "failed" : "successful");
      continue;
    }
    if (active) malformed = true;
  }
  return { outcomes, malformed, unsettled: active };
}

function hasActivityAfterSuccessfulTerminalSubmit(
  events: AdvisorTurnFlowEvent[],
  toolName: string,
): boolean {
  const successIndex = events.findIndex(
    (event) => event.type === "tool_end" && event.toolName === toolName && !event.isError,
  );
  return successIndex >= 0 && events.slice(successIndex + 1).length > 0;
}

function unexpectedAtomicToolEvent(events: AdvisorTurnFlowEvent[], toolName: string) {
  return events.find((event) =>
    event.type === "text"
      ? Boolean(event.text.trim())
      : event.type !== "read" && event.toolName !== toolName,
  );
}

function terminalSubmitToolErrors(
  turnName: string,
  events: AdvisorTurnFlowEvent[],
  toolName: string,
  repaired = false,
): string[] {
  const counts = terminalToolEventCounts(events, toolName);
  const expectedAttempts = repaired ? 2 : 1;
  const expectedFailures = repaired ? 1 : 0;
  const errors: string[] = [];
  if (counts.starts !== counts.completions) {
    errors.push(
      `${turnName} must settle every ${toolName} attempt ` +
        `(observed ${counts.starts} starts and ${counts.completions} completions)`,
    );
  }
  const sequence = terminalSubmitAttemptSequence(events, toolName);
  if (sequence.malformed) {
    errors.push(`${turnName} emitted a malformed ${toolName} submit attempt sequence`);
  }
  if (
    counts.starts !== expectedAttempts ||
    counts.completions !== expectedAttempts ||
    counts.successfulCompletions !== 1 ||
    counts.failedCompletions !== expectedFailures
  ) {
    errors.push(
      `${turnName} must make exactly ${expectedAttempts} ${toolName} submit attempt(s), ` +
        `with ${expectedFailures} failed and 1 successful completion ` +
        `(observed ${counts.starts} starts, ${counts.successfulCompletions} successful, and ${counts.failedCompletions} failed completions)`,
    );
  }
  const expectedOutcomes = repaired ? ["failed", "successful"] : ["successful"];
  if (sequence.outcomes.join(",") !== expectedOutcomes.join(",")) {
    errors.push(
      `${turnName} must complete ${toolName} attempts in this order: ${expectedOutcomes.join(", ")}`,
    );
  }
  if (hasActivityAfterSuccessfulTerminalSubmit(events, toolName)) {
    errors.push(`${turnName} emitted activity after successful ${toolName}`);
  }
  return errors;
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
      `${turnName} must commit ${toolName} successfully once ` +
        `(observed ${counts.successfulCompletions} successful and ${counts.failedCompletions} failed completions)`,
    );
  }
  const unexpected = unexpectedAtomicToolEvent(events, toolName);
  if (unexpected?.type === "text") {
    errors.push(`${turnName} emitted prose during atomic ${toolName} commit`);
  } else if (unexpected && unexpected.type !== "read") {
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
  terminalSubmitRepaired = false,
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
  const requiredReadCompletionIndexes = new Map<string, number>();
  for (const requiredPath of tools.requiredReadPaths ?? []) {
    const reads = events.flatMap((event, index) =>
      event.type === "read" && event.path === requiredPath ? [{ event, index }] : [],
    );
    if (reads.length === 0) {
      errors.push(`${turnName} omitted required read: ${requiredPath}`);
      continue;
    }
    const fileSizes = new Set(reads.map(({ event }) => event.fileSize));
    const ranges: Array<{ start: number; end: number }> = [];
    const endOffsets: number[] = [];
    let completedAt: number | undefined;
    for (const { event, index } of reads) {
      if (event.endOffset !== null) {
        ranges.push({ start: event.offset, end: event.endOffset });
        ranges.sort((left, right) => left.start - right.start);
      }
      if (event.reachesEnd && event.fileSize > 0) endOffsets.push(event.offset);
      let coveredThrough = 0;
      for (const range of ranges) {
        if (range.start > coveredThrough + 1) break;
        coveredThrough = Math.max(coveredThrough, range.end);
      }
      if (fileSizes.size === 1 && endOffsets.some((offset) => offset <= coveredThrough + 1)) {
        completedAt ??= index;
      }
    }
    if (completedAt === undefined) {
      errors.push(`${turnName} incompletely read required path: ${requiredPath}`);
    } else {
      requiredReadCompletionIndexes.set(requiredPath, completedAt);
    }
    if (firstText >= 0 && (completedAt === undefined || completedAt > firstText)) {
      errors.push(`${turnName} emitted text before required read completed: ${requiredPath}`);
    }
  }
  if ((tools.requiredReadPaths?.length ?? 0) > 0) {
    const allReadsCompletedAt =
      requiredReadCompletionIndexes.size === tools.requiredReadPaths!.length
        ? Math.max(...requiredReadCompletionIndexes.values())
        : Number.POSITIVE_INFINITY;
    const earlyTool = events.find(
      (event, index) =>
        index < allReadsCompletedAt &&
        event.type !== "text" &&
        event.type !== "read" &&
        event.toolName !== "read",
    );
    if (earlyTool && earlyTool.type !== "text" && earlyTool.type !== "read") {
      errors.push(`${turnName} called ${earlyTool.toolName} before required reads completed`);
    }
  }
  if (tools.atomicTerminalToolName) {
    errors.push(...atomicTerminalToolErrors(turnName, events, tools.atomicTerminalToolName));
  }
  if (tools.terminalSubmitToolName) {
    errors.push(
      ...terminalSubmitToolErrors(
        turnName,
        events,
        tools.terminalSubmitToolName,
        terminalSubmitRepaired,
      ),
    );
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

export function repairableTerminalSubmitToolName(
  turn: AdvisorPromptTurn,
  events: AdvisorTurnFlowEvent[],
  tools: AdvisorTurnTools,
  successfulToolNames: ReadonlySet<string>,
  turnError: string | undefined,
): string | undefined {
  if (!turn.terminalSubmitRepairPrompt?.trim() || turnError) return undefined;
  const toolName = tools.terminalSubmitToolName;
  if (!toolName || successfulToolNames.has(toolName)) return undefined;
  const expectedTools = new Set([...READ_ONLY_TOOLS, ...tools.activeToolNames]);
  if (
    events.some(
      (event) =>
        event.type !== "text" && event.type !== "read" && !expectedTools.has(event.toolName),
    )
  ) {
    return undefined;
  }
  const counts = terminalToolEventCounts(events, toolName);
  if (counts.starts !== 1 || counts.completions !== 1) return undefined;
  if (counts.successfulCompletions !== 0 || counts.failedCompletions !== 1) return undefined;
  return toolName;
}

export function hasCompletedTerminalSubmitRepair(
  turn: AdvisorPromptTurn,
  events: AdvisorTurnFlowEvent[],
  tools: AdvisorTurnTools,
  turnError: string | undefined,
): boolean {
  if (!turn.terminalSubmitRepairPrompt?.trim() || turnError) return false;
  const toolName = tools.terminalSubmitToolName;
  if (!toolName) return false;
  const sequence = terminalSubmitAttemptSequence(events, toolName);
  return (
    !sequence.malformed &&
    !sequence.unsettled &&
    sequence.outcomes.join(",") === "failed,successful" &&
    !hasActivityAfterSuccessfulTerminalSubmit(events, toolName)
  );
}

export function terminalSubmitRepairPrompt(turn: AdvisorPromptTurn, toolName: string): string {
  return `${turn.terminalSubmitRepairPrompt?.trim()}\n\nComplete the repair with exactly one successful \`${toolName}\` call. Emit no prose before or after the tool calls.`;
}

export function terminalSubmitRepairErrors(
  turnName: string,
  events: AdvisorTurnFlowEvent[],
  toolName: string,
  repairToolNames: string[],
): string[] {
  const repairName = `${turnName} terminal-submit repair`;
  const allowed = new Set([...(repairToolNames ?? []), toolName]);
  const unexpected = events.find(
    (event) => event.type !== "text" && event.type !== "read" && !allowed.has(event.toolName),
  );
  const errors = terminalSubmitToolErrors(repairName, events, toolName);
  if (events.some((event) => event.type === "text" && event.text.trim())) {
    errors.push(`${repairName} emitted prose during repair`);
  }
  if (unexpected && unexpected.type !== "text" && unexpected.type !== "read") {
    errors.push(`${repairName} called unexpected tool ${unexpected.toolName}`);
  }
  return errors;
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
