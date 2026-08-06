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

export interface ReviewedDockerfileRunCommand {
  readonly commandStart: number;
  readonly instruction: DockerfileInstruction;
}

const CORPORATE_CA_PATH = "/usr/local/share/nemoclaw/corporate-ca.pem";
const CORPORATE_CA_GUARD = `if [ -f ${CORPORATE_CA_PATH} ]; then export CURL_CA_BUNDLE=${CORPORATE_CA_PATH}; fi;`;

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

function collapseDockerfileContinuations(source: string): {
  readonly originalIndexes: readonly number[];
  readonly text: string;
} {
  const characters: string[] = [];
  const originalIndexes: number[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\" && source[index + 1] === "\n") {
      index += 1;
      continue;
    }
    if (source[index] === "\\" && source[index + 1] === "\r" && source[index + 2] === "\n") {
      index += 2;
      continue;
    }
    characters.push(source[index]);
    originalIndexes.push(index);
  }

  return { originalIndexes, text: characters.join("") };
}

function unquotedTextIndexes(source: string, text: string): number[] {
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
    if (!source.startsWith(text, index)) continue;
    indexes.push(index);
    index += text.length - 1;
  }

  return indexes;
}

function normalizedInstructionBody(source: string): string {
  return source
    .replace(/\\\r?\n/gu, " ")
    .replace(/[ \t\r\n]+/gu, " ")
    .replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
}

export function requireSingleReviewedDockerfileRunCommand(
  source: string,
  command: string,
  requiredArguments: readonly string[],
): ReviewedDockerfileRunCommand {
  const invocation = [command, ...requiredArguments].join(" ");
  const reviewedBodies = new Set([invocation, `${CORPORATE_CA_GUARD} ${invocation}`]);
  const matches: ReviewedDockerfileRunCommand[] = [];
  let unreviewedInstructions = 0;

  for (const instruction of dockerfileInstructions(source)) {
    if (instruction.keyword !== "RUN") continue;
    const collapsed = collapseDockerfileContinuations(instruction.body);
    const containsCommand = collapsed.text.includes(command);
    const hasUnsupportedShellConstruct = ["$(", "${", "`"].some((token) =>
      collapsed.text.includes(token),
    );
    if (containsCommand && hasUnsupportedShellConstruct) {
      unreviewedInstructions += 1;
      continue;
    }
    const commandIndexes = unquotedTextIndexes(collapsed.text, command);
    if (commandIndexes.length === 0) continue;
    if (
      commandIndexes.length !== 1 ||
      !reviewedBodies.has(normalizedInstructionBody(instruction.body))
    ) {
      unreviewedInstructions += 1;
      continue;
    }
    matches.push({
      commandStart: instruction.bodyStart + collapsed.originalIndexes[commandIndexes[0]],
      instruction,
    });
  }

  if (unreviewedInstructions > 0) {
    throw new Error(
      `Expected '${invocation}' only as a direct RUN or the reviewed corporate CA guarded RUN; found ${unreviewedInstructions} unreviewed RUN instruction(s)`,
    );
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one reviewed RUN command '${invocation}', found ${matches.length}`);
  }
  return matches[0];
}
