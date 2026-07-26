// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const MODULE_TAG_BODY_PATTERN = /^@module-tag[\t ]+([A-Za-z0-9/_-]+)$/u;

export type ModuleTagDeclaration = {
  tag: string;
  start: number;
  end: number;
};

type CommentToken = {
  start: number;
  end: number;
  text: string;
};

function standaloneModuleTag(comment: string): string | undefined {
  const body = comment.startsWith("//")
    ? comment.slice(2).trim()
    : comment
        .slice(2, -2)
        .split(/\r?\n/u)
        .map((line) => line.replace(/^[\t ]*\**[\t ]?/u, "").trim())
        .filter(Boolean)
        .join("\n");
  return MODULE_TAG_BODY_PATTERN.exec(body)?.[1];
}

function declarationLineRange(
  source: string,
  tokenStart: number,
  tokenEnd: number,
): Pick<ModuleTagDeclaration, "start" | "end"> | undefined {
  const lineStart = source.lastIndexOf("\n", tokenStart - 1) + 1;
  const nextNewline = source.indexOf("\n", tokenEnd);
  const lineEnd = nextNewline < 0 ? source.length : nextNewline;
  if (
    !/^[\t ]*$/u.test(source.slice(lineStart, tokenStart)) ||
    !/^[\t \r]*$/u.test(source.slice(tokenEnd, lineEnd))
  ) {
    return undefined;
  }
  return { start: lineStart, end: nextNewline < 0 ? source.length : nextNewline + 1 };
}

function commentTokens(source: string): CommentToken[] {
  const comments: CommentToken[] = [];
  let index = 0;
  let quote: "'" | '"' | "`" | undefined;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      const start = index;
      const newline = source.indexOf("\n", index + 2);
      const end = newline < 0 ? source.length : newline;
      comments.push({ start, end, text: source.slice(start, end) });
      index = end;
      continue;
    }
    if (current === "/" && next === "*") {
      const start = index;
      const closing = source.indexOf("*/", index + 2);
      const end = closing < 0 ? source.length : closing + 2;
      comments.push({ start, end, text: source.slice(start, end) });
      index = end;
      continue;
    }
    index += 1;
  }
  return comments;
}

export function moduleTagDeclarations(source: string): ModuleTagDeclaration[] {
  return commentTokens(source).flatMap((comment) => {
    const tag = standaloneModuleTag(comment.text);
    const range = declarationLineRange(source, comment.start, comment.end);
    return tag && range ? [{ tag, ...range }] : [];
  });
}

export function stripModuleTagDeclarations(
  source: string,
  declarations: readonly ModuleTagDeclaration[],
): string {
  let cursor = 0;
  let stripped = "";
  for (const declaration of declarations) {
    stripped += source.slice(cursor, declaration.start);
    cursor = declaration.end;
  }
  return stripped + source.slice(cursor);
}
