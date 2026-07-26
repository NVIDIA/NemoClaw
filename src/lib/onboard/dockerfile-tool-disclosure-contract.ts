// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ToolDisclosure } from "../tool-disclosure";

const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
const O_NONBLOCK = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
const O_DIRECTORY = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;

type DockerfileOpenOperation = "open" | "patch";

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface DockerfilePatchSnapshot {
  content: string;
  file: FileIdentity & { mode: number };
  parent: FileIdentity & { path: string };
}

function errnoCode(err: unknown): string | null {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function openRealDockerfileParent(
  dockerfilePath: string,
  operation: DockerfileOpenOperation,
): { fd: number; identity: FileIdentity & { path: string } } {
  if (typeof O_NOFOLLOW !== "number") {
    throw new Error(
      `Refusing to ${operation} Dockerfile: O_NOFOLLOW is unavailable on this platform.`,
    );
  }
  const parentPath = path.dirname(path.resolve(dockerfilePath));
  let fd: number;
  try {
    // This acquires a read-only descriptor for an existing directory; it does
    // not create a temporary file. Numeric O_DIRECTORY/O_NOFOLLOW flags obscure
    // that fact from the temporary-file query.
    // lgtm[js/insecure-temporary-file]
    fd = fs.openSync(parentPath, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    let parentIsSymlink = false;
    try {
      parentIsSymlink = fs.lstatSync(parentPath).isSymbolicLink();
    } catch {
      // Preserve the original open error when the parent disappeared.
    }
    if (parentIsSymlink || errnoCode(err) === "ELOOP") {
      throw new Error(
        `Refusing to ${operation} Dockerfile through a symlinked parent: ${parentPath}`,
      );
    }
    throw err;
  }
  try {
    const directoryStat = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(parentPath);
    if (
      !directoryStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      !sameIdentity(directoryStat, pathStat)
    ) {
      throw new Error(
        `Refusing to ${operation} Dockerfile because its parent changed during validation: ${parentPath}`,
      );
    }
    return {
      fd,
      identity: { path: parentPath, dev: directoryStat.dev, ino: directoryStat.ino },
    };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function assertParentIdentity(
  parent: FileIdentity & { path: string },
  fd: number,
  operation: DockerfileOpenOperation,
): void {
  const descriptorStat = fs.fstatSync(fd);
  const pathStat = fs.lstatSync(parent.path);
  if (
    !descriptorStat.isDirectory() ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    !sameIdentity(parent, descriptorStat) ||
    !sameIdentity(parent, pathStat)
  ) {
    throw new Error(
      `Refusing to ${operation} Dockerfile because its parent changed during validation: ${parent.path}`,
    );
  }
}

function assertPatchDestination(
  dockerfilePath: string,
  expected: FileIdentity,
  operation: DockerfileOpenOperation,
): void {
  const destinationStat = fs.lstatSync(dockerfilePath);
  if (
    destinationStat.isSymbolicLink() ||
    !destinationStat.isFile() ||
    destinationStat.nlink !== 1 ||
    !sameIdentity(expected, destinationStat)
  ) {
    throw new Error(
      `Refusing to ${operation} Dockerfile because it changed during validation: ${dockerfilePath}`,
    );
  }
}

function assertPrivateTemporaryFile(temporaryPath: string, expected: FileIdentity): void {
  const stagedStat = fs.lstatSync(temporaryPath);
  if (
    stagedStat.isSymbolicLink() ||
    !stagedStat.isFile() ||
    stagedStat.nlink !== 1 ||
    !sameIdentity(expected, stagedStat)
  ) {
    throw new Error(`Refusing to patch Dockerfile because its temporary file changed.`);
  }
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
  let fd: number;
  try {
    // Open before inspecting the path so all later I/O consumes the inode that
    // was actually validated. O_NONBLOCK prevents a FIFO substitution from
    // hanging before fstat can reject the descriptor.
    fd = fs.openSync(dockerfilePath, flags | O_NOFOLLOW | O_NONBLOCK, 0o600);
  } catch (err) {
    if (errnoCode(err) === "ELOOP") {
      throw new Error(`Refusing to ${operation} Dockerfile through a symlink: ${dockerfilePath}`);
    }
    throw err;
  }
  try {
    const fileStat = fs.fstatSync(fd);
    if (!fileStat.isFile()) {
      throw new Error(`Refusing to ${operation} non-regular Dockerfile path: ${dockerfilePath}`);
    }
    if (fileStat.nlink !== 1) {
      throw new Error(`Refusing to ${operation} hard-linked Dockerfile path: ${dockerfilePath}`);
    }
    // Patch callers use a private mkdtemp build root; read-only custom paths
    // are copied into that root and validated again before patching. This
    // post-open check catches a swap around openSync without introducing a
    // check-then-open race; subsequent reads/writes use the pinned fd.
    const pathAfterOpen = fs.lstatSync(dockerfilePath);
    if (
      pathAfterOpen.isSymbolicLink() ||
      !pathAfterOpen.isFile() ||
      pathAfterOpen.nlink !== 1 ||
      fileStat.dev !== pathAfterOpen.dev ||
      fileStat.ino !== pathAfterOpen.ino
    ) {
      throw new Error(
        `Refusing to ${operation} Dockerfile because it changed during validation: ${dockerfilePath}`,
      );
    }
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

export function readDockerfilePatchSnapshot(dockerfilePath: string): DockerfilePatchSnapshot {
  const parent = openRealDockerfileParent(dockerfilePath, "patch");
  try {
    const fd = openExistingRegularDockerfileNoFollow(
      dockerfilePath,
      fs.constants.O_RDONLY,
      "patch",
    );
    try {
      const fileStat = fs.fstatSync(fd);
      const content = fs.readFileSync(fd, "utf8");
      assertParentIdentity(parent.identity, parent.fd, "patch");
      assertPatchDestination(dockerfilePath, fileStat, "patch");
      return {
        content,
        file: { dev: fileStat.dev, ino: fileStat.ino, mode: fileStat.mode },
        parent: parent.identity,
      };
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(parent.fd);
  }
}

export function replaceDockerfilePatchSnapshot(
  dockerfilePath: string,
  snapshot: DockerfilePatchSnapshot,
  content: string,
): void {
  const parent = openRealDockerfileParent(dockerfilePath, "patch");
  let temporaryPath: string | null = null;
  let temporaryFd: number | null = null;
  try {
    if (!sameIdentity(parent.identity, snapshot.parent)) {
      throw new Error(
        `Refusing to patch Dockerfile because its parent changed during validation: ${snapshot.parent.path}`,
      );
    }
    assertParentIdentity(snapshot.parent, parent.fd, "patch");
    assertPatchDestination(dockerfilePath, snapshot.file, "patch");

    temporaryPath = path.join(
      snapshot.parent.path,
      `.${path.basename(dockerfilePath)}.nemoclaw-${process.pid}-${randomUUID()}.tmp`,
    );
    temporaryFd = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    const temporaryStat = fs.fstatSync(temporaryFd);
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw new Error(`Refusing to patch Dockerfile through a non-private temporary file.`);
    }
    // Prove that the fresh descriptor was created under the pinned staging
    // directory before writing any bytes to it. This closes the parent-swap
    // window between the pathname-based create and the first write.
    assertParentIdentity(snapshot.parent, parent.fd, "patch");
    assertPrivateTemporaryFile(temporaryPath, temporaryStat);
    fs.writeFileSync(temporaryFd, content, { encoding: "utf8" });
    fs.fchmodSync(temporaryFd, snapshot.file.mode & 0o777);
    fs.fsyncSync(temporaryFd);
    fs.closeSync(temporaryFd);
    temporaryFd = null;

    // Revalidate both names immediately before the atomic replacement. If the
    // destination is swapped after this check, rename still replaces only the
    // directory entry; it never writes through the attacker's inode.
    assertParentIdentity(snapshot.parent, parent.fd, "patch");
    assertPatchDestination(dockerfilePath, snapshot.file, "patch");
    assertPrivateTemporaryFile(temporaryPath, temporaryStat);
    fs.renameSync(temporaryPath, dockerfilePath);
    temporaryPath = null;
    assertParentIdentity(snapshot.parent, parent.fd, "patch");
    assertPatchDestination(dockerfilePath, temporaryStat, "patch");
  } finally {
    if (temporaryFd !== null) fs.closeSync(temporaryFd);
    if (temporaryPath !== null) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The guarded replacement either consumed the file or failed before it existed.
      }
    }
    fs.closeSync(parent.fd);
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
