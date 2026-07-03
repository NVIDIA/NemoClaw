// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Token = {
  kind: "newline" | "operator" | "word";
  value: string;
};

export type InstallerPin = {
  asset: string;
  sha256: string;
  source: string;
};

type ExtractOptions = {
  functionName: string;
  releaseVersion: string;
  sourceLabel: string;
};

type CliOptions = {
  brevInstaller: string;
  format: "json" | "tsv";
  installer: string;
  releaseVersion: string;
};

const FUNCTION_LOCAL_PATTERN = /^local release_tag\s*=\s*\$1 asset\s*=\s*\$2$/u;
const LITERAL_PIN_PATTERN = /^v([0-9]+\.[0-9]+\.[0-9]+):([A-Za-z0-9._+-]+)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FUNCTION_SELECTOR_VALUES = new Set(["${release_tag}:${asset}", "$release_tag:$asset"]);
const MAX_INSTALLER_INPUT_BYTES = 1024 * 1024;

function fail(message: string): never {
  throw new Error(`Installer pin extraction failed: ${message}`);
}

// Pull-request CI executes this parser from a trusted checkout while these
// paths point into the mutable PR tree. Reject links and special files before
// reading, verify that the opened file is still the one inspected, and cap the
// bytes consumed so PR-authored input cannot redirect or exhaust the verifier.
// Regression coverage lives in test/installer-hash-check.test.ts.
function readInstallerInput(inputPath: string, sourceLabel: string): string {
  let parentStats: fs.Stats;
  try {
    parentStats = fs.lstatSync(path.dirname(inputPath));
  } catch {
    fail(`${sourceLabel} input parent directory is unavailable`);
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    fail(`${sourceLabel} input parent must be a real directory and not a symbolic link`);
  }

  let pathStats: fs.Stats;
  try {
    pathStats = fs.lstatSync(inputPath);
  } catch {
    fail(`${sourceLabel} input is unavailable`);
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    fail(`${sourceLabel} input must be a regular file and not a symbolic link`);
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      inputPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
  } catch {
    fail(`${sourceLabel} input must be a regular file and not a symbolic link`);
  }

  try {
    const openedStats = fs.fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      fail(`${sourceLabel} input changed during validation or is not a regular file`);
    }
    if (openedStats.size > MAX_INSTALLER_INPUT_BYTES) {
      fail(`${sourceLabel} input exceeds the ${MAX_INSTALLER_INPUT_BYTES}-byte limit`);
    }

    const buffer = Buffer.allocUnsafe(MAX_INSTALLER_INPUT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunkSize = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (chunkSize === 0) {
        break;
      }
      bytesRead += chunkSize;
    }
    if (bytesRead > MAX_INSTALLER_INPUT_BYTES) {
      fail(`${sourceLabel} input exceeds the ${MAX_INSTALLER_INPUT_BYTES}-byte limit`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function isOperatorStart(character: string): boolean {
  return "(){};".includes(character);
}

function tokenizeShellSubset(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (character === "\\" && (next === "\n" || (next === "\r" && source[index + 2] === "\n"))) {
      index += next === "\n" ? 2 : 3;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\n") {
      tokens.push({ kind: "newline", value: "\n" });
      index += 1;
      continue;
    }
    if (character === "#") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === ";" && next === ";") {
      tokens.push({ kind: "operator", value: ";;" });
      index += 2;
      continue;
    }
    if (isOperatorStart(character)) {
      tokens.push({ kind: "operator", value: character });
      index += 1;
      continue;
    }

    let value = "";
    while (index < source.length) {
      const wordCharacter = source[index] ?? "";
      const wordNext = source[index + 1] ?? "";
      if (
        wordCharacter === " " ||
        wordCharacter === "\t" ||
        wordCharacter === "\r" ||
        wordCharacter === "\n" ||
        isOperatorStart(wordCharacter)
      ) {
        break;
      }
      if (wordCharacter === "\\") {
        if (wordNext === "\n" || (wordNext === "\r" && source[index + 2] === "\n")) {
          index += wordNext === "\n" ? 2 : 3;
          continue;
        }
        if (!wordNext) {
          fail("source ends with an incomplete escape");
        }
        value += wordNext;
        index += 2;
        continue;
      }
      if (wordCharacter === "'") {
        const closingQuote = source.indexOf("'", index + 1);
        if (closingQuote === -1) {
          fail("source contains an unterminated single-quoted word");
        }
        value += source.slice(index + 1, closingQuote);
        index = closingQuote + 1;
        continue;
      }
      if (wordCharacter === '"') {
        index += 1;
        let closed = false;
        while (index < source.length) {
          const quotedCharacter = source[index] ?? "";
          const quotedNext = source[index + 1] ?? "";
          if (quotedCharacter === '"') {
            index += 1;
            closed = true;
            break;
          }
          if (quotedCharacter === "\\") {
            if (quotedNext === "\n" || (quotedNext === "\r" && source[index + 2] === "\n")) {
              index += quotedNext === "\n" ? 2 : 3;
              continue;
            }
            if ('$`"\\'.includes(quotedNext)) {
              value += quotedNext;
              index += 2;
              continue;
            }
          }
          value += quotedCharacter;
          index += 1;
        }
        if (!closed) {
          fail("source contains an unterminated double-quoted word");
        }
        continue;
      }
      value += wordCharacter;
      index += 1;
    }
    if (!value) {
      fail(`unsupported shell token near ${JSON.stringify(source.slice(index, index + 16))}`);
    }
    tokens.push({ kind: "word", value });
  }

  return tokens;
}

function isToken(token: Token | undefined, kind: Token["kind"], value?: string): boolean {
  return token?.kind === kind && (value === undefined || token.value === value);
}

function functionBodyRanges(tokens: Token[], functionName: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    const nameIndex = isToken(tokens[index], "word", "function") ? index + 1 : index;
    if (!isToken(tokens[nameIndex], "word", functionName)) {
      continue;
    }
    let cursor = nameIndex + 1;
    if (isToken(tokens[cursor], "operator", "(")) {
      if (!isToken(tokens[cursor + 1], "operator", ")")) {
        continue;
      }
      cursor += 2;
    }
    if (!isToken(tokens[cursor], "operator", "{")) {
      continue;
    }

    let depth = 1;
    for (let bodyCursor = cursor + 1; bodyCursor < tokens.length; bodyCursor += 1) {
      if (isToken(tokens[bodyCursor], "operator", "{")) {
        depth += 1;
      } else if (isToken(tokens[bodyCursor], "operator", "}")) {
        depth -= 1;
        if (depth === 0) {
          ranges.push([cursor + 1, bodyCursor]);
          index = bodyCursor;
          break;
        }
      }
    }
    if (depth !== 0) {
      fail(`${functionName} has an unterminated function body`);
    }
  }
  return ranges;
}

function skipSeparators(tokens: Token[], start: number): number {
  let cursor = start;
  while (isToken(tokens[cursor], "newline") || isToken(tokens[cursor], "operator", ";")) {
    cursor += 1;
  }
  return cursor;
}

function commandBeforeSeparator(
  tokens: Token[],
  start: number,
): { command: Token[]; next: number } {
  let cursor = start;
  while (
    cursor < tokens.length &&
    !isToken(tokens[cursor], "newline") &&
    !isToken(tokens[cursor], "operator", ";")
  ) {
    cursor += 1;
  }
  return { command: tokens.slice(start, cursor), next: skipSeparators(tokens, cursor) };
}

function staticPinFromArm(pattern: string, commandTokens: Token[]): InstallerPin | undefined {
  const match = LITERAL_PIN_PATTERN.exec(pattern);
  if (!match) {
    if (pattern !== "*") {
      fail(`unsupported case pattern ${JSON.stringify(pattern)}`);
    }
    const wildcardCommand = commandTokens
      .filter((token) => token.kind !== "newline" && token.value !== ";")
      .map((token) => token.value);
    if (wildcardCommand.join(" ") !== "return 1") {
      fail("the fallback case arm must contain only 'return 1'");
    }
    return undefined;
  }

  const command = commandTokens
    .filter((token) => token.kind !== "newline" && token.value !== ";")
    .map((token) => token.value);
  if (command.length !== 3 || command[0] !== "printf" || command[1] !== "%s\\n") {
    fail(`case arm ${pattern} must contain exactly one static printf '%s\\n' SHA-256 command`);
  }
  const sha256 = command[2] ?? "";
  if (!SHA256_PATTERN.test(sha256)) {
    fail(`case arm ${pattern} does not contain one literal lowercase SHA-256 digest`);
  }
  return { asset: match[2] ?? "", sha256, source: "" };
}

// invalidState: trusted CI accepts a pin table whose shell formatting hides,
// duplicates, or changes a consumed release-asset digest.
// sourceBoundary: this trusted parser owns the accepted static shell subset;
// pull-request installer files provide data only and are never sourced or run.
// whyNotSourceFix: the bootstrap installers need self-contained shell lookup
// functions before package dependencies are available, so JSON is not their
// runtime source of truth.
// regressionTest: test/installer-hash-check.test.ts covers whitespace, comments,
// continuations, quote styles, mixed indentation, missing pins, and ambiguity.
// removalCondition: remove shell parsing when both installers and this verifier
// consume one canonical machine-readable pin manifest directly.
export function extractInstallerPins(source: string, options: ExtractOptions): InstallerPin[] {
  const tokens = tokenizeShellSubset(source);
  const ranges = functionBodyRanges(tokens, options.functionName);
  if (ranges.length !== 1) {
    fail(`expected exactly one ${options.functionName} definition, found ${ranges.length}`);
  }
  const [bodyStart, bodyEnd] = ranges[0] ?? fail(`missing ${options.functionName} body`);
  const body = tokens.slice(bodyStart, bodyEnd);
  let cursor = skipSeparators(body, 0);

  const local = commandBeforeSeparator(body, cursor);
  if (!FUNCTION_LOCAL_PATTERN.test(local.command.map((token) => token.value).join(" "))) {
    fail(`${options.functionName} must start with local release_tag and asset inputs`);
  }
  cursor = local.next;
  if (!isToken(body[cursor], "word", "case")) {
    fail(`${options.functionName} must contain one static case table`);
  }
  const selector = body[cursor + 1];
  if (!isToken(selector, "word") || !FUNCTION_SELECTOR_VALUES.has(selector.value)) {
    fail(`${options.functionName} must select on release_tag and asset`);
  }
  if (!isToken(body[cursor + 2], "word", "in")) {
    fail(`${options.functionName} case table is missing 'in'`);
  }
  cursor = skipSeparators(body, cursor + 3);

  const pins: InstallerPin[] = [];
  let fallbackCount = 0;
  while (!isToken(body[cursor], "word", "esac")) {
    const pattern = body[cursor];
    if (!isToken(pattern, "word") || !isToken(body[cursor + 1], "operator", ")")) {
      fail(`${options.functionName} contains an invalid case arm`);
    }
    cursor += 2;
    const commandStart = cursor;
    while (cursor < body.length && !isToken(body[cursor], "operator", ";;")) {
      cursor += 1;
    }
    if (cursor >= body.length) {
      fail(`${options.functionName} case arm ${pattern.value} is missing ';;'`);
    }
    const pin = staticPinFromArm(pattern.value, body.slice(commandStart, cursor));
    if (pattern.value === "*") {
      fallbackCount += 1;
    } else if (pin && pattern.value.startsWith(`v${options.releaseVersion}:`)) {
      pins.push({ ...pin, source: options.sourceLabel });
    }
    cursor = skipSeparators(body, cursor + 1);
  }
  cursor = skipSeparators(body, cursor + 1);
  if (cursor !== body.length) {
    fail(`${options.functionName} contains commands after its case table`);
  }
  if (fallbackCount !== 1) {
    fail(`${options.functionName} must contain exactly one fail-closed fallback arm`);
  }

  const duplicateAssets = pins
    .map((pin) => pin.asset)
    .filter((asset, index, assets) => assets.indexOf(asset) !== index);
  if (duplicateAssets.length > 0) {
    fail(
      `${options.functionName} contains duplicate assets: ${[...new Set(duplicateAssets)].join(", ")}`,
    );
  }
  if (pins.length === 0) {
    fail(`${options.functionName} contains no v${options.releaseVersion} pins`);
  }
  return pins;
}

function parseCliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!option.startsWith("--") || !value) {
      fail(
        "usage: extract-installer-pins.mts --release-version VERSION --installer PATH --brev-installer PATH [--format json|tsv]",
      );
    }
    if (values.has(option)) {
      fail(`duplicate CLI option ${option}`);
    }
    values.set(option, value);
  }
  const releaseVersion = values.get("--release-version") ?? "";
  const installer = values.get("--installer") ?? "";
  const brevInstaller = values.get("--brev-installer") ?? "";
  const format = values.get("--format") ?? "json";
  const allowedOptions = new Set([
    "--brev-installer",
    "--format",
    "--installer",
    "--release-version",
  ]);
  const unknownOptions = [...values.keys()].filter((option) => !allowedOptions.has(option));
  if (
    unknownOptions.length > 0 ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(releaseVersion) ||
    !installer ||
    !brevInstaller ||
    (format !== "json" && format !== "tsv")
  ) {
    fail(`invalid CLI options${unknownOptions.length > 0 ? `: ${unknownOptions.join(", ")}` : ""}`);
  }
  return { brevInstaller, format, installer, releaseVersion };
}

function runCli(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const pins = [
    ...extractInstallerPins(readInstallerInput(options.installer, "installer"), {
      functionName: "openshell_pinned_sha256",
      releaseVersion: options.releaseVersion,
      sourceLabel: "installer",
    }),
    ...extractInstallerPins(readInstallerInput(options.brevInstaller, "Brev launchable"), {
      functionName: "openshell_cli_pinned_sha256",
      releaseVersion: options.releaseVersion,
      sourceLabel: "Brev launchable",
    }),
  ];
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(pins)}\n`);
    return;
  }
  process.stdout.write(pins.map((pin) => `${pin.source}\t${pin.asset}\t${pin.sha256}`).join("\n"));
  process.stdout.write("\n");
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  fs.realpathSync(path.resolve(invokedPath)) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
