// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { ToolDisclosure } from "../tool-disclosure";

const O_NOFOLLOW = fs.constants.O_NOFOLLOW;

type DockerfileOpenOperation = "open" | "patch";

function errnoCode(err: unknown): string | null {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

export function openExistingRegularDockerfileNoFollow(
  dockerfilePath: string,
  flags: number,
  operation: DockerfileOpenOperation = "open",
): number {
  if (typeof O_NOFOLLOW !== "number") {
    throw new Error(
      `Refusing to ${operation} Dockerfile: O_NOFOLLOW is unavailable on this platform.`,
    );
  }
  // Bind the opened fd to the leaf identity sampled immediately before open.
  // This catches a mutable ancestor or leaf being retargeted around openSync;
  // O_NOFOLLOW independently rejects a symlink leaf.
  const expectedFile = fs.lstatSync(dockerfilePath);
  if (expectedFile.isSymbolicLink()) {
    throw new Error(`Refusing to ${operation} Dockerfile through a symlink: ${dockerfilePath}`);
  }
  if (!expectedFile.isFile()) {
    throw new Error(`Refusing to ${operation} non-regular Dockerfile path: ${dockerfilePath}`);
  }
  let fd: number;
  try {
    fd = fs.openSync(dockerfilePath, flags | O_NOFOLLOW, 0o600);
  } catch (err) {
    if (errnoCode(err) === "ELOOP") {
      throw new Error(`Refusing to ${operation} Dockerfile through a symlink: ${dockerfilePath}`);
    }
    throw err;
  }
  try {
    const fileStat = fs.fstatSync(fd);
    if (
      !fileStat.isFile() ||
      fileStat.dev !== expectedFile.dev ||
      fileStat.ino !== expectedFile.ino
    ) {
      if (fileStat.isFile()) {
        throw new Error(
          `Refusing to ${operation} Dockerfile because it changed during validation: ${dockerfilePath}`,
        );
      }
      throw new Error(`Refusing to ${operation} non-regular Dockerfile path: ${dockerfilePath}`);
    }
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

export function readExistingDockerfileNoFollow(
  dockerfilePath: string,
  operation: DockerfileOpenOperation = "open",
): string {
  const fd = openExistingRegularDockerfileNoFollow(
    dockerfilePath,
    fs.constants.O_RDONLY,
    operation,
  );
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export interface DockerfileInstruction {
  text: string;
  start: number;
  end: number;
}

interface DockerfileHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

function decodeDockerfileHeredocWord(raw: string): string | null {
  let decoded = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < raw.length) {
        index += 1;
        decoded += raw[index]!;
      } else decoded += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "\\" && index + 1 < raw.length) {
      index += 1;
      decoded += raw[index]!;
    } else {
      decoded += char;
    }
  }
  return quote === null && decoded ? decoded : null;
}

function dockerfileHeredocs(instruction: string): DockerfileHeredoc[] {
  if (!/^(?:RUN|COPY)\s/i.test(instruction)) return [];
  const heredocs: DockerfileHeredoc[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < instruction.length; index += 1) {
    const char = instruction[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (
      char !== "<" ||
      instruction[index - 1] === "<" ||
      instruction[index + 1] !== "<" ||
      instruction[index + 2] === "<"
    ) {
      continue;
    }

    let wordStart = index + 2;
    const stripTabs = instruction[wordStart] === "-";
    if (stripTabs) wordStart += 1;
    let wordEnd = wordStart;
    let wordQuote: "'" | '"' | null = null;
    for (; wordEnd < instruction.length; wordEnd += 1) {
      const wordChar = instruction[wordEnd]!;
      if (wordQuote) {
        if (wordChar === wordQuote) wordQuote = null;
        else if (wordChar === "\\" && wordQuote === '"') wordEnd += 1;
        continue;
      }
      if (wordChar === "'" || wordChar === '"') {
        wordQuote = wordChar;
        continue;
      }
      if (wordChar === "\\") {
        wordEnd += 1;
        continue;
      }
      if (/\s|[;&|()<>]/.test(wordChar)) break;
    }
    const rawWord = instruction.slice(wordStart, wordEnd);
    const delimiter = wordQuote === null ? decodeDockerfileHeredocWord(rawWord) : null;
    if (!delimiter) {
      throw new Error("Custom Dockerfile contains an invalid heredoc delimiter.");
    }
    heredocs.push({ delimiter, stripTabs });
    index = wordEnd - 1;
  }
  return heredocs;
}

interface DockerfileWord {
  decoded: string;
  raw: string;
}

function tokenizeDockerfileWords(input: string): DockerfileWord[] | null {
  const words: DockerfileWord[] = [];
  let decoded = "";
  let wordStart = -1;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < input.length) {
        index += 1;
        decoded += input[index]!;
      } else decoded += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      if (wordStart < 0) wordStart = index;
    } else if (char === "\\" && index + 1 < input.length) {
      if (wordStart < 0) wordStart = index;
      index += 1;
      decoded += input[index]!;
    } else if (/\s/.test(char)) {
      if (wordStart >= 0) {
        words.push({ decoded, raw: input.slice(wordStart, index) });
        decoded = "";
        wordStart = -1;
      }
    } else {
      if (wordStart < 0) wordStart = index;
      decoded += char;
    }
  }
  if (quote) return null;
  if (wordStart >= 0) words.push({ decoded, raw: input.slice(wordStart) });
  return words;
}

function dockerfileEnvValue(instruction: string, key: string): DockerfileWord | undefined {
  const envMatch = /^ENV\s+(.+)$/i.exec(instruction);
  if (!envMatch) return undefined;
  const words = tokenizeDockerfileWords(envMatch[1]!);
  if (!words || words.length === 0) return undefined;

  if (!words[0]!.raw.includes("=")) {
    if (words[0]!.decoded !== key) return undefined;
    return {
      decoded: words
        .slice(1)
        .map((word) => word.decoded)
        .join(" "),
      raw: words
        .slice(1)
        .map((word) => word.raw)
        .join(" "),
    };
  }

  let value: DockerfileWord | undefined;
  for (const word of words) {
    const rawEquals = word.raw.indexOf("=");
    const decodedEquals = word.decoded.indexOf("=");
    if (rawEquals > 0 && decodedEquals > 0 && word.raw.slice(0, rawEquals) === key) {
      value = {
        decoded: word.decoded.slice(decodedEquals + 1),
        raw: word.raw.slice(rawEquals + 1),
      };
    }
  }
  return value;
}

export function dockerfileInstructions(dockerfile: string): DockerfileInstruction[] {
  const instructions: DockerfileInstruction[] = [];
  const pendingHeredocs: DockerfileHeredoc[] = [];
  let current = "";
  let currentStart = -1;

  for (const match of dockerfile.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const lineStart = match.index;
    const lineWithEnding = match[0];
    const lineWithoutLf = lineWithEnding.endsWith("\n")
      ? lineWithEnding.slice(0, -1)
      : lineWithEnding;
    const rawLine = lineWithoutLf.endsWith("\r") ? lineWithoutLf.slice(0, -1) : lineWithoutLf;
    const pendingHeredoc = pendingHeredocs[0];
    if (pendingHeredoc) {
      const candidate = pendingHeredoc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
      if (candidate === pendingHeredoc.delimiter) pendingHeredocs.shift();
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!current) currentStart = lineStart;
    const continued = trimmed.endsWith("\\");
    const part = continued ? trimmed.slice(0, -1).trimEnd() : trimmed;
    current = current ? `${current} ${part}` : part;
    if (!continued) {
      instructions.push({
        text: current,
        start: currentStart,
        end: lineStart + rawLine.length,
      });
      pendingHeredocs.push(...dockerfileHeredocs(current));
      current = "";
      currentStart = -1;
    }
  }
  if (current) {
    instructions.push({ text: current, start: currentStart, end: dockerfile.length });
    pendingHeredocs.push(...dockerfileHeredocs(current));
  }
  if (pendingHeredocs.length > 0) {
    throw new Error(
      `Custom Dockerfile contains an unterminated heredoc '${pendingHeredocs[0]!.delimiter}'.`,
    );
  }
  return instructions;
}

export function validateToolDisclosureDockerfileContract(
  dockerfile: string,
  toolDisclosure: ToolDisclosure,
): DockerfileInstruction {
  const instructions = dockerfileInstructions(dockerfile);
  const finalFromIndex = instructions.reduce(
    (last, instruction, index) => (/^FROM(?:\s|$)/i.test(instruction.text) ? index : last),
    -1,
  );
  const finalStage = instructions.slice(finalFromIndex + 1);
  const declarations = finalStage.filter((instruction) =>
    /^ARG\s+NEMOCLAW_TOOL_DISCLOSURE\s*=/.test(instruction.text),
  );
  if (declarations.length !== 1) {
    const hasEarlierDeclaration = instructions
      .slice(0, finalFromIndex + 1)
      .some((instruction) => /^ARG\s+NEMOCLAW_TOOL_DISCLOSURE\s*=/.test(instruction.text));
    const detail =
      declarations.length === 0
        ? hasEarlierDeclaration
          ? "declares ARG NEMOCLAW_TOOL_DISCLOSURE outside the final stage but does not declare it in the final stage"
          : "does not declare ARG NEMOCLAW_TOOL_DISCLOSURE"
        : "declares ARG NEMOCLAW_TOOL_DISCLOSURE more than once in the final stage";
    throw new Error(
      `Custom Dockerfile ${detail}; exactly one final-stage declaration is required to apply tool disclosure '${toolDisclosure}'.`,
    );
  }

  const finalEnvAssignments = finalStage
    .map((instruction, index) => ({
      index,
      value: dockerfileEnvValue(instruction.text, "NEMOCLAW_TOOL_DISCLOSURE"),
    }))
    .filter((assignment) => assignment.value !== undefined);
  const lastEnvAssignment = finalEnvAssignments.at(-1);
  const declarationIndex = finalStage.indexOf(declarations[0]!);
  const expandableRuntimeValues = new Set([
    "${NEMOCLAW_TOOL_DISCLOSURE}",
    "$NEMOCLAW_TOOL_DISCLOSURE",
    '"${NEMOCLAW_TOOL_DISCLOSURE}"',
    '"$NEMOCLAW_TOOL_DISCLOSURE"',
  ]);
  const promotesToFinalRuntime = Boolean(
    lastEnvAssignment &&
      lastEnvAssignment.index > declarationIndex &&
      expandableRuntimeValues.has(lastEnvAssignment.value!.raw),
  );
  if (!promotesToFinalRuntime) {
    throw new Error(
      `Custom Dockerfile must promote ARG NEMOCLAW_TOOL_DISCLOSURE into the final-stage ENV after its declaration, with no later override; cannot apply tool disclosure '${toolDisclosure}'.`,
    );
  }
  return declarations[0]!;
}

export function assertToolDisclosureDockerfileContract(
  dockerfilePath: string,
  toolDisclosure: ToolDisclosure,
): void {
  let dockerfile: string;
  try {
    dockerfile = readExistingDockerfileNoFollow(dockerfilePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new Error(`Custom Dockerfile not found: ${dockerfilePath}`);
    }
    if (error instanceof Error && error.message.includes("non-regular Dockerfile")) {
      throw new Error(`Custom Dockerfile path is not a file: ${dockerfilePath}`);
    }
    throw error;
  }
  validateToolDisclosureDockerfileContract(dockerfile, toolDisclosure);
}
