// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type AgentToolResult,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type LsOperations,
  type ToolDefinition,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
export const MAX_ADVISOR_TOOL_RESULT_JSON_BYTES = 16 * 1024;

type RepoPathGuard = {
  resolveExisting(candidate: string): Promise<string>;
};

export type AdvisorReadObservation = Readonly<{
  path: string;
  offset: number;
  endOffset: number | null;
  fileSize: number;
  reachesEnd: boolean;
}>;

type TruncationDetails = Readonly<{
  truncation?: TruncationResult;
}>;

function compactTruncationDetails<T>(details: T): T {
  if (details === undefined || typeof details !== "object" || details === null) return details;
  const record = details as Record<string, unknown>;
  const truncation = record.truncation;
  if (typeof truncation !== "object" || truncation === null) return details;

  return {
    ...record,
    truncation: { ...(truncation as Record<string, unknown>), content: "" },
  } as T;
}

function serializedToolResultBytes(result: AgentToolResult<unknown>): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

/**
 * Keep native Pi tool-result session records readable by the synthesis advisor.
 * Pi's default 50 KiB truncation details repeat the visible content, and JSON escaping
 * can expand it again. Bound the serialized result instead of assuming raw text bytes
 * predict the eventual JSONL line size.
 */
function boundAdvisorToolResult<T>(
  result: AgentToolResult<T>,
  continuationNotice: (outputLines: number) => string,
): AgentToolResult<T> {
  const originalDetails = result.details as (T & TruncationDetails) | undefined;
  const compactDetails = compactTruncationDetails(result.details);
  const compactResult = { ...result, details: compactDetails };
  if (serializedToolResultBytes(compactResult) <= MAX_ADVISOR_TOOL_RESULT_JSON_BYTES) {
    return compactResult;
  }

  const textIndex = result.content.findIndex((item) => item.type === "text");
  const textItem = result.content[textIndex];
  if (textIndex < 0 || textItem?.type !== "text") {
    return {
      content: [
        {
          type: "text",
          text: "[Advisor tool result omitted because it exceeds the session safety limit.]",
        },
      ],
      details: undefined,
    } as AgentToolResult<T>;
  }

  const originalTruncation = originalDetails?.truncation;
  const sourceText = originalTruncation?.content || textItem.text;
  const sourceLines = sourceText.split("\n");
  const totalLines = originalTruncation?.totalLines ?? sourceLines.length;
  const totalBytes = originalTruncation?.totalBytes ?? Buffer.byteLength(sourceText, "utf8");

  const candidate = (outputLines: number): AgentToolResult<T> => {
    const prefix = sourceLines.slice(0, outputLines).join("\n");
    const notice = continuationNotice(outputLines);
    const text = prefix.length > 0 ? `${prefix}\n\n${notice}` : notice;
    const truncation: TruncationResult = {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines,
      outputBytes: Buffer.byteLength(prefix, "utf8"),
      lastLinePartial: false,
      firstLineExceedsLimit: outputLines === 0,
      maxLines: originalTruncation?.maxLines ?? Number.MAX_SAFE_INTEGER,
      maxBytes: MAX_ADVISOR_TOOL_RESULT_JSON_BYTES,
    };
    const details = {
      ...((compactDetails as Record<string, unknown> | undefined) ?? {}),
      truncation,
    } as T;
    return {
      ...result,
      content: result.content.map((item, index) =>
        index === textIndex && item.type === "text" ? { ...item, text } : item,
      ),
      details,
    };
  };

  let low = 0;
  let high = sourceLines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedToolResultBytes(candidate(middle)) <= MAX_ADVISOR_TOOL_RESULT_JSON_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const bounded = candidate(low);
  if (serializedToolResultBytes(bounded) <= MAX_ADVISOR_TOOL_RESULT_JSON_BYTES) return bounded;

  return {
    ...bounded,
    content: [bounded.content[textIndex]!],
  };
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function createRepoPathGuard(cwd: string): RepoPathGuard {
  const lexicalRoot = path.resolve(cwd);
  const realRoot = fs.realpathSync(lexicalRoot);

  return {
    async resolveExisting(candidate) {
      const withoutAtPrefix = candidate.startsWith("@") ? candidate.slice(1) : candidate;
      const normalizedCandidate = withoutAtPrefix.replace(PI_UNICODE_SPACES, " ");
      const expandedCandidate =
        normalizedCandidate === "~"
          ? os.homedir()
          : normalizedCandidate.startsWith("~/")
            ? path.join(os.homedir(), normalizedCandidate.slice(2))
            : normalizedCandidate;
      const lexicalPath = path.resolve(lexicalRoot, expandedCandidate);
      if (!isContainedPath(lexicalRoot, lexicalPath) && !isContainedPath(realRoot, lexicalPath)) {
        throw new Error(`Advisor read-only path is outside the workspace: ${candidate}`);
      }

      const realPath = await fs.promises.realpath(lexicalPath);
      if (!isContainedPath(realRoot, realPath)) {
        throw new Error(`Advisor read-only path resolves outside the workspace: ${candidate}`);
      }
      if (realPath.replace(PI_UNICODE_SPACES, " ") !== realPath) {
        throw new Error(
          `Advisor read-only path is not stable under Pi SDK normalization: ${candidate}`,
        );
      }
      return realPath;
    },
  };
}

export async function canonicalRepoReadPath(cwd: string, candidate: string): Promise<string> {
  return createRepoPathGuard(cwd).resolveExisting(candidate);
}

function createGuardedLsOperations(guard: RepoPathGuard): LsOperations {
  return {
    async exists(absolutePath) {
      try {
        await guard.resolveExisting(absolutePath);
        return true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async stat(absolutePath) {
      return fs.promises.stat(await guard.resolveExisting(absolutePath));
    },
    async readdir(absolutePath) {
      return fs.promises.readdir(await guard.resolveExisting(absolutePath));
    },
  };
}

/**
 * Preserve Pi's read-only tool contracts while confining every requested root to cwd.
 * Canonical paths are delegated to Pi so a checked symlink cannot redirect the operation.
 */
export function createRepoConfinedReadOnlyTools(
  cwd: string,
  onRead?: (observation: AdvisorReadObservation) => void,
): ToolDefinition[] {
  const guard = createRepoPathGuard(cwd);

  const read = createReadToolDefinition(cwd);
  const executeRead = read.execute;
  read.execute = async (toolCallId, input, signal, onUpdate, context) => {
    const resolvedPath = await guard.resolveExisting(input.path);
    const result = await executeRead(
      toolCallId,
      { ...input, path: resolvedPath },
      signal,
      onUpdate,
      context,
    );
    const offset = Math.max(1, input.offset ?? 1);
    const boundedResult = boundAdvisorToolResult(
      result,
      (outputLines) =>
        `[Advisor session limit reached. Use offset=${offset + outputLines} to continue.]`,
    );
    const truncation = boundedResult.details?.truncation;
    const returnedLines = truncation?.outputLines ?? input.limit;
    onRead?.({
      path: resolvedPath,
      offset,
      endOffset: returnedLines === undefined ? null : offset + returnedLines - 1,
      fileSize: (await fs.promises.stat(resolvedPath)).size,
      reachesEnd: input.limit === undefined && !truncation?.truncated,
    });
    return boundedResult;
  };

  const grep = createGrepToolDefinition(cwd);
  const executeGrep = grep.execute;
  grep.execute = async (toolCallId, input, signal, onUpdate, context) =>
    boundAdvisorToolResult(
      await executeGrep(
        toolCallId,
        { ...input, path: await guard.resolveExisting(input.path || ".") },
        signal,
        onUpdate,
        context,
      ),
      () => "[Advisor session limit reached. Refine the grep query to continue.]",
    );

  const find = createFindToolDefinition(cwd);
  const executeFind = find.execute;
  find.execute = async (toolCallId, input, signal, onUpdate, context) =>
    boundAdvisorToolResult(
      await executeFind(
        toolCallId,
        { ...input, path: await guard.resolveExisting(input.path || ".") },
        signal,
        onUpdate,
        context,
      ),
      () => "[Advisor session limit reached. Refine the find query to continue.]",
    );

  const ls = createLsToolDefinition(cwd, { operations: createGuardedLsOperations(guard) });
  const executeLs = ls.execute;
  ls.execute = async (toolCallId, input, signal, onUpdate, context) =>
    boundAdvisorToolResult(
      await executeLs(
        toolCallId,
        { ...input, path: await guard.resolveExisting(input.path || ".") },
        signal,
        onUpdate,
        context,
      ),
      () => "[Advisor session limit reached. Read a narrower directory to continue.]",
    );

  return [defineTool(read), defineTool(grep), defineTool(find), defineTool(ls)];
}
