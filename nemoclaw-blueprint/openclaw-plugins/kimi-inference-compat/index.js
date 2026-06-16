// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

const KIMI_K26_MODEL_ID = "moonshotai/kimi-k2.6";
const MANAGED_KIMI_K26_MODEL_REF = `inference/${KIMI_K26_MODEL_ID}`;

function isKimiModelId(value) {
  const modelId = normalize(value);
  return modelId === KIMI_K26_MODEL_ID || modelId === MANAGED_KIMI_K26_MODEL_REF;
}

function isManagedKimi(ctx) {
  const model = ctx && ctx.model ? ctx.model : {};
  return (
    normalize(ctx && ctx.provider) === "inference" &&
    [ctx && ctx.modelId, model.id, model.name].some(isKimiModelId) &&
    normalize((ctx && ctx.modelApi) || model.api) === "openai-completions" &&
    normalizeBaseUrl(model.baseUrl) === "https://inference.local/v1"
  );
}

function emptyParameters() {
  return { type: "object", properties: {} };
}

const SAFE_SPLIT_EXEC_COMMANDS = new Set(["hostname", "date", "uptime"]);
const REASONING_FIELD_NAMES = [
  "reasoning",
  "reasoningContent",
  "reasoning_content",
  "reasoningDetails",
  "reasoning_details",
  "thinking",
  "thinkingContent",
  "thinking_content",
];
const REASONING_EVENT_TYPES = new Set([
  "reasoning",
  "reasoning_delta",
  "reasoning.content.delta",
  "thinking",
  "thinking_delta",
  "thinking.content.delta",
]);
const REASONING_CONTENT_TYPES = new Set([
  "reasoning",
  "reasoning_delta",
  "reasoningcontent",
  "reasoning_content",
  "thinking",
  "thinking_delta",
  "thinkingcontent",
  "thinking_content",
]);

function isObjectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stripReasoningFields(value) {
  if (!isObjectRecord(value)) return false;
  let changed = false;
  for (const key of REASONING_FIELD_NAMES) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      delete value[key];
      changed = true;
    }
  }
  return changed;
}

function isReasoningContentBlock(value) {
  if (!isObjectRecord(value)) return false;
  const type = normalize(value.type);
  return REASONING_CONTENT_TYPES.has(type) || type.includes("reasoning") || type.includes("thinking");
}

function stripReasoningContentBlocks(value) {
  if (!Array.isArray(value)) return value;
  return value
    .filter((block) => !isReasoningContentBlock(block))
    .map((block) => {
      stripReasoningFields(block);
      return block;
    });
}

function stripReasoningFromMessage(message) {
  if (!isObjectRecord(message)) return false;
  let changed = stripReasoningFields(message);
  if (Array.isArray(message.content)) {
    const filtered = stripReasoningContentBlocks(message.content);
    if (filtered.length !== message.content.length) changed = true;
    message.content = filtered;
  }
  return changed;
}

function stripReasoningFromChoice(choice) {
  if (!isObjectRecord(choice)) return false;
  let changed = stripReasoningFields(choice);
  changed = stripReasoningFromMessage(choice.message) || changed;
  changed = stripReasoningFromMessage(choice.delta) || changed;
  return changed;
}

function isReasoningEvent(event) {
  if (!isObjectRecord(event)) return false;
  const type = normalize(event.type);
  return REASONING_EVENT_TYPES.has(type) || type.includes("reasoning") || type.includes("thinking");
}

function filterReasoningFromEvent(event) {
  if (!isObjectRecord(event)) return event;
  if (isReasoningEvent(event)) return null;

  stripReasoningFields(event);
  stripReasoningFromMessage(event.message);
  stripReasoningFromMessage(event.partial);
  stripReasoningFromMessage(event.delta);
  if (Array.isArray(event.choices)) {
    for (const choice of event.choices) stripReasoningFromChoice(choice);
  }
  return event;
}

function decodeToolCallArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}

function encodeToolCallArgumentsLike(original, command) {
  if (typeof original === "string") return JSON.stringify({ command });
  return { command };
}

function splitSafeExecCommand(command) {
  if (typeof command !== "string") return null;
  if (!command.includes(";")) return null;
  const parts = command.split(";").map((part) => part.trim());
  if (parts.length < 2) return null;
  if (parts.some((part) => !SAFE_SPLIT_EXEC_COMMANDS.has(part))) return null;
  return parts;
}

function buildSplitToolCallId(originalId, index, command) {
  const rawId = typeof originalId === "string" && originalId.trim() ? originalId.trim() : "kimi_exec";
  const baseId = rawId.replace(/_split_\d+_(hostname|date|uptime)$/, "");
  return `${baseId}_split_${index + 1}_${command}`;
}

function getSafeExecToolCallCommand(toolCall) {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return null;
  if (toolCall.type !== "toolCall" || toolCall.name !== "exec") return null;

  const args = decodeToolCallArguments(toolCall.arguments);
  if (!args) return null;
  const argKeys = Object.keys(args);
  if (argKeys.length !== 1 || argKeys[0] !== "command" || typeof args.command !== "string") {
    return null;
  }

  return args.command;
}

function getExecToolCallCommand(toolCall) {
  return getSafeExecToolCallCommand(toolCall);
}

function getSafeCombinedExecToolCallFromBlock(toolCall) {
  const command = getSafeExecToolCallCommand(toolCall);
  if (command === null) return null;

  const commands = splitSafeExecCommand(command);
  if (!commands) return null;

  return { commands, toolCall };
}

function isSafeExecToolCall(toolCall) {
  return SAFE_SPLIT_EXEC_COMMANDS.has(getExecToolCallCommand(toolCall));
}

function buildSplitToolCalls(toolCall, commands) {
  return commands.map((command, index) => ({
    type: "toolCall",
    id: buildSplitToolCallId(toolCall.id, index, command),
    name: "exec",
    arguments: encodeToolCallArgumentsLike(toolCall.arguments, command),
  }));
}

function dedupeSafeExecToolCalls(content) {
  const seenSafeExecCommands = new Set();
  const deduped = [];
  for (const block of content) {
    const command = getExecToolCallCommand(block);
    if (SAFE_SPLIT_EXEC_COMMANDS.has(command)) {
      if (seenSafeExecCommands.has(command)) continue;
      seenSafeExecCommands.add(command);
    }
    deduped.push(block);
  }
  return deduped;
}

function dedupeAllSafeDiagnosticExecToolCalls(content) {
  if (!content.every(isSafeExecToolCall)) return content;
  return dedupeSafeExecToolCalls(content);
}

function rewriteSafeCombinedExecToolCallsInContent(content) {
  if (!Array.isArray(content)) return { changed: false, content };

  let changed = false;
  const expanded = [];
  for (const block of content) {
    const split = getSafeCombinedExecToolCallFromBlock(block);
    if (split) {
      expanded.push(...dedupeSafeExecToolCalls(buildSplitToolCalls(split.toolCall, split.commands)));
      changed = true;
    } else {
      expanded.push(block);
    }
  }
  if (!changed) return { changed: false, content };

  return { changed: true, content: dedupeAllSafeDiagnosticExecToolCalls(expanded) };
}

function applySafeExecSplitToMessage(message) {
  if (!message || typeof message !== "object") return false;
  const rewritten = rewriteSafeCombinedExecToolCallsInContent(message.content);
  if (!rewritten.changed) return false;
  message.content = rewritten.content;
  if (message.stopReason === "stop") message.stopReason = "toolUse";
  return true;
}

function applySafeExecSplitAtContentIndex(message, split) {
  if (!message || typeof message !== "object" || !Array.isArray(message.content) || !split) {
    return false;
  }
  const index = Number.isInteger(split.contentIndex) ? split.contentIndex : 0;
  if (index < 0 || index >= message.content.length) return false;
  const replacement = dedupeSafeExecToolCalls(buildSplitToolCalls(split.toolCall, split.commands));
  message.content = dedupeAllSafeDiagnosticExecToolCalls([
    ...message.content.slice(0, index),
    ...replacement,
    ...message.content.slice(index + 1),
  ]);
  if (message.stopReason === "stop") message.stopReason = "toolUse";
  return true;
}

function targetSplitCommandIndex(event, split) {
  const rawIndex = Number.isInteger(event && event.contentIndex) ? event.contentIndex : 0;
  const fallbackIndex = Math.min(Math.max(rawIndex, 0), split.commands.length - 1);
  const content = event && event.partial && Array.isArray(event.partial.content)
    ? event.partial.content
    : [];
  const commandAtContentIndex = getExecToolCallCommand(content[rawIndex]);
  const commandIndex = split.commands.findIndex((command) => command === commandAtContentIndex);
  return commandIndex >= 0 ? commandIndex : fallbackIndex;
}

function rewriteSafeCombinedExecToolCallInMessage(message) {
  return applySafeExecSplitToMessage(message);
}

function getSafeCombinedExecToolCallFromEventDelta(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type !== "toolcall_delta") return null;
  const partial = event.partial;
  if (!partial || typeof partial !== "object" || !Array.isArray(partial.content)) return null;
  const index = Number.isInteger(event.contentIndex) ? event.contentIndex : 0;
  const toolCall = partial.content[index];
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return null;
  if (toolCall.type !== "toolCall" || toolCall.name !== "exec") return null;

  const args = decodeToolCallArguments(event.delta);
  if (!args) return null;
  const argKeys = Object.keys(args);
  if (argKeys.length !== 1 || argKeys[0] !== "command" || typeof args.command !== "string") {
    return null;
  }

  const commands = splitSafeExecCommand(args.command);
  if (!commands) return null;
  return { commands, toolCall, contentIndex: index };
}

function rewriteSafeCombinedExecToolCallInEvent(event) {
  if (!event || typeof event !== "object") return false;
  const deltaSplit = getSafeCombinedExecToolCallFromEventDelta(event);

  const partialChanged = applySafeExecSplitToMessage(event.partial);
  const messageChanged = applySafeExecSplitToMessage(event.message);
  let changed = partialChanged || messageChanged;

  if (deltaSplit) {
    if (!partialChanged) applySafeExecSplitAtContentIndex(event.partial, deltaSplit);
    if (!messageChanged) applySafeExecSplitAtContentIndex(event.message, deltaSplit);
    changed = true;
    const targetIndex = targetSplitCommandIndex(event, deltaSplit);
    const targetCommand = deltaSplit.commands[targetIndex];
    event.delta = encodeToolCallArgumentsLike(event.delta, targetCommand);
    if (event.toolCall && typeof event.toolCall === "object" && !Array.isArray(event.toolCall)) {
      event.toolCall = buildSplitToolCalls(deltaSplit.toolCall, deltaSplit.commands)[targetIndex];
    }
  }

  return changed;
}

function wrapStreamFinalMessages(stream) {
  if (!stream || typeof stream !== "object") return stream;

  if (typeof stream.result === "function") {
    const originalResult = stream.result.bind(stream);
    stream.result = async () => {
      const message = await originalResult();
      rewriteSafeCombinedExecToolCallInMessage(message);
      stripReasoningFromMessage(message);
      return message;
    };
  }

  if (typeof stream[Symbol.asyncIterator] === "function") {
    const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          while (true) {
            const result = await iterator.next();
            if (result.done || !result.value || typeof result.value !== "object") {
              return result;
            }
            rewriteSafeCombinedExecToolCallInEvent(result.value);
            const filtered = filterReasoningFromEvent(result.value);
            if (filtered !== null) return { ...result, value: filtered };
          }
        },
        async return(value) {
          if (typeof iterator.return === "function") return iterator.return(value);
          return { done: true, value: undefined };
        },
        async throw(error) {
          if (typeof iterator.throw === "function") return iterator.throw(error);
          throw error;
        },
      };
    };
  }

  return stream;
}

function createSafeExecSplitterWrapper(baseStreamFn) {
  if (typeof baseStreamFn !== "function") return undefined;
  return (model, context, options) => {
    const maybeStream = baseStreamFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) => wrapStreamFinalMessages(stream));
    }
    return wrapStreamFinalMessages(maybeStream);
  };
}

module.exports = {
  id: "nemoclaw-kimi-inference-compat",
  name: "NemoClaw Kimi Inference Compatibility",
  version: "0.1.0",
  description:
    "Normalizes managed inference.local Kimi tool schemas and reasoning output for NemoClaw sandboxes.",
  register(api) {
    api.registerProvider({
      id: "inference",
      label: "NemoClaw managed inference",
      auth: [],
      normalizeToolSchemas(ctx) {
        if (!isManagedKimi(ctx)) return null;
        const tools = Array.isArray(ctx.tools) ? ctx.tools : [];
        return tools.map((tool) => {
          if (!tool || tool.name === "exec") return tool;
          return { ...tool, parameters: emptyParameters() };
        });
      },
      wrapStreamFn(ctx) {
        if (!isManagedKimi(ctx)) return undefined;
        return createSafeExecSplitterWrapper(ctx && ctx.streamFn);
      },
      inspectToolSchemas() {
        return [];
      },
    });
  },
  __testing: {
    createSafeExecSplitterWrapper,
    filterReasoningFromEvent,
    rewriteSafeCombinedExecToolCallInEvent,
    rewriteSafeCombinedExecToolCallInMessage,
    stripReasoningFromMessage,
    splitSafeExecCommand,
  },
};
