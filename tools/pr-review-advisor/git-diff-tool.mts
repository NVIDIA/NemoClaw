// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getFileDiff } from "../advisors/git.mts";

export const PR_REVIEW_GIT_DIFF_TOOL = "pr_review_git_diff";
export const PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT = 24_000;
const PR_REVIEW_DIFF_PATH_LIMIT = 4096;

type GitDiffToolController = {
  tools: ToolDefinition[];
};

type GitDiffToolOptions = {
  baseRef: string;
  headRef: string;
  changedFiles: readonly string[];
  totalDiffCharacters: number;
  readFileDiff?: (file: string) => string;
};

type GitDiffToolInput = {
  path?: string;
  cursor?: number;
};

export function createGitDiffToolController(options: GitDiffToolOptions): GitDiffToolController {
  const changedFiles = [...options.changedFiles];
  const changedFileSet = new Set(changedFiles);
  const diffCache = new Map<string, string>();
  const readFileDiff =
    options.readFileDiff ?? ((file: string) => getFileDiff(options.baseRef, options.headRef, file));

  const tool = defineTool({
    name: PR_REVIEW_GIT_DIFF_TOOL,
    label: "Read the pull request diff in bounded pages",
    description:
      "First call with no path to list every changed file. Then pass one exact changed-file path and an optional cursor to read that file's diff in bounded pages. Follow nextCursor until null only when more detail is needed.",
    parameters: Type.Object(
      {
        path: Type.Optional(Type.String({ minLength: 1, maxLength: PR_REVIEW_DIFF_PATH_LIMIT })),
        cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_id, rawInput) => {
      const input = rawInput as GitDiffToolInput;
      const cursor = input.cursor ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error("PR diff cursor must be a non-negative safe integer");
      }
      if (input.path === undefined) {
        const page = manifestPage(changedFiles, cursor);
        return toolResult({
          kind: "manifest",
          totalDiffCharacters: options.totalDiffCharacters,
          changedFileCount: changedFiles.length,
          cursor,
          changedFiles: page.files,
          nextCursor: page.nextCursor,
        });
      }
      if (!changedFileSet.has(input.path)) {
        throw new Error(
          `PR diff path is not in the deterministic changed-file list: ${input.path}`,
        );
      }
      let diff = diffCache.get(input.path);
      if (diff === undefined) {
        diff = readFileDiff(input.path);
        diffCache.set(input.path, diff);
      }
      if (cursor > diff.length) {
        throw new Error(`PR diff cursor ${cursor} is past the end of ${input.path}`);
      }
      const page = textPage(diff, cursor);
      return toolResult({
        kind: "file_diff",
        path: input.path,
        totalCharacters: diff.length,
        cursor,
        chunk: page.chunk || "<no textual diff available>",
        nextCursor: page.nextCursor,
      });
    },
  });

  return { tools: [tool] };
}

function manifestPage(
  files: readonly string[],
  cursor: number,
): {
  files: string[];
  nextCursor: number | null;
} {
  if (cursor > files.length) throw new Error(`PR diff manifest cursor ${cursor} is out of range`);
  const page: string[] = [];
  let characters = 0;
  let index = cursor;
  while (index < files.length) {
    const file = files[index]!;
    const nextCharacters = characters + file.length + 1;
    if (page.length > 0 && nextCharacters > PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT) break;
    page.push(file);
    characters = nextCharacters;
    index += 1;
  }
  return { files: page, nextCursor: index < files.length ? index : null };
}

function textPage(text: string, cursor: number): { chunk: string; nextCursor: number | null } {
  let end = Math.min(text.length, cursor + PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT);
  if (end < text.length) {
    const lineEnd = text.lastIndexOf("\n", end);
    if (lineEnd > cursor + PR_REVIEW_DIFF_PAGE_CHARACTER_LIMIT / 2) end = lineEnd + 1;
  }
  return {
    chunk: text.slice(cursor, end),
    nextCursor: end < text.length ? end : null,
  };
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: { advisorContext: true, bounded: true },
  };
}
