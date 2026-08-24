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
const CORPORATE_CA_CURL_GUARD = `if [ -f ${CORPORATE_CA_PATH} ]; then export CURL_CA_BUNDLE=${CORPORATE_CA_PATH}; fi;`;
const CORPORATE_CA_NODE_CURL_GUARD = `if [ -f ${CORPORATE_CA_PATH} ]; then export CURL_CA_BUNDLE=${CORPORATE_CA_PATH}; export NODE_EXTRA_CA_CERTS=${CORPORATE_CA_PATH}; fi;`;

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
    let continues = continuesInstruction(firstLine);
    while (continues) {
      if (end >= source.length) {
        throw new Error(`Dockerfile ends inside the ${instructionMatch[1]} instruction`);
      }
      const nextEnd = lineEnd(source, end);
      const currentLine = source.slice(end, nextEnd);
      end = nextEnd;
      continues = /^[ \t]*#/u.test(currentLine) || continuesInstruction(currentLine);
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

function shellCommandPrefixWords(source: string, end: number): string[] {
  const words: string[] = [];
  let wordStart: number | undefined;
  let quote: "'" | '"' | "`" | null = null;
  let comment = false;

  const finishWord = (wordEnd: number): void => {
    if (wordStart === undefined) return;
    words.push(source.slice(wordStart, wordEnd));
    wordStart = undefined;
  };

  for (let index = 0; index < end; index += 1) {
    const character = source[index]!;
    if (comment) {
      if (character === "\n") {
        comment = false;
        words.length = 0;
      }
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
      wordStart ??= index;
      quote = character;
      continue;
    }
    if (character === "\\") {
      wordStart ??= index;
      index += 1;
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|(){}]/u.test(source[index - 1]!))) {
      finishWord(index);
      comment = true;
      continue;
    }
    if (/[ \t\r]/u.test(character)) {
      finishWord(index);
      continue;
    }
    if (character === "\n" || ";&|({)".includes(character)) {
      finishWord(index);
      words.length = 0;
      continue;
    }
    wordStart ??= index;
  }

  finishWord(end);
  return words;
}

function followsShellCommandSeparator(source: string, index: number): boolean {
  return shellCommandPrefixWords(source, index).every(
    (word) =>
      ["!", "do", "elif", "else", "if", "then", "until", "while"].includes(word) ||
      /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(word),
  );
}

function startsShellWord(source: string, index: number): boolean {
  const previousCharacter = source[index - 1];
  return previousCharacter === undefined || /[\t\r\n &|();<>]/u.test(previousCharacter);
}

export function dockerfileRunCommandPositions(source: string, command: string): number[] {
  const positions: number[] = [];
  for (const instruction of dockerfileInstructions(source)) {
    if (instruction.keyword !== "RUN") continue;
    const collapsed = collapseDockerfileContinuations(instruction.body);
    for (const index of unquotedTextIndexes(collapsed.text, command)) {
      const afterCommand = collapsed.text[index + command.length];
      if (
        startsShellWord(collapsed.text, index) &&
        followsShellCommandSeparator(collapsed.text, index) &&
        (afterCommand === undefined || /[ \t\r\n;&|(){}<>]/u.test(afterCommand))
      ) {
        positions.push(instruction.bodyStart + collapsed.originalIndexes[index]!);
      }
    }
  }
  return positions;
}

function normalizedInstructionBody(source: string): string {
  return source
    .replace(/\\\r?\n/gu, " ")
    .replace(/[ \t\r\n]+/gu, " ")
    .replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
}

export function requireReviewedDockerfileRunCommands(
  source: string,
  command: string,
  requiredArguments: readonly string[],
  expectedCount: number,
): readonly ReviewedDockerfileRunCommand[] {
  const invocation = [command, ...requiredArguments].join(" ");
  const reviewedBodies = new Set([
    invocation,
    `${CORPORATE_CA_CURL_GUARD} ${invocation}`,
    `${CORPORATE_CA_NODE_CURL_GUARD} ${invocation}`,
  ]);
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
  if (matches.length !== expectedCount) {
    const expected = expectedCount === 1 ? "one" : String(expectedCount);
    throw new Error(
      `Expected ${expected} reviewed RUN command '${invocation}', found ${matches.length}`,
    );
  }
  return matches;
}

export function requireSingleReviewedDockerfileRunCommand(
  source: string,
  command: string,
  requiredArguments: readonly string[],
): ReviewedDockerfileRunCommand {
  return requireReviewedDockerfileRunCommands(source, command, requiredArguments, 1)[0]!;
}
