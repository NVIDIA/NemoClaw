// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DockerfileInstruction {
  readonly body: string;
  readonly bodyStart: number;
  readonly end: number;
  readonly keyword: string;
  readonly start: number;
  readonly text: string;
}

export interface DockerfileRunCommand {
  readonly commandStart: number;
  readonly instruction: DockerfileInstruction;
}

function lineEnd(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline + 1;
}

function continuesInstruction(line: string): boolean {
  const content = line.replace(/\r?\n$/u, "").trimEnd();
  let escapeCount = 0;
  for (let index = content.length - 1; index >= 0 && content[index] === "\\"; index -= 1) {
    escapeCount += 1;
  }
  return escapeCount % 2 === 1;
}

export function dockerfileInstructions(source: string): DockerfileInstruction[] {
  const instructions: DockerfileInstruction[] = [];
  let offset = 0;

  while (offset < source.length) {
    const endOfFirstLine = lineEnd(source, offset);
    const firstLine = source.slice(offset, endOfFirstLine);
    const instructionMatch = firstLine.match(/^[ \t]*([A-Za-z]+)(?:[ \t]+|(?=\r?$))/u);
    if (instructionMatch === null) {
      offset = endOfFirstLine;
      continue;
    }

    let end = endOfFirstLine;
    let currentLine = firstLine;
    while (continuesInstruction(currentLine)) {
      if (end >= source.length) {
        throw new Error(`Dockerfile ends inside the ${instructionMatch[1]} instruction`);
      }
      const nextEnd = lineEnd(source, end);
      currentLine = source.slice(end, nextEnd);
      end = nextEnd;
    }

    const bodyStart = offset + instructionMatch[0].length;
    instructions.push({
      body: source.slice(bodyStart, end),
      bodyStart,
      end,
      keyword: instructionMatch[1].toUpperCase(),
      start: offset,
      text: source.slice(offset, end),
    });
    offset = end;
  }

  return instructions;
}

function withoutDockerfileContinuations(source: string): string {
  return source.replace(/\\\r?\n/gu, (continuation) => " ".repeat(continuation.length));
}

function isCommandStart(source: string, start: number): boolean {
  let previous = start - 1;
  while (previous >= 0 && /\s/u.test(source[previous])) {
    previous -= 1;
  }
  if (previous < 0 || ";&|({\n".includes(source[previous])) {
    return true;
  }

  const prefix = source.slice(0, start).trimEnd();
  return /(?:^|[;&|({])\s*(?:then|do|else)$/u.test(prefix);
}

function shellCommandIndexes(source: string, command: string): number[] {
  const indexes: number[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let comment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (comment) {
      if (character === "\n") comment = false;
      continue;
    }
    if (quote !== null) {
      if (character === "\\" && quote !== "'") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|(){}]/u.test(source[index - 1]))) {
      comment = true;
      continue;
    }
    if (!source.startsWith(command, index) || !isCommandStart(source, index)) continue;

    const next = source[index + command.length];
    if (next !== undefined && !/[\s;&|(){}]/u.test(next)) continue;
    indexes.push(index);
    index += command.length - 1;
  }

  return indexes;
}

export function findDockerfileRunCommands(source: string, command: string): DockerfileRunCommand[] {
  return dockerfileInstructions(source).flatMap((instruction) => {
    if (instruction.keyword !== "RUN") return [];
    const shellSource = withoutDockerfileContinuations(instruction.body);
    return shellCommandIndexes(shellSource, command).map((commandIndex) => ({
      commandStart: instruction.bodyStart + commandIndex,
      instruction,
    }));
  });
}

export function requireSingleDockerfileRunCommand(
  source: string,
  command: string,
): DockerfileRunCommand {
  const matches = findDockerfileRunCommands(source, command);
  if (matches.length !== 1) {
    throw new Error(`Expected one executing RUN command '${command}', found ${matches.length}`);
  }
  return matches[0];
}
